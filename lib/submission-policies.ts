import type { SubmissionPolicy } from '@/types/parse'
import type { StoredSubmissionPolicy } from '@/types/sections'

/**
 * `submission_policies` 表的 DB 行 ↔ 对外对象映射（P0-1-5a）。
 *
 * 注意这张表的 `source` **没有 NOT NULL 与默认值**（与 `grade_components` 不同），
 * 所以对外类型是 `string | null` 而不是 `string`。这是 DB 事实，不在这里"修正"。
 *
 * **这是全项目唯一知道这张表 DB 列名的地方。**
 */

export const SUBMISSION_POLICY_COLUMNS =
  'id, course_id, description, platform_name, source, source_excerpt'

export type SubmissionPolicyRow = {
  id: string
  course_id: string
  description: string
  platform_name: string | null
  source: string | null
  source_excerpt: string | null
}

export function toSubmissionPolicy(row: SubmissionPolicyRow): StoredSubmissionPolicy {
  return {
    id: row.id,
    description: row.description,
    platformName: row.platform_name,
    source: row.source,
    sourceExcerpt: row.source_excerpt,
  }
}

export function toSubmissionPolicyInsert(
  item: SubmissionPolicy,
  courseId: string,
): Omit<SubmissionPolicyRow, 'id'> {
  return {
    course_id: courseId,
    description: item.description,
    platform_name: item.platformName,
    source: 'syllabus',
    source_excerpt: item.sourceExcerpt,
  }
}
