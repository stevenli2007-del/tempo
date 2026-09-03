import type { SubmissionPolicy } from '@/types/parse'
import type { SaveSubmissionPolicyItem, StoredSubmissionPolicy } from '@/types/sections'
import {
  isInvalid,
  itemId,
  itemText,
  requireItemObject,
  requireItemsArray,
} from '@/lib/api/input'
import type { ValidationResult } from '@/lib/api/input'

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

// ---------- 保存（P0-1-5b PUT 全量替换） ----------

const MAX_SP_DESCRIPTION = 2000
const MAX_SP_PLATFORM = 200

export function parseSaveSubmissionPoliciesInput(
  body: unknown,
): ValidationResult<SaveSubmissionPolicyItem[]> {
  const extracted = requireItemsArray(body)
  if (!extracted.ok) return extracted

  const items: SaveSubmissionPolicyItem[] = []
  for (const [index, raw] of extracted.items.entries()) {
    const object = requireItemObject(raw, index)
    if (!object.ok) return object
    const item = object.item

    const id = itemId(item)
    const description = itemText(item, 'description')
    const platformName = itemText(item, 'platformName')
    if (isInvalid(id) || isInvalid(description) || isInvalid(platformName)) {
      return { ok: false, message: `第 ${index + 1} 条：id / description / platformName 字段类型错误` }
    }

    if (!description) return { ok: false, message: `第 ${index + 1} 条：description 不能为空` }
    if (description.length > MAX_SP_DESCRIPTION)
      return { ok: false, message: `第 ${index + 1} 条：description 不能超过 ${MAX_SP_DESCRIPTION} 个字符` }
    if (platformName && platformName.length > MAX_SP_PLATFORM)
      return { ok: false, message: `第 ${index + 1} 条：platformName 不能超过 ${MAX_SP_PLATFORM} 个字符` }

    items.push({
      ...(id ? { id } : {}),
      description,
      platformName,
    })
  }
  return { ok: true, value: items }
}

export function toSubmissionPolicySaveInsert(
  item: SaveSubmissionPolicyItem,
  courseId: string,
): Omit<SubmissionPolicyRow, 'id' | 'created_at' | 'updated_at'> {
  return {
    course_id: courseId,
    description: item.description,
    platform_name: item.platformName,
    source: 'manual',
    source_excerpt: null,
  }
}

export function toSubmissionPolicySaveUpdate(
  item: SaveSubmissionPolicyItem,
): Partial<Omit<SubmissionPolicyRow, 'id' | 'course_id' | 'source' | 'source_excerpt' | 'created_at' | 'updated_at'>> {
  return {
    description: item.description,
    platform_name: item.platformName,
  }
}
