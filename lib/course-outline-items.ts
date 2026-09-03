import type { CourseOutlineItem } from '@/types/parse'
import type { StoredCourseOutlineItem } from '@/types/sections'

/**
 * `course_outline_items` 表的 DB 行 ↔ 对外对象映射（P0-1-5a）。
 *
 * **这是全项目唯一知道这张表 DB 列名的地方。**
 */

export const COURSE_OUTLINE_ITEM_COLUMNS =
  'id, course_id, order_index, week_label, topic, source, source_excerpt'

export type CourseOutlineItemRow = {
  id: string
  course_id: string
  order_index: number
  week_label: string | null
  topic: string
  source: string
  source_excerpt: string | null
}

export function toCourseOutlineItem(row: CourseOutlineItemRow): StoredCourseOutlineItem {
  return {
    id: row.id,
    orderIndex: row.order_index,
    weekLabel: row.week_label,
    topic: row.topic,
    source: row.source,
    sourceExcerpt: row.source_excerpt,
  }
}

export function toCourseOutlineItemInsert(
  item: CourseOutlineItem,
  courseId: string,
): Omit<CourseOutlineItemRow, 'id'> {
  return {
    course_id: courseId,
    order_index: item.orderIndex,
    week_label: item.weekLabel,
    topic: item.topic,
    source: 'syllabus',
    source_excerpt: item.sourceExcerpt,
  }
}
