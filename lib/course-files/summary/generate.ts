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

import {
  MAX_DOWNLOAD_BYTES,
  checkFetchable,
  downloadFile,
  resolveDownloadUrl,
} from '../fetch-content'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
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

// 下载上限 / 三道闸门 / 下载与换链都在 `../fetch-content`（P0-3-30 抽出的共用实现）：
// 「一键总结」「自测卷」「大纲漂移」「本卡的 syllabus 一键导入」四条按需路径
// 必须给出同一个"能不能读"的答案。

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

/** 下载结果。`permanent` 决定要不要落 `failed` 行（形状定义在共用实现里）。 */
export type { DownloadResult } from '../fetch-content'

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

  // ---------- 0) 三道闸门（共用实现：扩展名/MIME → 大小已知 → 不超限） ----------
  // 全在发任何请求之前判 —— 图片型与"大小未知"的文件连一个字节都不下。
  const gate = checkFetchable({
    displayName: target.displayName,
    contentType: target.contentType,
    sizeBytes: target.sizeBytes,
  })
  if (gate.kind === 'unsupported') {
    // ⚠️ **不落 failed 行**：这是"Tempo 不做"，不是"这份材料做不了"。
    // 将来支持了图片就能直接用，不需要清缓存。
    return { status: 'unsupported', message: gate.reason }
  }
  if (gate.kind === 'too_large') {
    return { status: 'failed', message: gate.reason }
  }
  const ext = gate.ext

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

  // ---------- 4) 下载（大小闸门已在第 0 步跑过） ----------
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
