/**
 * 单文件「一键总结」的生成（P0-3-19b）—— 按需 + 落库缓存。
 *
 * ### 触发时机：用户主动点，不是同步
 * 3-19 的红线是「**索引路径**一个字节都不下载」。本模块走的是另一条路：
 * 用户在某个文件上点了「一键总结」，才为**那一个文件**取内容。
 * 因此这里可以下载 —— 它与"同步时顺手把 271 个文件都下了"是两回事，
 * 而后者会同时炸掉三件事：20 请求预算、Vercel 函数超时、以及账单。
 *
 * ### 全链路（四步，每步都可能失败，每步都分开报）
 * ① 取文件在 Canvas 上的**新鲜下载链**（`/courses/:cid/files/:fid` 的 `url` 字段）
 * ② 下载字节（**不落盘、不入库**，只在内存里过一遍）
 * ③ `lib/extract.ts` 抽文本（pdf / docx / pptx 三种）
 * ④ 结构化调模型 → 校验 → 落 `file_summaries`
 *
 * ### 🔴 失败分成两类，处理**必须不同**（这是本模块最容易写错的地方）
 * - **确定性失败**（扫描件没有文字层、格式不支持、模型确实读不出）→ 落 `failed` 行。
 *   那行的意义是「**别再重试**」：否则每次点开都为同一份材料重打一次模型。
 * - **暂时性失败**（Canvas 5xx / 网络断 / 超时 / 凭据失效）→ **不落行**。
 *   那是"我这次没做到"，不是"这份材料做不了"。落了行就等于永久拉黑一个可能
 *   只是网络抖了一下的文件（3-25b 在同类问题上做了同一个区分）。
 */

import { canvasGet } from '@/lib/canvas/client'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import { extractSyllabusText } from '@/lib/extract'
import { runStructured } from '@/lib/llm/run'
import { sameInstant } from '@/lib/time'

import type { ExtractableExtension } from '@/lib/course-files/extractable'
import type { SummaryLocale } from './locale'
import type { StoredSummary } from './store'

import {
  SUMMARY_PROMPT_VERSION,
  buildSummaryInput,
  buildSummaryMessages,
  summarySchema,
  validateSummaryOutput,
} from './prompt'
import { loadSummary, saveSummary } from './store'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 写进 `llm_runs.purpose`（那列没有 CHECK 约束，新用途直接加字面量）。 */
const PURPOSE = 'file_summary'

/**
 * 单份材料的下载上限（字节）。
 * 实测最大的 `L1 Slides.pdf` 是 2.4 MB，留一倍余量。
 * ⚠️ 真正的第一道闸是库里已知的 `size_bytes`（见 `ensureFileSummary`）——
 * 超限的文件**连一个请求都不发**，这里只是兜住"库里的大小过时了"的情况。
 */
export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024

/** 下载超时。课件 PDF 通常在几 MB 内，20 秒足够；再长就该让用户重试而不是干等。 */
const DOWNLOAD_TIMEOUT_MS = 20_000

/** `error_message` 上限（同 `llm_runs` 的纪律：精简、不含用户内容）。 */
const ERROR_MESSAGE_MAX = 200

/** 生成一次总结的最终结果（页面按 `status` 分三种画法）。 */
export type SummaryOutcome =
  | { status: 'ready'; summary: StoredSummary; cached: boolean }
  /** 这个类型 Tempo 读不了（图片 / 音视频 / 旧版 Office）。**不是失败**，是能力边界。 */
  | { status: 'unsupported'; message: string }
  | { status: 'failed'; message: string }

/** 从库里读出来的目标文件（够生成 + 够页面画标题）。 */
export type SummaryTarget = {
  id: string
  /** 所属课程 —— 页面用它校验 URL 里的 `:id` 与文件真的对得上。 */
  courseId: string
  displayName: string
  folderPath: string
  /** Canvas 预览页（给人点的那条），与下载链不是一回事。 */
  fileUrl: string
  contentType: string | null
  sizeBytes: number | null
  modifiedAt: string | null
  canvasFileId: string | null
  courseName: string
  canvasCourseId: string | null
}

/**
 * 取一份文件 + 它所属课程。
 *
 * 分两次查而不是 join：`courses` 的嵌入写法要写对外键名与 `!inner`，
 * 写错时的报错信息很难读；而这里总共就多一次往返。
 *
 * ⚠️ **会话 client + RLS**：越权访问别人的 `courseFileId` 会在这里直接查不到
 * （`course_files` 的策略经 `courses.user_id` 反查）。用 service role 就是越权。
 */
export async function loadSummaryTarget(
  supabase: ServerSupabase,
  courseFileId: string,
): Promise<{ target: SummaryTarget | null; error: string | null }> {
  const { data, error } = await supabase
    .from('course_files')
    .select(
      'id, display_name, folder_path, file_url, content_type, size_bytes, modified_at, canvas_file_id, course_id, is_deleted',
    )
    .eq('id', courseFileId)
    .maybeSingle()

  if (error) return { target: null, error: error.message }

  const file = data as {
    id: string
    display_name: string
    folder_path: string
    file_url: string
    content_type: string | null
    size_bytes: number | null
    modified_at: string | null
    canvas_file_id: string | null
    course_id: string
    is_deleted: boolean
  } | null

  // 软删的文件不给总结：它在 Canvas 上已经没了（或老师删了它），
  // 这时去下载大概率失败 —— 与其给一个网络错误，不如当作"找不到"。
  if (!file || file.is_deleted) return { target: null, error: null }

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('course_name, canvas_course_id')
    .eq('id', file.course_id)
    .maybeSingle()

  if (courseError) return { target: null, error: courseError.message }

  const courseRow = course as { course_name: string; canvas_course_id: string | null } | null
  if (!courseRow) return { target: null, error: null }

  return {
    target: {
      id: file.id,
      courseId: file.course_id,
      displayName: file.display_name,
      folderPath: file.folder_path,
      fileUrl: file.file_url,
      contentType: file.content_type,
      sizeBytes: file.size_bytes,
      modifiedAt: file.modified_at,
      canvasFileId: file.canvas_file_id,
      courseName: courseRow.course_name,
      canvasCourseId: courseRow.canvas_course_id,
    },
    error: null,
  }
}

/** 下载结果。`permanent` 决定要不要落 `failed` 行。 */
export type DownloadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; message: string; permanent: boolean }

/**
 * 下载文件字节。
 *
 * ⚠️ Canvas 的下载链**自带能力凭据**（`?verifier=…`），所以这里**不发 Bearer**
 * —— 实测加了也不影响（两种都 200），但不加更贴近这条链接的设计意图：
 * 它是"一个短时有效的下载凭据"，不是"一个要用 token 调 API"。
 */
export async function downloadFile(url: string, maxBytes: number): Promise<DownloadResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })

    if (!response.ok) {
      // 403 / 404：链接过期或文件在 Canvas 上没了。重试无用 → 确定性。
      const permanent = response.status === 403 || response.status === 404
      return { ok: false, message: `下载失败（Canvas 返回 HTTP ${response.status}）`, permanent }
    }

    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, message: `文件太大（${formatMb(declared)}），超过总结上限`, permanent: true }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      return { ok: false, message: `文件太大（${formatMb(bytes.byteLength)}），超过总结上限`, permanent: true }
    }

    return { ok: true, bytes }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      message: aborted ? '下载超时，请稍后重试' : '下载失败（网络问题），请稍后重试',
      // 暂时性：网络与超时都可能下次就好了，**不落 failed 行**。
      permanent: false,
    }
  } finally {
    clearTimeout(timer)
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 取新鲜下载链。
 *
 * 🔴 **必须先取一次单文件端点**，不能直接用库里存的 `file_url`：
 * 那个是 `/courses/:cid/files/:fid`（给人点的预览页），而我们真正要的是
 * `url` 字段里那条**带短时 verifier 的**下载链 —— 它是会过期的，不能落库。
 * 所以每次生成都现场换一条（一次请求，很便宜）。
 */
export async function resolveDownloadUrl(params: {
  domain: string
  token: string
  canvasCourseId: string
  canvasFileId: string
}): Promise<{ url: string | null; message: string | null; permanent: boolean }> {
  const result = await canvasGet<{ url?: string }>(
    params.domain,
    params.token,
    `/api/v1/courses/${params.canvasCourseId}/files/${params.canvasFileId}`,
  )

  if (!result.ok) {
    // 401/403：token 失效（这是**全局**的，不是这个文件的问题）；404：文件没了（局部）。
    const permanent = result.kind === 'not_found'
    return { url: null, message: result.message, permanent }
  }

  if (!result.data.url) {
    // 实测图片类文件会出现这种情况（有记录但没给下载链）。
    return { url: null, message: 'Canvas 没有为这个文件提供下载链接', permanent: true }
  }

  return { url: result.data.url, message: null, permanent: false }
}

/**
 * 生成（或命中缓存）一份总结。**不抛异常**，所有失败都收敛成 `SummaryOutcome`。
 *
 * 幂等：同一份文件重复调用时，缓存命中就直接返回（`cached: true`），不花钱。
 */
export async function ensureFileSummary(params: {
  supabase: ServerSupabase
  userId: string
  courseFileId: string
  locale: SummaryLocale
  /**
   * 页面已经查过一次时可直接传进来，省掉重复查同一行。
   * 不传则自己查 —— 独立脚本 / 后续批量调用不需要先构造它。
   */
  target?: SummaryTarget
}): Promise<SummaryOutcome> {
  const { supabase, userId, courseFileId, locale } = params

  let target = params.target ?? null
  if (!target) {
    const loaded = await loadSummaryTarget(supabase, courseFileId)
    if (loaded.error) {
      return { status: 'failed', message: `读取文件信息失败：${loaded.error}` }
    }
    target = loaded.target
  }
  if (!target) {
    return { status: 'failed', message: '找不到这个文件（可能已从 Canvas 上删除）。' }
  }

  // ---------- 0) 能力边界（在发任何请求之前判，省一次下载） ----------
  const ext = detectExtractableExtension(target.displayName, target.contentType)
  if (!ext) {
    // ⚠️ **不落 failed 行**：这是"Tempo 不做"，不是"这份材料做不了"。
    // 将来支持了图片就能直接用，不需要清缓存。
    return { status: 'unsupported', message: unsupportedReason(target.displayName, target.contentType) }
  }

  // ---------- 1) 缓存 ----------
  const { summary: cached, error: cacheError } = await loadSummary(supabase, courseFileId, locale)
  if (cacheError) {
    // 迁移没跑（42P01）会走到这里。**不降级成"没缓存"直接开算** ——
    // 那会让用户看到一个结果、但每次打开都重新花钱。如实报出来。
    return { status: 'failed', message: `读取总结缓存失败：${cacheError}` }
  }

  if (cached && sameInstant(cached.sourceModifiedAt, target.modifiedAt)) {
    if (cached.status === 'ok') {
      return { status: 'ready', summary: cached, cached: true }
    }
    // 上一次是确定性失败，且文件没变 → 直接复用那个结论，**不再打模型**。
    return { status: 'failed', message: cached.errorMessage ?? '这份材料上次生成失败。' }
  }

  // ---------- 2) 凭据 ----------
  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    return { status: 'failed', message: '还没有连接 Canvas，无法取到文件内容。' }
  }
  if (credential.status !== 'active') {
    return { status: 'failed', message: 'Canvas 连接已失效，请重新生成 token 后再试。' }
  }
  if (!target.canvasFileId || !target.canvasCourseId) {
    return { status: 'failed', message: '这个文件缺少 Canvas 标识，无法定位。' }
  }

  // ---------- 3) 大小闸门（库里的已知大小，超限连请求都不发） ----------
  if (target.sizeBytes !== null && target.sizeBytes > MAX_DOWNLOAD_BYTES) {
    return {
      status: 'failed',
      message: `文件太大（${formatMb(target.sizeBytes)}），超过总结上限。`,
    }
  }

  // ---------- 4) 下载 ----------
  const resolved = await resolveDownloadUrl({
    domain: credential.canvasDomain,
    token: credential.token,
    canvasCourseId: target.canvasCourseId,
    canvasFileId: target.canvasFileId,
  })
  if (!resolved.url) {
    return { status: 'failed', message: resolved.message ?? '取下载链接失败' }
  }

  const download = await downloadFile(resolved.url, MAX_DOWNLOAD_BYTES)
  if (!download.ok) {
    if (download.permanent) {
      await persistFailure({
        supabase,
        target,
        locale,
        ext,
        message: download.message,
      })
    }
    return { status: 'failed', message: download.message }
  }

  // ---------- 5) 抽文本 ----------
  const extracted = await extractSyllabusText(ext, download.bytes)
  if (extracted.status !== 'extracted' || extracted.text === null) {
    const message = extracted.error ?? '这份文件抽不出文字。'
    // 「扫描件 / 图片型 PDF」是**确定性**的：同一个文件再抽一次还是空的。
    await persistFailure({ supabase, target, locale, ext, message })
    return { status: 'failed', message }
  }

  // ---------- 6) 调模型 ----------
  const input = buildSummaryInput({
    fileName: target.displayName,
    folderPath: target.folderPath,
    courseName: target.courseName,
    text: extracted.text,
  })

  const result = await runStructured<unknown>({
    userId,
    purpose: PURPOSE,
    promptVersion: SUMMARY_PROMPT_VERSION,
    capability: 'text',
    schema: summarySchema(),
    schemaName: 'CourseFileSummary',
    messages: buildSummaryMessages(input),
    // 要的是**忠实复述**不是创作：温度高一点就会补出材料里没写的学科知识。
    temperature: 0,
    maxOutputTokens: 900,
  })

  if (!result.ok) {
    const message = `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX)
    // ⚠️ 模型调用失败**不落 failed 行**：429/超时/5xx 下次可能就好了。
    // 只有"模型稳定地给不出符合 schema 的结果"才值得拉黑（下面那条分支）。
    console.error('[file-summary] 调用模型失败:', target.id, message)
    if (result.error.code === 'schema_mismatch' || result.error.code === 'refused') {
      await persistFailure({ supabase, target, locale, ext, message, pageCount: extracted.pageCount, input })
    }
    return { status: 'failed', message: `AI 总结失败：${result.error.message}` }
  }

  const validated = validateSummaryOutput(result.data)
  if (!validated.ok) {
    const message = validated.message.slice(0, ERROR_MESSAGE_MAX)
    await persistFailure({ supabase, target, locale, ext, message, pageCount: extracted.pageCount, input })
    return { status: 'failed', message: `AI 没能读出这份材料的内容（${validated.message}）。` }
  }

  if (validated.dropped > 0) {
    // 不拦（已写的照常展示），但留痕："模型开始写超量条目"是 prompt 该修的早期信号。
    console.warn(`[file-summary] 模型多写了 ${validated.dropped} 条，已丢弃:`, target.id)
  }

  // ---------- 7) 落库 ----------
  const saved = await saveSummary({
    supabase,
    courseFileId: target.id,
    locale,
    status: 'ok',
    payload: validated.value,
    sourceChars: input.sourceChars,
    sourceTruncated: input.truncated,
    pageCount: extracted.pageCount,
    extractMethod: extracted.method,
    sourceModifiedAt: target.modifiedAt,
    model: result.usage.model,
    errorMessage: null,
  })
  if (saved.error) {
    // 写不进去 = 这次白算（下次还要重算）。降级继续：本次结果照样给用户看，但日志要响。
    // 典型原因是迁移没跑 —— 那种情况下 `loadSummary` 已经先报错了，这里多半是权限/连接问题。
    console.error('[file-summary] 写入缓存失败（本次结果仍会显示，但下次会重算）:', saved.error)
  }

  return {
    status: 'ready',
    summary: {
      status: 'ok',
      payload: validated.value,
      sourceChars: input.sourceChars,
      sourceTruncated: input.truncated,
      pageCount: extracted.pageCount,
      extractMethod: extracted.method,
      sourceModifiedAt: target.modifiedAt,
      model: result.usage.model,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    },
    cached: false,
  }
}

/** 落一行确定性失败（= 别再重试）。 */
async function persistFailure(params: {
  supabase: ServerSupabase
  target: SummaryTarget
  locale: SummaryLocale
  ext: ExtractableExtension
  message: string
  pageCount?: number | null
  input?: { sourceChars: number; truncated: boolean }
}): Promise<void> {
  const { error } = await saveSummary({
    supabase: params.supabase,
    courseFileId: params.target.id,
    locale: params.locale,
    status: 'failed',
    payload: { overview: '', points: [], formulas: [] },
    sourceChars: params.input?.sourceChars ?? 0,
    sourceTruncated: params.input?.truncated ?? false,
    pageCount: params.pageCount ?? null,
    extractMethod: params.ext,
    // 记下**当时的**文件版本：文件一换就该重试，而不是永远记着旧结论。
    sourceModifiedAt: params.target.modifiedAt,
    model: null,
    errorMessage: params.message.slice(0, ERROR_MESSAGE_MAX),
  })

  if (error) {
    console.error('[file-summary] 写入失败标记失败（会导致下次重试）:', error)
  }
}
