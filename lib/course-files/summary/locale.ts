/**
 * 单文件总结的语言白名单（P0-3-19b）。
 *
 * 与 `lib/messages/summary/locale.ts`（ADR-024）**同一套设计**：
 * `file_summaries` 的主键是 `(course_file_id, locale)`，一份文件可以有中文与英文两条总结，
 * 各用各的、互不覆盖 —— 共用一个 key 的话，英文版上线后生成的英文总结会把中文那条盖掉，
 * 用户在两种界面间切换就会反复触发重新生成（互相踩踏、每次都花钱）。
 *
 * ⚠️ 与 `lib/messages/summary/locale.ts` **刻意不共享**这个常量：
 * 两处的语言推进节奏可以不同（消息栏先出英文、资料总结后出，或反过来），
 * 共享一份会让"只想给其中一个加语言"变成必须同时改两处。
 *
 * ⚠️ 迁移里 `locale` **没有 CHECK 约束**（它只是数据标签，不是代码分支），
 * 所以白名单是**这一份 TS 常量**说了算 —— 加语言改这里、不改迁移。
 */

export const SUMMARY_LOCALES = ['zh-CN', 'en'] as const

export type SummaryLocale = (typeof SUMMARY_LOCALES)[number]

/** 当前默认（也是唯一真正在用的）语言。英文版上线前不进任何请求头。 */
export const DEFAULT_SUMMARY_LOCALE: SummaryLocale = 'zh-CN'

export function isSummaryLocale(value: unknown): value is SummaryLocale {
  return typeof value === 'string' && (SUMMARY_LOCALES as readonly string[]).includes(value)
}
