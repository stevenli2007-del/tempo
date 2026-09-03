import type { ExamDate } from '@/types/parse'
import type { StoredExamDate } from '@/types/sections'

/**
 * `exam_dates` 表的 DB 行 ↔ 对外对象映射（P0-1-5a）。
 *
 * ⚠️ **这张表是可编辑的权威源**（ADR-004）：`tasks` 里的考试任务是它的派生缓存。
 * 任何写入都必须经 `lib/parse/persist.ts`（解析）或 P0-1-5b 的保存接口（用户编辑），
 * 不要在别处零散地 insert/update。
 *
 * **这是全项目唯一知道这张表 DB 列名的地方。**
 */

export const EXAM_DATE_COLUMNS =
  'id, course_id, exam_name, exam_date, exam_time, location, status, is_confirmed, source, source_excerpt'

export type ExamDateRow = {
  id: string
  course_id: string
  exam_name: string
  exam_date: string | null
  exam_time: string | null
  location: string | null
  status: string
  is_confirmed: boolean
  source: string
  source_excerpt: string | null
}

/**
 * `status` 的 CHECK 约束是 `('confirmed', 'tbd')`。
 *
 * 与 `lib/syllabi.ts` 的 `toEnum()` 同思路：约束外的取值一律抛错而不是给兜底值 ——
 * 这个字段会直接渲染成"已确定 / TBD"，编一个就是假数据。
 */
export function toExamDate(row: ExamDateRow): StoredExamDate {
  if (row.status !== 'confirmed' && row.status !== 'tbd') {
    throw new Error(`exam_dates.status 出现约束外的取值: ${row.status}`)
  }
  return {
    id: row.id,
    examName: row.exam_name,
    examDate: row.exam_date,
    examTime: row.exam_time,
    location: row.location,
    status: row.status,
    isConfirmed: row.is_confirmed,
    source: row.source,
    sourceExcerpt: row.source_excerpt,
  }
}

/**
 * 抽取结果 → 待插入的行。
 *
 * `status` **直接沿用 `ExamDate.status`**，不在这里重算：
 * 它已经在 `lib/parse/index.ts` 的 `normalizeExam()` 里由 `examDate` 派生过一次了，
 * 同一件事算两遍迟早会算出不一致的结果。
 */
export function toExamDateInsert(item: ExamDate, courseId: string): Omit<ExamDateRow, 'id'> {
  return {
    course_id: courseId,
    exam_name: item.examName,
    exam_date: item.examDate,
    exam_time: item.examTime,
    location: item.location,
    status: item.status,
    is_confirmed: false,
    source: 'syllabus',
    source_excerpt: item.sourceExcerpt,
  }
}
