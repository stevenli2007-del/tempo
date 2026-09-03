import type { OfficeHour } from '@/types/parse'
import type { StoredOfficeHour } from '@/types/sections'

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
