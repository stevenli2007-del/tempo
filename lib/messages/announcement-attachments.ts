import { canvasGet } from '@/lib/canvas/client'
import {
  announcementPath,
  toAnnouncementAttachments,
  type CanvasAnnouncementAttachment,
} from '@/lib/canvas/announcements'
import {
  checkFetchable,
  downloadFile,
  MAX_DOWNLOAD_BYTES,
} from '@/lib/course-files/fetch-content'
import { extractSyllabusText } from '@/lib/extract'
import { parseCourseUpdate } from '@/lib/course-update/parse'
import { validateExamInput } from '@/lib/course-update/normalize'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import type { ParsedExam } from '@/lib/course-update/normalize'
import type { ExtractableExtension } from '@/lib/course-files/extractable'
import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * 公告**附件**的按需读取（P0-5-5 ①）—— 老师把考试地点放在 PDF 附件里，正文里没有。
 *
 * ### 🔴 三条红线（ADR-026）
 * 1. **只服务按需路径**：只在用户打开消息栏、且这条公告**真的缺地点**时才读。
 *    同步路径一个字节都不下（那是 ADR-026 第 1 条，不因本卡松动）。
 * 2. **原文不落库 / 不落盘 / 不进日志**：PDF 字节与抽出的全文只在本次请求的内存里，
 *    解析出的**考试地点**才是唯一离开本模块的东西。
 * 3. **附件清单也不落库**：`attachment.url` 是能力凭据（不带 token 也能取到文件），
 *    存进 `course_announcements` 等于在库里放一堆永久钥匙。所以每次都**现场回查**
 *    单条公告端点（多一个请求，换掉一个隐患 —— 与 ADR-026 第 6 条同一个权衡）。
 *
 * ### 失败二分法（沿用 ADR-026 第 5 条）
 * - **确定性失败**（没有 PDF / 抽不出字 / 没有 Canvas 连接）→ 调用方落 `failed`，不再重试；
 * - **暂时性失败**（网络 / Canvas 5xx / 模型不可用）→ 什么都不写，下次打开消息栏自然重试。
 * 两者在界面上长得一样（都是"没提示地点"），差别只在"会不会再花一次钱"。
 */

/** 一份能读出文字的附件。 */
export type ReadableAttachment = {
  attachment: CanvasAnnouncementAttachment
  ext: ExtractableExtension
}

/**
 * 从附件清单里挑出「Tempo 读得出文字」的那些（纯函数，回归可直接断言）。
 *
 * 判据复用 `checkFetchable`（与一键总结 / syllabus 导入**同一份**）——
 * 各写一份就会出现"总结读得了的 PDF、公告说不支持"这种自相矛盾。
 */
export function pickReadableAttachments(
  list: CanvasAnnouncementAttachment[],
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): ReadableAttachment[] {
  const result: ReadableAttachment[] = []
  for (const attachment of list) {
    const gate = checkFetchable(
      {
        displayName: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      },
      maxBytes,
    )
    if (gate.kind === 'ok') result.push({ attachment, ext: gate.ext })
  }
  return result
}

/** 一份附件的文本上限（字符）。超过就截断 —— 地点通常在开头几行。 */
const MAX_ATTACHMENT_CHARS = 12_000

/** 一次最多读几份附件（防一条公告挂 10 个 PDF 把请求拖垮）。 */
const MAX_ATTACHMENTS = 2

/**
 * 读这条公告的附件 → 抽文本 → 解析出考试（含地点）。
 *
 * ### 为什么**单独解析**附件而不是并入正文
 * 正文与附件是两份材料，混在一起会让 `sourceExcerpt`（逐字原文摘录）指不清出处 ——
 * 而摘录是用户核对"这个值凭什么这么写"的唯一凭据，指错出处比没有更糟。
 * 分开解析后，附件抽出的考试自带附件里的摘录，正文那份维持原样。
 *
 * @returns 解析出的考试条目；`note` 是没读成的人话原因（进回执，R3）。
 */
export async function readAttachmentExams(input: {
  supabase: ServerSupabase
  userId: string
  canvasCourseId: string
  externalAnnouncementId: string
}): Promise<{ exams: ParsedExam[]; note: string | null; permanent: boolean }> {
  const { supabase, userId, canvasCourseId, externalAnnouncementId } = input

  // ---------- 1) 凭据（没有 / 失效 → 确定性失败，重试无意义）----------
  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    return { exams: [], note: '还没连接 Canvas，读不了附件', permanent: true }
  }
  if (credential.status !== 'active') {
    return { exams: [], note: 'Canvas 连接已失效，读不了附件', permanent: true }
  }

  // ---------- 2) 现场回查附件清单（不落库，见文件头第 3 条）----------
  const fetched = await canvasGet<unknown>(
    credential.canvasDomain,
    credential.token,
    announcementPath(canvasCourseId, externalAnnouncementId),
  )
  if (!fetched.ok) {
    // 401/403 = 凭证问题（ADR-025：只跳过这个资源，不判凭证失效）；404 = 公告没了。
    return { exams: [], note: `读附件失败（${fetched.message}）`, permanent: false }
  }

  const readable = pickReadableAttachments(toAnnouncementAttachments(fetched.data))
  if (readable.length === 0) {
    return { exams: [], note: null, permanent: true }
  }

  // ---------- 3) 下载 → 抽文本 → 解析（每份一次模型调用）----------
  const exams: ParsedExam[] = []
  const notes: string[] = []

  for (const item of readable.slice(0, MAX_ATTACHMENTS)) {
    const downloaded = await downloadFile(item.attachment.url, MAX_DOWNLOAD_BYTES)
    if (!downloaded.ok) {
      notes.push(`${item.attachment.filename}：${downloaded.message}`)
      if (downloaded.permanent) continue
      return { exams, note: notes.join('；') || null, permanent: false }
    }

    const extracted = await extractSyllabusText(item.ext, downloaded.bytes)
    if (extracted.status !== 'extracted' || extracted.text === null) {
      // 扫描件：确定性失败，再抽一次还是空的。
      notes.push(`${item.attachment.filename}：${extracted.error ?? '抽不出文字'}`)
      continue
    }

    const text = extracted.text.slice(0, MAX_ATTACHMENT_CHARS)
    const parsed = await parseCourseUpdate({
      userId,
      text,
      // 与正文两条通道**不同**的 purpose：将来查"附件这条路解析得准不准"才分得开。
      purpose: 'announcement_attachment',
    })
    if (!parsed.ok) {
      return { exams, note: notes.join('；') || null, permanent: false }
    }

    for (const raw of Array.isArray(parsed.data.exams) ? parsed.data.exams : []) {
      const validated = validateExamInput(raw)
      if (validated.ok) exams.push(validated.value)
    }
  }

  return {
    exams,
    note: notes.length > 0 ? notes.join('；') : null,
    permanent: exams.length > 0,
  }
}
