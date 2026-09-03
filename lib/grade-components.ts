import type { GradeComponent } from '@/types/parse'
import type { SaveGradeComponentItem, StoredGradeComponent } from '@/types/sections'
import {
  isInvalid,
  itemId,
  itemPercent,
  itemText,
  requireItemObject,
  requireItemsArray,
} from '@/lib/api/input'
import type { ValidationResult } from '@/lib/api/input'

/**
 * `grade_components` 表的 DB 行 ↔ 对外对象映射（P0-1-5a）。
 *
 * 与 `lib/courses.ts` / `lib/syllabi.ts` 同构：**这是全项目唯一知道这张表 DB 列名的地方**。
 * 其余代码一律用 camelCase 的 `StoredGradeComponent`。
 */

/** 必须写成字面量字符串，不能 `.join()` —— 退化成 `string` 会让 supabase 推不出行类型。 */
export const GRADE_COMPONENT_COLUMNS =
  'id, course_id, name, weight_percent, notes, is_confirmed, source, source_excerpt'

export type GradeComponentRow = {
  id: string
  course_id: string
  name: string
  weight_percent: number | null
  notes: string | null
  is_confirmed: boolean
  source: string
  source_excerpt: string | null
}

export function toGradeComponent(row: GradeComponentRow): StoredGradeComponent {
  return {
    id: row.id,
    name: row.name,
    weightPercent: row.weight_percent,
    notes: row.notes,
    isConfirmed: row.is_confirmed,
    source: row.source,
    sourceExcerpt: row.source_excerpt,
  }
}

/** 解析结果的来源标记。只有 `syllabus` 来源的行会被重新解析覆盖（见 `lib/parse/persist.ts`）。 */
export const SOURCE_SYLLABUS = 'syllabus'

/**
 * 抽取结果 → 待插入的行。
 *
 * `is_confirmed` 留给默认 false：**解析出来不等于用户认可**，
 * 用户确认是 P0-1-5b 的保存接口才有的动作。
 */
export function toGradeComponentInsert(
  item: GradeComponent,
  courseId: string,
): Omit<GradeComponentRow, 'id'> {
  return {
    course_id: courseId,
    name: item.name,
    weight_percent: item.weightPercent,
    notes: item.notes,
    is_confirmed: false,
    source: SOURCE_SYLLABUS,
    source_excerpt: item.sourceExcerpt,
  }
}

// ---------- 保存（P0-1-5b PUT 全量替换） ----------

const MAX_GC_NAME = 200
const MAX_GC_NOTES = 2000

export function parseSaveGradeComponentsInput(body: unknown): ValidationResult<SaveGradeComponentItem[]> {
  const extracted = requireItemsArray(body)
  if (!extracted.ok) return extracted

  const items: SaveGradeComponentItem[] = []
  for (const [index, raw] of extracted.items.entries()) {
    const object = requireItemObject(raw, index)
    if (!object.ok) return object
    const item = object.item

    const id = itemId(item)
    const name = itemText(item, 'name')
    const notes = itemText(item, 'notes')
    if (isInvalid(id) || isInvalid(name) || isInvalid(notes)) {
      return { ok: false, message: `第 ${index + 1} 条：id / name / notes 字段类型错误` }
    }

    const weight = itemPercent(item.weightPercent, 'weightPercent')
    if (!weight.ok) return { ok: false, message: `第 ${index + 1} 条：${weight.message}` }

    if (!name) return { ok: false, message: `第 ${index + 1} 条：name 不能为空` }
    if (name.length > MAX_GC_NAME)
      return { ok: false, message: `第 ${index + 1} 条：name 不能超过 ${MAX_GC_NAME} 个字符` }
    if (notes && notes.length > MAX_GC_NOTES)
      return { ok: false, message: `第 ${index + 1} 条：notes 不能超过 ${MAX_GC_NOTES} 个字符` }

    items.push({
      ...(id ? { id } : {}),
      name,
      weightPercent: weight.value,
      notes,
    })
  }
  return { ok: true, value: items }
}

/**
 * 保存输入 → 新插入的行。**`source = 'manual'`**：不带 id 的条目是用户手动加的，
 * 重解析只删 `source = 'syllabus'` 的行（`lib/parse/persist.ts` 的规则），
 * 用户手动加的必须活过重解析。保存动作本身即确认，`is_confirmed = true`。
 */
export function toGradeComponentSaveInsert(
  item: SaveGradeComponentItem,
  courseId: string,
): Omit<GradeComponentRow, 'id' | 'created_at' | 'updated_at'> {
  return {
    course_id: courseId,
    name: item.name,
    weight_percent: item.weightPercent,
    notes: item.notes,
    is_confirmed: true,
    source: 'manual',
    source_excerpt: null,
  }
}

/** 保存输入 → 更新列。整行内容以表单为准（全量替换语义），并把确认位置 true。 */
export function toGradeComponentSaveUpdate(
  item: SaveGradeComponentItem,
): Partial<Omit<GradeComponentRow, 'id' | 'course_id' | 'source' | 'source_excerpt' | 'created_at' | 'updated_at'>> {
  return {
    name: item.name,
    weight_percent: item.weightPercent,
    notes: item.notes,
    is_confirmed: true,
  }
}
