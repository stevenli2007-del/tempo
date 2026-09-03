import type { CourseOutlineItem } from '@/types/parse'
import type { SaveCourseOutlineItem, StoredCourseOutlineItem } from '@/types/sections'
import {
  isInvalid,
  itemId,
  itemText,
  requireItemObject,
  requireItemsArray,
} from '@/lib/api/input'
import type { ValidationResult } from '@/lib/api/input'

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

// ---------- 保存（P0-1-5b PUT 全量替换） ----------

const MAX_WEEK_LABEL = 100
const MAX_TOPIC = 500

export function parseSaveCourseOutlineInput(body: unknown): ValidationResult<SaveCourseOutlineItem[]> {
  const extracted = requireItemsArray(body)
  if (!extracted.ok) return extracted

  const items: SaveCourseOutlineItem[] = []
  for (const [index, raw] of extracted.items.entries()) {
    const object = requireItemObject(raw, index)
    if (!object.ok) return object
    const item = object.item

    const id = itemId(item)
    const weekLabel = itemText(item, 'weekLabel')
    const topic = itemText(item, 'topic')
    if (isInvalid(id) || isInvalid(weekLabel) || isInvalid(topic)) {
      return { ok: false, message: `第 ${index + 1} 条：id / weekLabel / topic 字段类型错误` }
    }

    if (!topic) return { ok: false, message: `第 ${index + 1} 条：topic 不能为空` }
    if (topic.length > MAX_TOPIC)
      return { ok: false, message: `第 ${index + 1} 条：topic 不能超过 ${MAX_TOPIC} 个字符` }
    if (weekLabel && weekLabel.length > MAX_WEEK_LABEL)
      return { ok: false, message: `第 ${index + 1} 条：weekLabel 不能超过 ${MAX_WEEK_LABEL} 个字符` }

    items.push({
      ...(id ? { id } : {}),
      weekLabel,
      topic,
    })
  }
  return { ok: true, value: items }
}

/**
 * 保存输入 → 新插入的行。`order_index` **由数组位置派生**（从 1 开始，与解析侧一致），
 * 不接受客户端自报的序号 —— 表单提交什么顺序，库里就是什么顺序。
 */
export function toCourseOutlineItemSaveInsert(
  item: SaveCourseOutlineItem,
  courseId: string,
  orderIndex: number,
): Omit<CourseOutlineItemRow, 'id' | 'created_at' | 'updated_at'> {
  return {
    course_id: courseId,
    order_index: orderIndex,
    week_label: item.weekLabel,
    topic: item.topic,
    source: 'manual',
    source_excerpt: null,
  }
}

export function toCourseOutlineItemSaveUpdate(
  item: SaveCourseOutlineItem,
  orderIndex: number,
): Partial<Omit<CourseOutlineItemRow, 'id' | 'course_id' | 'source' | 'source_excerpt' | 'created_at' | 'updated_at'>> {
  return {
    order_index: orderIndex,
    week_label: item.weekLabel,
    topic: item.topic,
  }
}
