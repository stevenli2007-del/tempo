import type { OfficeHour } from '@/types/parse'
import type { SaveOfficeHourItem, StoredOfficeHour } from '@/types/sections'
import {
  isInvalid,
  itemId,
  itemText,
  requireItemObject,
  requireItemsArray,
} from '@/lib/api/input'
import type { ValidationResult } from '@/lib/api/input'

/**
 * `office_hours` 表的 DB 行 ↔ 对外对象映射（P0-1-5a）。
 *
 * 与 `submission_policies` 一样，这张表的 `source` 没有 NOT NULL 与默认值，
 * 对外类型是 `string | null`。
 *
 * **这是全项目唯一知道这张表 DB 列名的地方。**
 */

export const OFFICE_HOUR_COLUMNS =
  'id, course_id, person_name, day_of_week, start_time, end_time, location, source, source_excerpt'

export type OfficeHourRow = {
  id: string
  course_id: string
  person_name: string
  day_of_week: string | null
  start_time: string | null
  end_time: string | null
  location: string | null
  source: string | null
  source_excerpt: string | null
}

export function toOfficeHour(row: OfficeHourRow): StoredOfficeHour {
  return {
    id: row.id,
    personName: row.person_name,
    dayOfWeek: row.day_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    source: row.source,
    sourceExcerpt: row.source_excerpt,
  }
}

export function toOfficeHourInsert(
  item: OfficeHour,
  courseId: string,
): Omit<OfficeHourRow, 'id'> {
  return {
    course_id: courseId,
    person_name: item.personName,
    day_of_week: item.dayOfWeek,
    start_time: item.startTime,
    end_time: item.endTime,
    location: item.location,
    source: 'syllabus',
    source_excerpt: item.sourceExcerpt,
  }
}

// ---------- 保存（P0-1-5b PUT 全量替换） ----------

const MAX_OH_PERSON = 200
const MAX_OH_FIELD = 200

export function parseSaveOfficeHoursInput(body: unknown): ValidationResult<SaveOfficeHourItem[]> {
  const extracted = requireItemsArray(body)
  if (!extracted.ok) return extracted

  const items: SaveOfficeHourItem[] = []
  for (const [index, raw] of extracted.items.entries()) {
    const object = requireItemObject(raw, index)
    if (!object.ok) return object
    const item = object.item

    const id = itemId(item)
    const personName = itemText(item, 'personName')
    const dayOfWeek = itemText(item, 'dayOfWeek')
    const startTime = itemText(item, 'startTime')
    const endTime = itemText(item, 'endTime')
    const location = itemText(item, 'location')
    if (
      isInvalid(id) ||
      isInvalid(personName) ||
      isInvalid(dayOfWeek) ||
      isInvalid(startTime) ||
      isInvalid(endTime) ||
      isInvalid(location)
    ) {
      return { ok: false, message: `第 ${index + 1} 条：字段类型错误（文本字段必须是字符串）` }
    }

    if (!personName) return { ok: false, message: `第 ${index + 1} 条：personName 不能为空` }
    if (personName.length > MAX_OH_PERSON)
      return { ok: false, message: `第 ${index + 1} 条：personName 不能超过 ${MAX_OH_PERSON} 个字符` }
    for (const [label, value] of [
      ['dayOfWeek', dayOfWeek],
      ['startTime', startTime],
      ['endTime', endTime],
      ['location', location],
    ] as const) {
      if (value && value.length > MAX_OH_FIELD)
        return { ok: false, message: `第 ${index + 1} 条：${label} 不能超过 ${MAX_OH_FIELD} 个字符` }
    }

    items.push({
      ...(id ? { id } : {}),
      personName,
      dayOfWeek,
      startTime,
      endTime,
      location,
    })
  }
  return { ok: true, value: items }
}

export function toOfficeHourSaveInsert(
  item: SaveOfficeHourItem,
  courseId: string,
): Omit<OfficeHourRow, 'id' | 'created_at' | 'updated_at'> {
  return {
    course_id: courseId,
    person_name: item.personName,
    day_of_week: item.dayOfWeek,
    start_time: item.startTime,
    end_time: item.endTime,
    location: item.location,
    source: 'manual',
    source_excerpt: null,
  }
}

export function toOfficeHourSaveUpdate(
  item: SaveOfficeHourItem,
): Partial<Omit<OfficeHourRow, 'id' | 'course_id' | 'source' | 'source_excerpt' | 'created_at' | 'updated_at'>> {
  return {
    person_name: item.personName,
    day_of_week: item.dayOfWeek,
    start_time: item.startTime,
    end_time: item.endTime,
    location: item.location,
  }
}
