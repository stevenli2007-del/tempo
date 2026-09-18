/**
 * 摘要的**校验层**（P0-3-25b，纯函数：回归脚本直接 import 断言）。
 *
 * 两道闸，方向相反：
 * - `validateSummaryOutput()`：模型 → 我们。**放行但不撒谎** —— 逐项守卫、
 *   坏项丢掉并计数（一条要点写崩了不该让整份摘要消失），超长截断；
 *   只有"形状根本不是要点数组"才判失败（那说明模型没按 schema 走）。
 * - `validateSummaryRequest()`：客户端 → 我们。**不放行模棱两可** ——
 *   locale 不认识就 400，不静默回退；id 不是 UUID 就 400，不丢进查询里赌。
 *
 * ### 为什么"空要点"是成功而不是失败
 * 公告里真的有一类"纯寒暄"（"Welcome back, hope you had a good break"）。
 * 对它们，**正确的输出就是没有要点**。把它判成失败会让这些公告每次打开消息栏
 * 都重打一次模型（缓存表里落的是 failed 还是 ok，决定"要不要重试"）。
 */

import { UUID_PATTERN } from '@/lib/api/params'

import { DEFAULT_SUMMARY_LOCALE, isSummaryLocale, type SummaryLocale } from './locale'
import { MAX_POINTS, MAX_POINT_CHARS } from './prompt'

/** 失败分支。**必须带 `ok: false` 字面量**，否则 TS 无法用 `.ok` 收窄联合类型。 */
type Invalid = { ok: false; message: string }

/**
 * 一次请求最多接受多少个消息 id。
 *
 * 这是**滥用护栏**（每个 id 都对应一次模型调用），不是调度策略 ——
 * 真正"一轮生成几条"由 `generate.ts` 的 `MAX_MESSAGES_PER_REQUEST` 决定，
 * 超出的会在响应里作为 `remaining` 如实回报，下一轮再补。
 */
export const MAX_REQUESTED_MESSAGE_IDS = 50

export type SummaryOutput = {
  points: string[]
  /** 被丢掉的条数（非字符串 / 空白 / 超出条数上限）。 */
  dropped: number
  /** 被截断的条数（超长）。 */
  truncated: number
}

/**
 * 校验模型输出。
 *
 * 🔴 **`points` 缺失/不是数组 = 失败**（那说明它没按 schema 走，缓存成 ok 会让
 * 界面永远显示"没有要点"）；数组里的坏项则逐项丢掉 —— 两者严格程度不同，
 * 因为前者是"模型没听话"，后者是"模型写了条废话"。
 */
export function validateSummaryOutput(raw: unknown): { ok: true; value: SummaryOutput } | Invalid {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '模型返回的不是对象' }
  }
  const record = raw as Record<string, unknown>
  const rawPoints = record.points
  if (!Array.isArray(rawPoints)) {
    return { ok: false, message: '模型返回里缺少 points 数组' }
  }

  const points: string[] = []
  let dropped = 0
  let truncated = 0

  for (const entry of rawPoints) {
    if (typeof entry !== 'string') {
      dropped += 1
      continue
    }
    const trimmed = entry.trim()
    if (trimmed === '') {
      dropped += 1
      continue
    }
    if (points.length >= MAX_POINTS) {
      dropped += 1
      continue
    }
    if (trimmed.length > MAX_POINT_CHARS) {
      // 截断而不是丢弃：模型（尤其英文公告）常把关键信息写在开头，
      // 丢掉整条等于把"要交 HW7"这种话也一起扔了。
      points.push(`${trimmed.slice(0, MAX_POINT_CHARS)}…`)
      truncated += 1
      continue
    }
    points.push(trimmed)
  }

  return { ok: true, value: { points, dropped, truncated } }
}

export type SummaryRequest = {
  messageIds: string[]
  locale: SummaryLocale
}

/**
 * 校验请求体。
 *
 * - `messageIds`：非空数组、每个都是 UUID、**去重**（重复 id 会让同一条消息
 *   被并发生成两次 —— 虽然主键挡得住，但白花一次模型钱）；
 * - `locale`：缺省用 `DEFAULT_SUMMARY_LOCALE`，**给了就必须在白名单里**
 *   （不认识就 400：静默回退会往库里写下另一门语言的要点，
 *   表现是"英文界面显示中文要点"这种没人查得出的错）。
 */
export function validateSummaryRequest(body: unknown): { ok: true; value: SummaryRequest } | Invalid {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const record = body as Record<string, unknown>

  const rawIds = record.messageIds
  if (!Array.isArray(rawIds)) {
    return { ok: false, message: 'messageIds 必须是数组' }
  }
  if (rawIds.length === 0) {
    return { ok: false, message: 'messageIds 不能为空' }
  }
  if (rawIds.length > MAX_REQUESTED_MESSAGE_IDS) {
    return {
      ok: false,
      message: `一次最多请求 ${MAX_REQUESTED_MESSAGE_IDS} 条消息的摘要`,
    }
  }

  const messageIds: string[] = []
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
      return { ok: false, message: 'messageIds 里含非法 id' }
    }
    if (!messageIds.includes(raw)) messageIds.push(raw)
  }

  let locale: SummaryLocale = DEFAULT_SUMMARY_LOCALE
  if (record.locale !== undefined && record.locale !== null) {
    if (!isSummaryLocale(record.locale)) {
      return { ok: false, message: 'locale 只支持 zh-CN / en' }
    }
    locale = record.locale
  }

  return { ok: true, value: { messageIds, locale } }
}
