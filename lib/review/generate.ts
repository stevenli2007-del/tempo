/**
 * 考试复习总结的生成（P0-3-31）—— 按需 + 落库缓存。
 *
 * ### 触发时机：用户在复习页主动点，不是同步
 * 3-19 的红线是「**索引/同步路径**一个字节都不下载」——本模块走的是另一条路
 * （ADR-026 开的按需路径）：用户勾了几份资料、点了「生成复习总结」，才为**那几份**取内容。
 * 索引路径**依然**零下载，271 个文件一个都没动。
 *
 * ### 全链路（六步，每步都可能失败，每步都分开报）
 * ① 解析勾选（只认这门课里确实存在的那一份 / 本场考试的上传件）
 * ② 算清单（顺序即 `f1/f2…` 编号）→ 比对缓存
 * ③ 逐份取内容（Canvas：单文件端点换链 → 下载 → 抽文本；上传件：Storage 现签 URL → 下载 → 抽文本）
 * ④ 调模型合并 → 校验 → 落 `exam_review_summaries`
 * ⑤ （不投消息：复习总结是**页面级产物**，与 `file_summaries` 同性质；
 *    出卷才走 3-23 的 `practice_test` 消息出口。）
 *
 * ### 🔴 失败分成两类，处理**必须不同**（3-19b / 3-23 踩过，这里沿用）
 * - **确定性失败**（图片 / 未知大小 / 超限 / 无文字层 / 对象没了）：这份材料**跳过**，
 *   在 `notes` 里如实说"它没纳入"，其余照常总结。这是**稳定事实**，重试也一样。
 * - **暂时性失败**（Canvas 5xx / 网络断 / 超时 / 上传对象取不到签名）：**整次中止、不落行**。
 *   网络抖一下不该悄悄少一份材料 —— 少一份材料的"合并总结"会被读成"这些就是全部"。
 *   用户重试一次即可（不落行 ⇒ 下次自然重来）。
 *
 * ### 🔴 全部材料都读不了时：`unsupported`，不是 `failed`
 * 那是"Tempo 读不了这些类型"，**不是"这场考试做不了"** —— 换几份资料就能继续，
 * 不该被永久拉黑（与 `file_summaries` 对图片的取舍同一条）。
 */

import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import { formatFileSize } from '@/lib/course-files/grouping'
import {
  MAX_DOWNLOAD_BYTES,
  checkFetchable,
  downloadFile,
  fetchFileText,
} from '@/lib/course-files/fetch-content'
import { extractSyllabusText } from '@/lib/extract'
import { runStructured } from '@/lib/llm/run'

import { findReviewFile } from './load'
import type { ExamReviewContext, ReviewFile } from './load'
import type { ReviewLocale } from './locale'
import { sameManifest } from './manifest'
import type { ReviewManifestItem } from './manifest'
import {
  EXAM_REVIEW_PROMPT_VERSION,
  buildExamReviewInput,
  buildExamReviewMessages,
  examReviewSchema,
  validateExamReviewOutput,
} from './prompt'
import { EXAM_REVIEW_BUCKET } from './storage'
import type { ReviewExtension } from './storage'
import { loadExamReviewSummary, saveExamReviewSummary } from './store'
import type { ReviewExtraFile, StoredExamReview } from './store'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 写进 `llm_runs.purpose`（那列没有 CHECK 约束，新用途直接加字面量）。 */
const PURPOSE = 'exam_review'

/** `error_message` 上限（同 `llm_runs` 的纪律：精简、不含用户内容）。 */
const ERROR_MESSAGE_MAX = 200

/** 生成一次复习总结的最终结果（页面按 `status` 分几种画法）。 */
export type ExamReviewOutcome =
  | { status: 'ready'; review: StoredExamReview; cached: boolean; notes: string[] }
  /** 一份都没勾。**不是失败** —— 是"还没开始"。 */
  | { status: 'empty'; message: string }
  /** 勾了的资料都读不了（图片 / 扫描件 / 格式不支持）。**不是失败**，是能力边界。 */
  | { status: 'unsupported'; message: string; notes: string[] }
  | { status: 'failed'; message: string }

/** 单份材料的取文本结果（供 extras 用；Canvas 文件走共用的 `fetchFileText`）。 */
type ExtraFetched =
  | { ok: true; text: string }
  | { ok: false; message: string; permanent: boolean }

/** 用户上传件：现签 Storage 短时 URL → 下载 → 抽文本。**不落盘、不入库**。 */
async function fetchExtraText(
  supabase: ServerSupabase,
  extra: ReviewExtraFile,
  ext: ReviewExtension,
): Promise<ExtraFetched> {
  const signed = await supabase.storage
    .from(EXAM_REVIEW_BUCKET)
    .createSignedUrl(extra.storagePath, 60)

  if (signed.error || !signed.data?.signedUrl) {
    // 签名失败多半是"对象不在了"（悬挂行 / 上传中断）→ 确定性，换一份就好。
    return {
      ok: false,
      message: `取下载链接失败：${signed.error?.message ?? '未知原因'}`,
      permanent: true,
    }
  }

  const download = await downloadFile(signed.data.signedUrl, MAX_DOWNLOAD_BYTES)
  if (!download.ok) {
    return { ok: false, message: download.message, permanent: download.permanent }
  }

  const extracted = await extractSyllabusText(ext, download.bytes)
  if (extracted.status !== 'extracted' || extracted.text === null) {
    return { ok: false, message: extracted.error ?? '这份文件抽不出文字。', permanent: true }
  }

  return { ok: true, text: extracted.text }
}

/**
 * 生成（或命中缓存）一份考试复习总结。**不抛异常**，所有失败都收敛成 `ExamReviewOutcome`。
 *
 * 幂等：同样的勾选集合 + 同样的文件版本重复调用时，缓存命中直接返回（`cached: true`），不花钱。
 */
export async function ensureExamReviewSummary(params: {
  supabase: ServerSupabase
  userId: string
  context: ExamReviewContext
  fileIds: readonly string[]
  extraIds: readonly string[]
  locale: ReviewLocale
}): Promise<ExamReviewOutcome> {
  const { supabase, userId, context, locale } = params

  // ---------- 0) 考试身份必须可辨识（持久键就是它） ----------
  if (context.exam.examKey === '') {
    return {
      status: 'failed',
      message:
        '这场考试的名字识别不出来（只有符号或空白），复习内容没法保存。请先到「五个板块 → 考试日期」把它改成一个能认出的名字。',
    }
  }

  // ---------- 1) 解析勾选（只认这门课里确实存在的那一份 / 本场考试的上传件） ----------
  const selectedFiles: ReviewFile[] = []
  const seenFile = new Set<string>()
  for (const id of params.fileIds) {
    if (seenFile.has(id)) continue
    seenFile.add(id)
    const file = findReviewFile(context.files, id)
    if (file) selectedFiles.push(file)
  }

  const selectedExtras: ReviewExtraFile[] = []
  const seenExtra = new Set<string>()
  for (const id of params.extraIds) {
    if (seenExtra.has(id)) continue
    seenExtra.add(id)
    const extra = context.extras.find((item) => item.id === id)
    if (extra) selectedExtras.push(extra)
  }

  if (selectedFiles.length === 0 && selectedExtras.length === 0) {
    return {
      status: 'empty',
      message: '还没有勾选任何资料 —— 先在上面清单里勾几份，再点「生成复习总结」。',
    }
  }

  // ---------- 2) 清单（顺序即 ref 编号） ----------
  const manifest: ReviewManifestItem[] = []
  for (const file of selectedFiles) {
    manifest.push({
      ref: `f${manifest.length + 1}`,
      kind: 'file',
      id: file.id,
      label: file.displayName,
      url: file.fileUrl,
      modifiedAt: file.modifiedAt,
    })
  }
  for (const extra of selectedExtras) {
    manifest.push({
      ref: `f${manifest.length + 1}`,
      kind: 'extra',
      id: extra.id,
      label: extra.displayName,
      url: null,
      modifiedAt: null,
    })
  }

  // ---------- 3) 缓存 ----------
  const cache = await loadExamReviewSummary(
    supabase,
    context.exam.courseId,
    context.exam.examKey,
    locale,
  )
  if (cache.error) {
    // 迁移没跑（42P01）会走到这里。**不降级成"没缓存"直接开算** ——
    // 那会让用户看到一个结果、但每次进入都重新花钱。如实报出来。
    return { status: 'failed', message: `读取复习缓存失败：${cache.error}` }
  }

  if (cache.summary && sameManifest(cache.summary.manifest, manifest)) {
    if (cache.summary.status === 'ok') {
      return { status: 'ready', review: cache.summary, cached: true, notes: [] }
    }
    // 上一次是确定性失败，且材料没变 → 直接复用那个结论，**不再打模型**。
    return { status: 'failed', message: cache.summary.errorMessage ?? '这场考试的复习总结上次生成失败。' }
  }

  // ---------- 4) 逐份取内容 ----------
  const notes: string[] = []
  const sources: Array<{ ref: string; label: string; text: string }> = []

  // 只有存在 Canvas 文件时才需要凭据（纯上传件的场景不该被"没连 Canvas"挡住）。
  let credential: Awaited<ReturnType<typeof loadDecryptedCredential>> = null
  if (selectedFiles.length > 0) {
    credential = await loadDecryptedCredential(supabase, userId)
    if (!credential) {
      return { status: 'failed', message: '还没有连接 Canvas，无法读取课程资料。' }
    }
    if (credential.status !== 'active') {
      return { status: 'failed', message: 'Canvas 连接已失效，请重新生成 token 后再试。' }
    }
    if (!context.canvasCourseId) {
      return { status: 'failed', message: '这门课还没有关联 Canvas 课程，无法定位文件。' }
    }
  }

  let temporary: string | null = null

  for (const item of manifest) {
    if (item.kind === 'file') {
      const file = selectedFiles.find((candidate) => candidate.id === item.id)
      if (!file) continue

      // 三道闸门（共用实现）：图片 / 未知大小 / 超限都在发请求之前判掉。
      const gate = checkFetchable({
        displayName: file.displayName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      })
      if (gate.kind !== 'ok') {
        notes.push(`「${file.displayName}」没纳入：${gate.reason}`)
        continue
      }
      if (!file.canvasFileId) {
        notes.push(`「${file.displayName}」没纳入：缺少 Canvas 标识，无法定位。`)
        continue
      }

      const fetched = await fetchFileText({
        file,
        ext: gate.ext,
        domain: credential!.canvasDomain,
        token: credential!.token,
        canvasCourseId: context.canvasCourseId!,
        canvasFileId: file.canvasFileId,
      })
      if (!fetched.ok) {
        if (fetched.permanent) {
          notes.push(`「${file.displayName}」没纳入：${fetched.message}`)
          continue
        }
        temporary = `${file.displayName}：${fetched.message}`
        break
      }
      sources.push({ ref: item.ref, label: file.displayName, text: fetched.value.text })
      continue
    }

    const extra = selectedExtras.find((candidate) => candidate.id === item.id)
    if (!extra) continue

    const ext = detectExtractableExtension(extra.displayName, extra.contentType)
    if (!ext) {
      notes.push(`「${extra.displayName}」没纳入：${unsupportedReason(extra.displayName, extra.contentType)}`)
      continue
    }
    if (extra.sizeBytes === null) {
      notes.push(`「${extra.displayName}」没纳入：没有大小信息，不敢下载。`)
      continue
    }
    if (extra.sizeBytes > MAX_DOWNLOAD_BYTES) {
      notes.push(
        `「${extra.displayName}」没纳入：太大（${formatFileSize(extra.sizeBytes) ?? '未知大小'}）。`,
      )
      continue
    }

    const fetched = await fetchExtraText(supabase, extra, ext)
    if (!fetched.ok) {
      if (fetched.permanent) {
        notes.push(`「${extra.displayName}」没纳入：${fetched.message}`)
        continue
      }
      temporary = `${extra.displayName}：${fetched.message}`
      break
    }
    sources.push({ ref: item.ref, label: extra.displayName, text: fetched.text })
  }

  if (temporary) {
    // 暂时性失败：整次中止、**不落行**（见文件头）。不给出"少了一份"的总结。
    return { status: 'failed', message: `有文件这次没读到（${temporary}）—— 稍后重试即可。` }
  }

  if (sources.length === 0) {
    return {
      status: 'unsupported',
      message: '勾选的资料 Tempo 都读不了（图片 / 扫描件 / 格式不支持）。换几份再试。',
      notes,
    }
  }

  // ---------- 5) 调模型合并 ----------
  const input = buildExamReviewInput({
    courseName: context.courseName,
    examLabel: context.exam.examName,
    sources,
  })

  const result = await runStructured<unknown>({
    userId,
    purpose: PURPOSE,
    promptVersion: EXAM_REVIEW_PROMPT_VERSION,
    capability: 'text',
    schema: examReviewSchema(),
    schemaName: 'ExamReview',
    messages: buildExamReviewMessages(input),
    // 要的是**忠实提炼**不是创作：温度高一点模型就会补出材料里没写的学科知识。
    temperature: 0,
    maxOutputTokens: 3_000,
  })

  const allowedRefs = manifest.map((item) => item.ref)

  if (!result.ok) {
    const message = `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX)
    // ⚠️ 429 / 超时 / 5xx **不落 failed 行**：下次可能就好了。
    // 只有"模型稳定地给不出符合 schema 的结果"才值得拉黑。
    console.error('[exam-review] 调用模型失败:', context.exam.examKey, message)
    if (result.error.code === 'schema_mismatch' || result.error.code === 'refused') {
      await persistFailure({
        supabase,
        context,
        locale,
        manifest,
        sourceChars: input.rawChars,
        truncated: input.truncated,
        message,
      })
    }
    return { status: 'failed', message: `复习总结生成失败：${result.error.message}` }
  }

  const validated = validateExamReviewOutput(result.data, allowedRefs)
  if (!validated.ok) {
    const message = validated.message.slice(0, ERROR_MESSAGE_MAX)
    await persistFailure({
      supabase,
      context,
      locale,
      manifest,
      sourceChars: input.rawChars,
      truncated: input.truncated,
      message,
    })
    return { status: 'failed', message: `AI 没能读出这些材料的内容（${validated.message}）。` }
  }

  if (validated.dropped > 0) {
    // 不拦（写进去的照常展示），但留痕："模型开始编 ref / 写废话"是 prompt 该修的早期信号。
    console.warn(`[exam-review] 模型多写/编了 ${validated.dropped} 条，已丢弃:`, context.exam.examKey)
  }

  // ---------- 6) 落库 ----------
  const saved = await saveExamReviewSummary({
    supabase,
    courseId: context.exam.courseId,
    examKey: context.exam.examKey,
    locale,
    status: 'ok',
    payload: validated.value,
    manifest,
    sourceChars: input.rawChars,
    sourceTruncated: input.truncated,
    model: result.usage.model,
    errorMessage: null,
  })
  if (saved.error) {
    // 写不进去 = 这次白算（下次还要重算）。降级继续：本次结果照样给用户看，但日志要响。
    console.error('[exam-review] 写入缓存失败（本次结果仍会显示，但下次会重算）:', saved.error)
  }

  return {
    status: 'ready',
    review: {
      status: 'ok',
      payload: validated.value,
      manifest,
      sourceChars: input.rawChars,
      sourceTruncated: input.truncated,
      model: result.usage.model,
      errorMessage: null,
      createdAt: cache.summary?.createdAt ?? new Date().toISOString(),
    },
    cached: false,
    notes,
  }
}

/** 落一行确定性失败（= 别再重试）。 */
async function persistFailure(params: {
  supabase: ServerSupabase
  context: ExamReviewContext
  locale: ReviewLocale
  manifest: ReviewManifestItem[]
  sourceChars: number
  truncated: boolean
  message: string
}): Promise<void> {
  const { error } = await saveExamReviewSummary({
    supabase: params.supabase,
    courseId: params.context.exam.courseId,
    examKey: params.context.exam.examKey,
    locale: params.locale,
    status: 'failed',
    payload: { overview: '', files: [], keyTopics: [] },
    manifest: params.manifest,
    sourceChars: params.sourceChars,
    sourceTruncated: params.truncated,
    model: null,
    errorMessage: params.message.slice(0, ERROR_MESSAGE_MAX),
  })

  if (error) {
    console.error('[exam-review] 写入失败标记失败（会导致下次重试）:', error)
  }
}
