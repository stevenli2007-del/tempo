import { UUID_PATTERN } from '@/lib/api/params'

/**
 * 五板块保存（P0-1-5b）的请求体校验共享助手。
 *
 * `lib/courses.ts` 里已有一套同思路的 `normalizeText` / `INVALID`（P0-1-7 交付，
 * 不翻旧代码）；这里把该模式抽出来给五张板块表的保存校验共用，
 * 五个 `parseSave*Input()` 只写各自的字段规则。
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** 标记"字段类型不对"，与"字段没传"（undefined）和"清空字段"（null）区分开。 */
const INVALID = Symbol('invalid')
type Invalid = typeof INVALID

/**
 * 条目文本字段：trim、空串视为 null（"清空该字段"）。
 * 类型不对（既不是 string 也不是 null/undefined）返回 INVALID。
 */
export function itemText(item: Record<string, unknown>, field: string): string | null | Invalid {
  const value = item[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return INVALID
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 条目的 `id`：可选；传了就必须是 UUID（否则后续按 id 匹配库里现有行全是白费）。 */
export function itemId(item: Record<string, unknown>): string | undefined | Invalid {
  const value = item.id
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return INVALID
  return value
}

export function isInvalid(value: unknown): value is Invalid {
  return value === INVALID
}

/** 一个板块最多接受的条目数。防呆用：正常 syllabus 五板块都在个位数到几十条。 */
const MAX_ITEMS = 200

/** 请求体骨架：`{ "items": [...] }`。 */
export function requireItemsArray(
  body: unknown,
): { ok: true; items: unknown[] } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const items = (body as Record<string, unknown>).items
  if (!Array.isArray(items)) {
    return { ok: false, message: 'items 必须是数组' }
  }
  if (items.length > MAX_ITEMS) {
    return { ok: false, message: `条目数不能超过 ${MAX_ITEMS}` }
  }
  return { ok: true, items }
}

/** 条目本身必须是对象。 */
export function requireItemObject(
  raw: unknown,
  index: number,
): { ok: true; item: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: `第 ${index + 1} 条必须是 JSON 对象` }
  }
  return { ok: true, item: raw as Record<string, unknown> }
}

/**
 * `ISO 日期 YYYY-MM-DD`。与 `lib/parse/index.ts` 里解析侧的判定是同一条规则；
 * 解析侧管模型输出、保存侧管用户输入，两处各留一份是为了不让校验层反向依赖 LLM 编排层。
 */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 日期字段：null/undefined → null；字符串必须形如 `YYYY-MM-DD` 且是真实存在的日期。 */
export function itemDate(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value.trim())) {
    return { ok: false, message: `${field} 必须是 YYYY-MM-DD 格式的日期` }
  }
  const trimmed = value.trim()
  // "2026-02-30" 能过正则但不是真实日期。用户手输日期，格式错了就该退回去重填，
  // 不能学解析侧那样静默置 null —— 那等于把用户明确输入的内容扔掉。
  const parsed = new Date(`${trimmed}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, message: `${field} 不是有效的日期` }
  }
  // 再用 Date 自身分量回验（new Date 对 "2026-02-30" 会自动进位到 3 月，不产生 NaN）。
  if (parsed.getUTCFullYear() !== Number(trimmed.slice(0, 4))) {
    return { ok: false, message: `${field} 不是有效的日期` }
  }
  if (parsed.getUTCMonth() !== Number(trimmed.slice(5, 7)) - 1) {
    return { ok: false, message: `${field} 不是有效的日期` }
  }
  if (parsed.getUTCDate() !== Number(trimmed.slice(8, 10))) {
    return { ok: false, message: `${field} 不是有效的日期` }
  }
  return { ok: true, value: trimmed }
}

/** 百分数字段（如 weightPercent）：null/undefined → null；必须是 0-100 的有限数字。 */
export function itemPercent(
  value: unknown,
  field: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return { ok: false, message: `${field} 必须是 0-100 之间的数字` }
  }
  return { ok: true, value }
}
