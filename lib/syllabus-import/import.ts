/**
 * 「从 Canvas 已抓的文件里选一份当 syllabus」的**导入编排**（P0-3-30）。
 *
 * ### 与手动上传那条路的关系
 * 两条路终点一致（五板块 + 考试落库），**起点不同**：
 * - 上传：文件进 Storage → `raw_text` 落库 → `/extract` → `/parse`；
 * - 本路径：文件在 Canvas 上 → **按需下载**（用户点了才下）→ 抽文本 → 解析 → 落库。
 *
 * 本路径**刻意不写 `raw_text`**（原文不落库，ADR-026），所以也**不能**复用
 * `handleParseRequest`（它的先决条件是「`raw_text` 非空」）——
 * 这里直接调同一对 `parseSyllabusSections()` + `persistParsedSections()`，
 * 保证两条路解析与落库的语义**完全一样**（两处各写一遍就会漂）。
 *
 * ### 🔴 四条不能破的
 * 1. **一个外部请求都不多发**：三道闸门全在发请求之前判；幂等命中（同一文件已导过）
 *    直接返回，**零 Canvas 请求、零模型调用**。
 * 2. **不写 `raw_text`**，也不写 Canvas 的能力 `url`（`syllabi.file_url` 存的是**站内路径**）。
 * 3. **已有 syllabus 时不静默覆盖**：没拿到 `replace: true` 就回 `needs_confirm`。
 * 4. **导入成功必须把漂移锚点设成 baseline**（`courses.syllabus_file_id` +
 *    `syllabus_seen_modified_at`），否则下一轮同步立刻报「大纲变了」。
 */

import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { checkFetchable, fetchFileText } from '@/lib/course-files/fetch-content'
import { loadSummaryTarget } from '@/lib/course-files/summary/generate'
import { buildInternalPath } from '@/lib/internal-path'
import { parseSyllabusSections } from '@/lib/parse'
import { persistParsedSections } from '@/lib/parse/persist'
import { SYLLABUS_COLUMNS, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'

import type { createClient } from '@/lib/supabase/server'
import type { ParseSection } from '@/types/parse'
import type { StoredSections } from '@/types/sections'
import type { Syllabus } from '@/types/syllabus'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** `llm_runs.purpose` 前缀 —— 与 `syllabus_parse` / `syllabus_reparse` 分开，便于分组对比。 */
const PURPOSE_PREFIX = 'syllabus_import'

/** `syllabi` 行在本路径需要的列（多一个迁移新增的 `canvas_file_id`）。 */
const SYLLABUS_COLUMNS_WITH_CANVAS = `${SYLLABUS_COLUMNS}, canvas_file_id`

/** 迁移没跑时的提示（Steven 手跑 SQL，代码只能如实报出来，不能降级成"查不到缓存"）。 */
const MIGRATION_HINT =
  '数据库还缺 syllabi.canvas_file_id 列（迁移 20260925000000_syllabus_import.sql 未执行），请先在 Supabase 里跑它。'

export type ImportOutcome =
  | {
      status: 'imported'
      syllabus: Syllabus
      /** 本次是否命中幂等（true = 一个外部请求都没发）。 */
      cached: boolean
      okSections: ParseSection[]
      failedSections: { section: ParseSection; code: string; message: string }[]
      textLength: number
      truncated: boolean
      /** 写入的行数（供回执：考试 N 条 / 构成 N 条）。 */
      counts: { exams: number; gradeComponents: number }
    }
  /** Tempo 读不了这份文件（图片 / 大小未知 / 太大）。**不是失败**。 */
  | { status: 'unsupported'; message: string }
  /** 这门课已经有一份 syllabus，且调用方没说"可以替换"→ 一行都不许动。 */
  | { status: 'needs_confirm'; message: string }
  /** 失败。`retryable` 决定界面给不给"再试一次"。 */
  | { status: 'failed'; message: string; retryable: boolean }

/**
 * 导入一份 Canvas 文件作为这门课的 syllabus。
 *
 * **不抛异常**：所有失败收敛成 `ImportOutcome`（路由层再映射成 HTTP 状态）。
 */
export async function importSyllabusFromCanvasFile(params: {
  supabase: ServerSupabase
  userId: string
  courseId: string
  courseFileId: string
  /** 已有 syllabus 时是否允许替换（用户已在界面上确认过）。 */
  replace: boolean
}): Promise<ImportOutcome> {
  const { supabase, userId, courseId, courseFileId, replace } = params

  // ---------- 1) 目标文件（RLS 挡越权；再看它属不属于这门课） ----------
  const loaded = await loadSummaryTarget(supabase, courseFileId)
  if (loaded.error) {
    return { status: 'failed', message: `读取文件信息失败：${loaded.error}`, retryable: true }
  }
  const target = loaded.target
  // 查不到 / 不属于这门课 → 同一句（ADR-010：不泄漏存在性）。
  if (!target || target.courseId !== courseId) {
    return { status: 'failed', message: '找不到这个文件（可能已从 Canvas 上删除）。', retryable: false }
  }

  // ---------- 2) 三道闸门（发任何请求之前） ----------
  const gate = checkFetchable({
    displayName: target.displayName,
    contentType: target.contentType,
    sizeBytes: target.sizeBytes,
  })
  if (gate.kind !== 'ok') {
    return { status: 'unsupported', message: gate.reason }
  }

  // ---------- 3) 幂等：这门课是不是已经导过**同一个文件** ----------
  const existing = await loadSyllabusRows(supabase, courseId)
  if (existing.error) {
    return { status: 'failed', message: existing.error, retryable: true }
  }
  const sameFile = existing.rows.find((row) => row.canvas_file_id === courseFileId)
  if (sameFile && sameFile.parse_status === 'completed') {
    return {
      status: 'imported',
      syllabus: toSyllabus(sameFile),
      cached: true,
      okSections: [],
      failedSections: [],
      textLength: 0,
      truncated: false,
      counts: await countSyllabusRows(supabase, courseId),
    }
  }

  // ---------- 4) 已有另一份 syllabus → 必须先确认 ----------
  const other = existing.rows.find((row) => row.canvas_file_id !== courseFileId)
  if (other && !replace) {
    return {
      status: 'needs_confirm',
      message: `这门课已有一份 syllabus：${other.file_name}。导入会用这份 Canvas 文件替换 syllabus 来源的条目（你手动添加的保留）—— 确认后才继续。`,
    }
  }

  // ---------- 5) 凭据 ----------
  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    return { status: 'failed', message: '还没有连接 Canvas，无法取到文件内容。', retryable: false }
  }
  if (credential.status !== 'active') {
    return { status: 'failed', message: 'Canvas 连接已失效，请重新生成 token 后再试。', retryable: false }
  }
  if (!target.canvasFileId || !target.canvasCourseId) {
    return { status: 'failed', message: '这个文件缺少 Canvas 标识，无法定位。', retryable: false }
  }

  // ---------- 6) 取内容（原文只在内存里过一遍） ----------
  const fetched = await fetchFileText({
    file: {
      displayName: target.displayName,
      contentType: target.contentType,
      sizeBytes: target.sizeBytes,
    },
    ext: gate.ext,
    domain: credential.canvasDomain,
    token: credential.token,
    canvasCourseId: target.canvasCourseId,
    canvasFileId: target.canvasFileId,
  })
  if (!fetched.ok) {
    return { status: 'failed', message: fetched.message, retryable: !fetched.permanent }
  }

  // ---------- 7) 建 / 复用 syllabi 行 ----------
  const fileUrl = buildInternalPath(['courses', courseId, 'files', courseFileId])
  if (fileUrl === null) {
    return { status: 'failed', message: '拼不出这份文件的站内路径，已中止。', retryable: false }
  }

  const rowId = sameFile?.id ?? null
  const created = rowId
    ? null
    : await insertSyllabusRow({
        supabase,
        courseId,
        canvasFileId: courseFileId,
        fileName: target.displayName,
        fileUrl,
      })
  if (created?.error) {
    return { status: 'failed', message: created.error, retryable: true }
  }
  const syllabusId = rowId ?? created?.id ?? null
  if (syllabusId === null) {
    return { status: 'failed', message: '写入 syllabus 记录失败（没有返回 id）。', retryable: true }
  }

  // ---------- 8) 解析 + 落库（与手动上传那条路同一对函数） ----------
  const result = await parseSyllabusSections({
    userId,
    syllabusId,
    rawText: fetched.value.text,
    context: { courseName: target.courseName },
    purposePrefix: PURPOSE_PREFIX,
  })

  const stored: StoredSections = await persistParsedSections({
    supabase,
    courseId,
    sections: result.sections,
  })

  // ---------- 9) 写回状态（🔴 不写 raw_text） ----------
  const allFailed = result.okSections.length === 0
  const updated = await markResult({
    supabase,
    syllabusId,
    parseStatus: allFailed ? 'failed' : 'completed',
    parseError:
      result.failedSections.length === 0 ? null : `${result.failedSections.length} 个板块解析失败`,
    extractMethod: fetched.value.method,
    pageCount: fetched.value.pageCount,
  })
  if (updated.error || updated.syllabus === null) {
    return {
      status: 'failed',
      message: updated.error ?? '写回解析状态失败',
      retryable: true,
    }
  }

  // ---------- 10) 漂移锚点设为 baseline ----------
  // 不做这一步：下一轮同步会立刻把"刚导入的这份"报成"大纲变了"，凭空多一条提案。
  const anchorError = await setDriftAnchor({
    supabase,
    courseId,
    syllabusFileId: courseFileId,
    seenModifiedAt: target.modifiedAt,
  })
  if (anchorError) {
    // 数据已经写进去了，锚点没设上只影响下一轮会不会多报一次 —— 不影响本次结果。
    console.error('[syllabus-import] 漂移锚点写入失败（下一轮可能误报大纲变更）:', anchorError)
  }

  return {
    status: 'imported',
    syllabus: updated.syllabus,
    cached: false,
    okSections: result.okSections,
    failedSections: result.failedSections,
    textLength: result.meta.textLength,
    truncated: result.meta.truncated,
    counts: {
      exams: stored.testDates?.length ?? 0,
      gradeComponents: stored.gradeComposition?.length ?? 0,
    },
  }
}

// ---------------------------------------------------------------
// 数据库读写（都收在本文件里，便于一眼看清"本路径碰了哪些表"）
// ---------------------------------------------------------------

type SyllabusRowWithCanvas = SyllabusRow & { canvas_file_id: string | null }

/** 读这门课现有的 syllabi 行（含幂等用的 `canvas_file_id`）。 */
async function loadSyllabusRows(
  supabase: ServerSupabase,
  courseId: string,
): Promise<{ rows: SyllabusRowWithCanvas[]; error: string | null }> {
  const { data, error } = await supabase
    .from('syllabi')
    .select(SYLLABUS_COLUMNS_WITH_CANVAS)
    .eq('course_id', courseId)
    .order('uploaded_at', { ascending: false })

  if (error) {
    // 42703 = 列不存在 → 迁移没跑。**如实报**，不降级成"没有现有 syllabus"，
    // 那会把"缺列"包装成"可以导入"，然后在第 7 步插入时才炸、留下半成品数据。
    if (error.code === '42703') {
      return { rows: [], error: MIGRATION_HINT }
    }
    return { rows: [], error: `读取现有 syllabus 失败：${error.message}` }
  }

  return { rows: (data ?? []) as SyllabusRowWithCanvas[], error: null }
}

/**
 * 建一行 syllabi。
 *
 * 🔴 `raw_text` **故意不写**（恒为 null）：全文只在内存里过一遍（ADR-026）。
 * 🔴 `file_url` 存的是**站内路径**，不是 Canvas 的能力 `url`。
 * `extract_status` 直接写 `extracted` —— 文本已经抽出来了，走不到 `/extract` 那条路。
 */
async function insertSyllabusRow(params: {
  supabase: ServerSupabase
  courseId: string
  canvasFileId: string
  fileName: string
  fileUrl: string
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await params.supabase
    .from('syllabi')
    .insert({
      course_id: params.courseId,
      canvas_file_id: params.canvasFileId,
      file_url: params.fileUrl,
      file_name: params.fileName,
      extract_status: 'extracted',
      parse_status: 'pending',
    })
    .select('id')
    .maybeSingle()

  if (error) {
    if (error.code === '42703') return { id: null, error: MIGRATION_HINT }
    return { id: null, error: `写入 syllabus 记录失败：${error.message}` }
  }
  return { id: (data as { id: string } | null)?.id ?? null, error: null }
}

/** 写回解析结果（**不含 raw_text**）。 */
async function markResult(params: {
  supabase: ServerSupabase
  syllabusId: string
  parseStatus: 'completed' | 'failed'
  parseError: string | null
  extractMethod: string | null
  pageCount: number | null
}): Promise<{ syllabus: Syllabus | null; error: string | null }> {
  const { data, error } = await params.supabase
    .from('syllabi')
    .update({
      extract_status: 'extracted',
      extract_method: params.extractMethod,
      page_count: params.pageCount,
      parse_status: params.parseStatus,
      parse_error: params.parseError,
    })
    .eq('id', params.syllabusId)
    .select(SYLLABUS_COLUMNS)
    .maybeSingle()

  if (error) {
    return { syllabus: null, error: `写回解析状态失败：${error.message}` }
  }
  if (!data) {
    return { syllabus: null, error: '写回解析状态时这条 syllabus 已不存在' }
  }
  return { syllabus: toSyllabus(data as SyllabusRow), error: null }
}

/**
 * 把 3-20 的漂移锚点设为 baseline。
 *
 * `syllabus_seen_modified_at` 存的是**文件版本**（`course_files.modified_at`），
 * 不是"什么时候导入的" —— 见迁移 `20260923000000_syllabus_drift.sql` 的注释。
 */
async function setDriftAnchor(params: {
  supabase: ServerSupabase
  courseId: string
  syllabusFileId: string
  seenModifiedAt: string | null
}): Promise<string | null> {
  const { error } = await params.supabase
    .from('courses')
    .update({
      syllabus_file_id: params.syllabusFileId,
      syllabus_seen_modified_at: params.seenModifiedAt,
    })
    .eq('id', params.courseId)

  return error ? error.message : null
}

/** 回执用的行数（幂等命中时也要给，界面得说出"现在有几条"）。 */
async function countSyllabusRows(
  supabase: ServerSupabase,
  courseId: string,
): Promise<{ exams: number; gradeComponents: number }> {
  const [{ count: exams }, { count: gradeComponents }] = await Promise.all([
    supabase
      .from('exam_dates')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', courseId)
      .eq('source', 'syllabus'),
    supabase
      .from('grade_components')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', courseId)
      .eq('source', 'syllabus'),
  ])
  return { exams: exams ?? 0, gradeComponents: gradeComponents ?? 0 }
}
