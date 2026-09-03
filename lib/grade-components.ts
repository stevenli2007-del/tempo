import type { GradeComponent } from '@/types/parse'
import type { StoredGradeComponent } from '@/types/sections'

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
