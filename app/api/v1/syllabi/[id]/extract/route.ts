import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { buildPreviewText, extractSyllabusText } from '@/lib/extract'
import type { ExtractOutcome } from '@/lib/extract'
import {
  SYLLABUS_BUCKET,
  SYLLABUS_COLUMNS,
  SYLLABUS_COLUMNS_WITH_TEXT,
  extractExtension,
  isAllowedExtension,
  isStorageObjectNotFoundError,
  toSyllabus,
} from '@/lib/syllabi'
import type { SyllabusRow, SyllabusRowWithText } from '@/lib/syllabi'
import type { Syllabus } from '@/types/syllabus'

/**
 * `POST /api/v1/syllabi/:id/extract` —— 上传流程的第 3 拍（P0-1-2）。
 *
 * 完整流程是三拍（ADR-009）：
 *   1. `POST /api/v1/courses/:id/syllabus`  → 取票据 + 建行
 *   2. 浏览器 `uploadToSignedUrl`           → 直传 Storage（不经过我们服务端）
 *   3. **本端点**                            → 提取文本
 *
 * 为什么必须单独一拍：第 1 步签发票据时文件**还没传上来**，服务端手里没有内容，
 * 拿不到文本。契约里旧版写的「201 响应带 previewText」在直传模式下是做不到的，
 * 已在 `API-Contract.md` §3 标注并修正。
 *
 * 取文件用**当前用户会话**签的短时下载 URL，而不是 service role：
 * 这样下载这一步仍然受 `storage.objects` 的 RLS 约束（Database.md 7.3），
 * 即使本端点的查询逻辑写错，也取不到别人的文件。
 *
 * 越权判定见 ADR-010：统一 404。
 */

/**
 * 函数最长执行时间（秒）。
 *
 * 20MB 的 PDF 用 pdfjs 逐页解析可能超过 Vercel 函数的默认时限，
 * 超时会表现为一次毫无信息的 504。给足 60 秒，换来的是失败时能看到真实原因。
 */
export const maxDuration = 60

/** 下载自己刚上传的文件，60 秒绰绰有余（签名只是过一下手）。 */
const SIGNED_URL_TTL_SECONDS = 60

/** 悬挂行（票据签发了但浏览器没传完）的提取失败原因。 */
const FILE_MISSING_ERROR =
  '文件没有上传完成，可能是上传过程中关掉了页面。请重新上传这份 syllabus。'

interface RouteContext {
  params: Promise<{ id: string }>
}

/** 本端点的响应体：`syllabus` 是变更后的完整对象，`previewText` 只有提取成功时才有。 */
type ExtractResponse = {
  syllabus: Syllabus
  previewText: string | null
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', 'Syllabus ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    // RLS 已限定只能看到自己课程下的 syllabus，查不到就是不存在或不是自己的。
    const { data, error } = await supabase
      .from('syllabi')
      .select(SYLLABUS_COLUMNS_WITH_TEXT)
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw error
    }
    if (!data) {
      return jsonError(request, 404, 'not_found', 'Syllabus 不存在或无权访问')
    }

    const row = data as SyllabusRowWithText

    // 幂等：已提取过就直接返回既有结果。文本只依赖文件内容，而文件不可变，
    // 重跑没有意义，只会白白再烧一次 CPU 与函数时长。
    if (row.extract_status === 'extracted') {
      return jsonOk(request, {
        syllabus: toSyllabus(row),
        previewText: buildPreviewText(row.raw_text),
      } satisfies ExtractResponse)
    }

    const ext = extractExtension(row.file_name)
    if (ext === null || !isAllowedExtension(ext)) {
      // 理论上到不了这里（上传时校验过），但提取按扩展名分派，
      // 这里再挡一次，免得将来有人绕过上传接口直接建行。
      return jsonError(request, 415, 'unsupported_file_type', '不支持的文件类型')
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(SYLLABUS_BUCKET)
      .createSignedUrl(row.file_url, SIGNED_URL_TTL_SECONDS)

    if (signError) {
      // 悬挂行（票据签发了但浏览器没传完）的判定信号。
      // **不能当服务端错误抛出去** —— 那会让用户看到 500，而不是「文件没传完」。
      // 判定细节（statusCode 是字符串 '404'）见 `isStorageObjectNotFoundError`。
      if (isStorageObjectNotFoundError(signError)) {
        await markExtractResult(supabase, id, fileMissingOutcome())
        return jsonError(request, 409, 'file_missing', FILE_MISSING_ERROR)
      }
      throw signError
    }
    if (!signed) {
      throw new Error('createSignedUrl 未返回签名 URL')
    }

    // 兜底：签名到下载之间文件被删掉的极窄窗口。
    const fileResponse = await fetch(signed.signedUrl)
    if (!fileResponse.ok) {
      // 悬挂行（P0-1-1 已知留白）：行建了但文件没传上来。
      // 按 Database.md 3.3 的兜底约定，把它置为 failed + 原因，让用户在界面上看得见。
      await markExtractResult(supabase, id, fileMissingOutcome())
      return jsonError(request, 409, 'file_missing', FILE_MISSING_ERROR)
    }

    const file = Buffer.from(await fileResponse.arrayBuffer())
    const outcome = await extractSyllabusText(ext, file)

    if (outcome.status === 'failed') {
      // 原始异常只在这里进日志；`outcome.error` 是给人看的一句话，不回传堆栈与服务端路径。
      console.error('[syllabus extract] 提取失败', { syllabusId: id, error: outcome.error })
    }

    const updated = await markExtractResult(supabase, id, outcome)

    return jsonOk(request, {
      syllabus: updated,
      previewText: buildPreviewText(outcome.text),
    } satisfies ExtractResponse)
  } catch (error) {
    return internalError(request, error)
  }
}

/** 悬挂行的提取结果：直接置 failed + 原因，让用户看得见（Database.md 3.3 的兜底约定）。 */
function fileMissingOutcome(): ExtractOutcome {
  return { status: 'failed', text: null, method: null, pageCount: null, error: FILE_MISSING_ERROR }
}

/**
 * 把提取结果写回行，返回变更后的完整对象。
 *
 * 注意查询用 `SYLLABUS_COLUMNS`（**不含 `raw_text`**）：
 * `raw_text` 可能是几 MB 的全文，写进去可以，读回来纯属浪费 ——
 * 前端要的只是 `previewText`（前 1000 字符）。
 */
async function markExtractResult(
  supabase: Awaited<ReturnType<typeof getCurrentUser>>['supabase'],
  id: string,
  outcome: Awaited<ReturnType<typeof extractSyllabusText>>,
): Promise<Syllabus> {
  const { data, error } = await supabase
    .from('syllabi')
    .update({
      extract_status: outcome.status,
      extract_method: outcome.method,
      extract_error: outcome.error,
      raw_text: outcome.text,
      page_count: outcome.pageCount,
    })
    .eq('id', id)
    .select(SYLLABUS_COLUMNS)
    .maybeSingle()

  if (error) {
    throw error
  }
  if (!data) {
    // 走到这里说明行在两步之间消失了（被删课程级联删除）。不是异常，但要如实报出去。
    throw new Error(`syllabi ${id} 在写回提取结果时已不存在`)
  }

  return toSyllabus(data as SyllabusRow)
}
