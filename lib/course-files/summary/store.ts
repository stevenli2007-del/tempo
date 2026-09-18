/**
 * `file_summaries` 的读写（P0-3-19b）。
 *
 * ### 与 `lib/messages/summary/store.ts` 同一套纪律
 * 1. **调用方必须传会话 client**（不是 service role）：归属全靠 RLS
 *    （`file_summaries → course_files → courses.user_id`）。
 *    这里的 `courseFileId` 来自**客户端 URL**，用 service role 就是"能读别人的课件总结"
 *    —— 那是把越权写在明面上（Sync-Strategy §3 的同一纪律）。
 * 2. **不抛异常**：一律返回 `{ ..., error }`，由界面决定怎么画。
 * 3. **失败也落一行**（`status='failed'`）：那行的意义是"别再重试"。
 */

import type { FileSummaryPayload } from './prompt'
import type { SummaryLocale } from './locale'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 库里的一行总结（读取侧形状）。 */
export type StoredSummary = {
  status: 'ok' | 'failed'
  payload: FileSummaryPayload
  sourceChars: number
  sourceTruncated: boolean
  pageCount: number | null
  extractMethod: string | null
  /** 生成时那份文件在 Canvas 的 `modified_at` —— 与当前值不同 = 老师换过文件 = 重算。 */
  sourceModifiedAt: string | null
  model: string | null
  errorMessage: string | null
  createdAt: string
}

type Row = {
  status: string
  summary: unknown
  source_chars: number
  source_truncated: boolean
  page_count: number | null
  extract_method: string | null
  source_modified_at: string | null
  model: string | null
  error_message: string | null
  created_at: string
}

/** 读一份文件的总结缓存。 */
export async function loadSummary(
  supabase: ServerSupabase,
  courseFileId: string,
  locale: SummaryLocale,
): Promise<{ summary: StoredSummary | null; error: string | null }> {
  const { data, error } = await supabase
    .from('file_summaries')
    .select(
      'status, summary, source_chars, source_truncated, page_count, extract_method, source_modified_at, model, error_message, created_at',
    )
    .eq('course_file_id', courseFileId)
    .eq('locale', locale)
    .maybeSingle()

  if (error) return { summary: null, error: error.message }

  const row = data as Row | null
  if (!row) return { summary: null, error: null }

  return { summary: toStoredSummary(row), error: null }
}

/** 写一行总结（成功或失败都写）。 */
export async function saveSummary(params: {
  supabase: ServerSupabase
  courseFileId: string
  locale: SummaryLocale
  status: 'ok' | 'failed'
  payload: FileSummaryPayload
  sourceChars: number
  sourceTruncated: boolean
  pageCount: number | null
  extractMethod: string | null
  sourceModifiedAt: string | null
  model: string | null
  errorMessage: string | null
}): Promise<{ error: string | null }> {
  const { supabase, ...fields } = params

  const { error } = await supabase.from('file_summaries').upsert(
    {
      course_file_id: fields.courseFileId,
      locale: fields.locale,
      status: fields.status,
      summary: fields.payload,
      source_chars: fields.sourceChars,
      source_truncated: fields.sourceTruncated,
      page_count: fields.pageCount,
      extract_method: fields.extractMethod,
      source_modified_at: fields.sourceModifiedAt,
      model: fields.model,
      error_message: fields.errorMessage,
    },
    { onConflict: 'course_file_id,locale' },
  )

  if (error) return { error: error.message }
  return { error: null }
}

/**
 * 把行读成视图形状。
 *
 * `summary` 是 jsonb，理论上是 `validateSummaryOutput()` 写进去的干净结构；
 * 但**读的时候不能假设**：手改过的行、旧版本写的行都可能缺字段。
 * 缺就降级成空值 —— 一份"要点为空"的总结总好过一个把 `undefined` 渲染进
 * `points.map()` 的整页崩溃。
 */
function toStoredSummary(row: Row): StoredSummary {
  return {
    status: row.status === 'failed' ? 'failed' : 'ok',
    payload: readPayload(row.summary),
    sourceChars: row.source_chars ?? 0,
    sourceTruncated: row.source_truncated === true,
    pageCount: row.page_count ?? null,
    extractMethod: row.extract_method ?? null,
    sourceModifiedAt: row.source_modified_at ?? null,
    model: row.model ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
  }
}

function readPayload(raw: unknown): FileSummaryPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { overview: '', points: [], formulas: [] }
  }
  const record = raw as Record<string, unknown>
  return {
    overview: typeof record.overview === 'string' ? record.overview : '',
    points: readStringList(record.points),
    formulas: readStringList(record.formulas),
  }
}

function readStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}
