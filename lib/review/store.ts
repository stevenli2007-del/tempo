/**
 * `exam_review_summaries` / `exam_review_files` 的读写（P0-3-31）。
 *
 * ### 与 `lib/practice-test/store.ts` / `lib/course-files/summary/store.ts` 同一套纪律
 * 1. **调用方必须传会话 client**（不是 service role）：归属全靠 RLS
 *    （两张表都经 `courses.user_id` 反查）。这里的 `courseId` 来自路由，
 *    用 service role 就是"能读别人的复习总结 / 额外文件"（Sync-Strategy §3 同一纪律）。
 * 2. **不抛异常**：一律返回 `{ ..., error }`，由界面决定怎么画。
 * 3. **失败也落一行**（`status='failed'`）：那行的意义是"别再重试"。
 */

import type { ExamReviewPayload } from './prompt'
import type { ReviewLocale } from './locale'
import type { ReviewManifestItem } from './manifest'

import type { createClient } from '@/lib/supabase/server'

// 清单类型与差量比对住在 `./manifest.ts`（零依赖，回归脚本要用）。
export type { ReviewManifestItem } from './manifest'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

// ⚠️ 列清单必须是**单个字符串字面量**（不能拼接）：supabase-js 的类型推断靠它。
const SUMMARY_COLUMNS =
  'status, summary, source_manifest, source_chars, source_truncated, model, error_message, created_at, updated_at'

const EXTRA_COLUMNS =
  'id, course_id, exam_key, exam_label, display_name, storage_path, content_type, size_bytes, created_at'

/** 库里的一行复习总结（读取侧形状）。 */
export type StoredExamReview = {
  status: 'ok' | 'failed'
  payload: ExamReviewPayload
  manifest: ReviewManifestItem[]
  sourceChars: number
  sourceTruncated: boolean
  model: string | null
  errorMessage: string | null
  createdAt: string
}

/** 一条用户上传的额外文件（读取侧形状）。 */
export type ReviewExtraFile = {
  id: string
  courseId: string
  examKey: string
  examLabel: string
  displayName: string
  storagePath: string
  contentType: string | null
  sizeBytes: number | null
  createdAt: string
}

type SummaryRow = {
  status: string
  summary: unknown
  source_manifest: unknown
  source_chars: number
  source_truncated: boolean
  model: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

type ExtraRow = {
  id: string
  course_id: string
  exam_key: string
  exam_label: string
  display_name: string
  storage_path: string
  content_type: string | null
  size_bytes: number | null
  created_at: string
}

// ---------------------------------------------------------------
// 复习总结缓存
// ---------------------------------------------------------------

/** 读一场考试的复习总结缓存。 */
export async function loadExamReviewSummary(
  supabase: ServerSupabase,
  courseId: string,
  examKey: string,
  locale: ReviewLocale,
): Promise<{ summary: StoredExamReview | null; error: string | null }> {
  const { data, error } = await supabase
    .from('exam_review_summaries')
    .select(SUMMARY_COLUMNS)
    .eq('course_id', courseId)
    .eq('exam_key', examKey)
    .eq('locale', locale)
    .maybeSingle()

  if (error) return { summary: null, error: error.message }

  const row = data as SummaryRow | null
  if (!row) return { summary: null, error: null }

  return { summary: toStoredReview(row), error: null }
}

/** 写一行复习总结（成功或失败都写）。 */
export async function saveExamReviewSummary(params: {
  supabase: ServerSupabase
  courseId: string
  examKey: string
  locale: ReviewLocale
  status: 'ok' | 'failed'
  payload: ExamReviewPayload
  manifest: ReviewManifestItem[]
  sourceChars: number
  sourceTruncated: boolean
  model: string | null
  errorMessage: string | null
}): Promise<{ error: string | null }> {
  const { supabase, ...fields } = params

  const { error } = await supabase.from('exam_review_summaries').upsert(
    {
      course_id: fields.courseId,
      exam_key: fields.examKey,
      locale: fields.locale,
      status: fields.status,
      summary: fields.payload,
      source_manifest: fields.manifest,
      source_chars: fields.sourceChars,
      source_truncated: fields.sourceTruncated,
      model: fields.model,
      error_message: fields.errorMessage,
    },
    { onConflict: 'course_id,exam_key,locale' },
  )

  if (error) return { error: error.message }
  return { error: null }
}

// ---------------------------------------------------------------
// 额外上传的文件
// ---------------------------------------------------------------

/** 读一场考试下全部未删除的上传件（按上传时间升序）。 */
export async function loadExamExtraFiles(
  supabase: ServerSupabase,
  courseId: string,
  examKey: string,
): Promise<{ files: ReviewExtraFile[]; error: string | null }> {
  const { data, error } = await supabase
    .from('exam_review_files')
    .select(EXTRA_COLUMNS)
    .eq('course_id', courseId)
    .eq('exam_key', examKey)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })

  if (error) return { files: [], error: error.message }

  return { files: ((data ?? []) as ExtraRow[]).map(toExtraFile), error: null }
}

/** 按 id 读一条上传件（删除时要拿它的 `storage_path`）。 */
export async function loadExamExtraFile(
  supabase: ServerSupabase,
  fileId: string,
): Promise<{ file: ReviewExtraFile | null; error: string | null }> {
  const { data, error } = await supabase
    .from('exam_review_files')
    .select(EXTRA_COLUMNS)
    .eq('id', fileId)
    .eq('is_deleted', false)
    .maybeSingle()

  if (error) return { file: null, error: error.message }

  const row = data as ExtraRow | null
  return { file: row ? toExtraFile(row) : null, error: null }
}

/** 建一条上传件的元数据行（票据签发后、浏览器上传前调用）。 */
export async function insertExamExtraFile(params: {
  supabase: ServerSupabase
  id: string
  courseId: string
  userId: string
  examKey: string
  examLabel: string
  displayName: string
  storagePath: string
  contentType: string | null
  sizeBytes: number | null
}): Promise<{ file: ReviewExtraFile | null; error: string | null }> {
  const { supabase, ...fields } = params

  const { data, error } = await supabase
    .from('exam_review_files')
    .insert({
      id: fields.id,
      course_id: fields.courseId,
      user_id: fields.userId,
      exam_key: fields.examKey,
      exam_label: fields.examLabel,
      display_name: fields.displayName,
      storage_path: fields.storagePath,
      content_type: fields.contentType,
      size_bytes: fields.sizeBytes,
    })
    .select(EXTRA_COLUMNS)
    .single()

  if (error) return { file: null, error: error.message }

  return { file: toExtraFile(data as ExtraRow), error: null }
}

/** 软删一条上传件（`is_deleted = true`）。 */
export async function softDeleteExamExtraFile(
  supabase: ServerSupabase,
  fileId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('exam_review_files')
    .update({ is_deleted: true })
    .eq('id', fileId)

  if (error) return { error: error.message }
  return { error: null }
}

// ---------------------------------------------------------------
// 行 → 视图形状
// ---------------------------------------------------------------

/**
 * `summary` / `source_manifest` 是 jsonb，理论上是校验层写进去的干净结构；
 * 但**读的时候不能假设**（手改过的行、旧版本写的行都可能缺字段）。
 * 缺就降级成空值 —— 一份"要点为空"的总结总好过一个把 `undefined` 渲染进
 * `.map()` 的整页崩溃。
 */
function toStoredReview(row: SummaryRow): StoredExamReview {
  return {
    status: row.status === 'failed' ? 'failed' : 'ok',
    payload: readPayload(row.summary),
    manifest: readManifest(row.source_manifest),
    sourceChars: row.source_chars ?? 0,
    sourceTruncated: row.source_truncated === true,
    model: row.model ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
  }
}

function readPayload(raw: unknown): ExamReviewPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { overview: '', files: [], keyTopics: [] }
  }
  const record = raw as Record<string, unknown>
  const files: ExamReviewPayload['files'] = []
  if (Array.isArray(record.files)) {
    for (const entry of record.files) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const item = entry as Record<string, unknown>
      if (typeof item.ref !== 'string') continue
      files.push({ ref: item.ref, points: readStringList(item.points) })
    }
  }
  return {
    overview: typeof record.overview === 'string' ? record.overview : '',
    files,
    keyTopics: readStringList(record.keyTopics),
  }
}

function readManifest(raw: unknown): ReviewManifestItem[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewManifestItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    if (typeof item.ref !== 'string' || typeof item.id !== 'string') continue
    out.push({
      ref: item.ref,
      kind: item.kind === 'extra' ? 'extra' : 'file',
      id: item.id,
      label: typeof item.label === 'string' ? item.label : '',
      url: typeof item.url === 'string' ? item.url : null,
      modifiedAt: typeof item.modifiedAt === 'string' ? item.modifiedAt : null,
    })
  }
  return out
}

function toExtraFile(row: ExtraRow): ReviewExtraFile {
  return {
    id: row.id,
    courseId: row.course_id,
    examKey: row.exam_key,
    examLabel: row.exam_label ?? '',
    displayName: row.display_name,
    storagePath: row.storage_path,
    contentType: row.content_type ?? null,
    sizeBytes: row.size_bytes ?? null,
    createdAt: row.created_at,
  }
}

function readStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}
