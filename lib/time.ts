/**
 * 学校时区与「按日历日分桶」工具（P0-3-7）。
 *
 * ### 为什么需要独立模块
 * 总览页的可视化（周历 / 债务条）要按**学校本地日历日**分桶，而 `dueDate` 是带时区的
 * ISO 串 —— 直接 `new Date(iso).getDate()` 拿到的是**运行环境**的日期（Vercel 上是 UTC），
 * Canvas 晚上截止的作业会整整差一天（P0-3-10 实测：`2026-09-13T23:59-07:00` = `2026-09-14T06:59Z`，
 * 按 UTC 取日期就印成 9/14）。
 *
 * 所以「这是哪一天」只能由**显式时区**决定；而且必须在**服务端**算好再往下传 ——
 * 同一个 `Intl.DateTimeFormat` 在服务端（UTC）与浏览器（用户时区）会给出不同结果，
 * 客户端各算一遍就是 hydration mismatch。
 *
 * ### 两个格式化器的分工（别混用）
 * - `schoolDayKey(date)`：给**真实时刻**用，回答"这一瞬间在伯克利是哪一天"。
 * - `UTC_DAY_KEY` / `dayKeyToUtcDate`：给**日历键算术**用。把 `YYYY-MM-DD` 解析成 UTC 零点只为
 *   做加减和取星期，它**不代表任何真实时刻**（所以用 UTC 反而是最安全的：无夏令时跳变）。
 *
 * Phase 0 只服务 Berkeley（ADR-004），时区是常量；将来多校时从 `profiles.timezone` 读。
 */

export const SCHOOL_TIME_ZONE = 'America/Los_Angeles'

/** 真实时刻 → 学校本地日历键（`YYYY-MM-DD`，可直接字符串比较/排序）。 */
const SCHOOL_DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 日历键 ↔ UTC 零点的互转（纯日历算术，不表示真实时刻）。 */
const UTC_DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const WEEKDAY = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' })
const MONTH_DAY = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'numeric', day: 'numeric' })

export function schoolDayKey(date: Date): string {
  return SCHOOL_DAY_KEY.format(date)
}

/** `YYYY-MM-DD` → UTC 零点 Date。**只为日历算术**，不要拿它当真实时刻用。 */
export function dayKeyToUtcDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

/** 日历键加减天数。UTC 无夏令时，`+ n * 86400000` 就是精确的 n 天。 */
export function addDays(key: string, days: number): string {
  const base = dayKeyToUtcDate(key)
  return UTC_DAY_KEY.format(new Date(base.getTime() + days * 86_400_000))
}

/** 「周日」/「周一」……（zh-CN 的 short weekday）。 */
export function weekdayLabel(key: string): string {
  return WEEKDAY.format(dayKeyToUtcDate(key))
}

/** 「9/13」。 */
export function monthDayLabel(key: string): string {
  return MONTH_DAY.format(dayKeyToUtcDate(key))
}

/**
 * 两个**可空时间值**是否指向同一瞬间 —— 同步层的变更判定专用。
 *
 * ### 为什么必须用 epoch 比，不能比字符串
 * 同一个时刻有两种合法写法：PostgREST 回 `2026-09-04T06:59:00+00:00`，
 * Canvas 给 `2026-09-04T06:59:00Z`。直接 `===` 会**永远判成"变了"**，
 * 于是每次同步把全表重写一遍（CodingRules §10.1 第 13 条）。
 *
 * ### 为什么收在这里（而不是各同步模块写一份）
 * 作业同步（P0-2-5）与资料索引（P0-3-19）都要判「库里的 vs 这次拉到的」。
 * 两处各写一份、某天只有一处改了判据，表现是"一边每次都重写、一边该写不写"
 * —— 这种分叉 `tsc` / `eslint` / `build` 全绿，只有对账时才发现。
 * 收成一份，两处共用同一个判据。
 *
 * - 两边都是 `null` → 相同（都没数据，遵守「没有变化就不写库」）；
 * - 只有一边是 `null` → 不同（出现了新的真相，要写）；
 * - 有一边解析不出来 → **不同**（保守地重写一次，宁可多写也不漏写真相）。
 */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return ta === tb
}
