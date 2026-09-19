/**
 * 考试复习总结的语言白名单（P0-3-31）。
 *
 * 与 `lib/course-files/summary/locale.ts`（3-19b）/ `lib/messages/summary/locale.ts`（ADR-024）
 * **同一套设计**：`exam_review_summaries` 的主键是 `(course_id, exam_key, locale)`，
 * 一场考试可以有中文与英文两条总结，各用各的、互不覆盖 —— 共用一个 key 的话，
 * 英文版上线后生成的英文总结会把中文那条盖掉，用户在两种界面间切换就反复触发重新生成
 * （互相踩踏、每次都花钱）。
 *
 * ⚠️ 与另外两处**刻意不共享**这个常量：三处语言推进节奏可以不同，
 * 共享一份会让"只想给其中一个加语言"变成必须同时改三处。
 *
 * ⚠️ 迁移里 `locale` **没有 CHECK 约束**（它只是数据标签，不是代码分支），
 * 所以白名单是**这一份 TS 常量**说了算 —— 加语言改这里、不改迁移。
 */

export const REVIEW_LOCALES = ['zh-CN', 'en'] as const

export type ReviewLocale = (typeof REVIEW_LOCALES)[number]

/** 当前默认（也是唯一真正在用的）语言。英文版上线前不进任何请求头。 */
export const DEFAULT_REVIEW_LOCALE: ReviewLocale = 'zh-CN'

export function isReviewLocale(value: unknown): value is ReviewLocale {
  return typeof value === 'string' && (REVIEW_LOCALES as readonly string[]).includes(value)
}
