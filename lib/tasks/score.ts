/**
 * 手记分数的归一化（P0-3-34）。
 *
 * ### 为什么单独一个纯函数文件
 * 与 `lib/tasks/manual.ts` 同一条理由：判定与转换必须能被 `scripts/regress-task-scores.ts`
 * 直接 import 断言 —— 不用数据库、不用网络、不用 LLM。
 *
 * ### 🔴 `null` 与 `0` 严格区分（沿用 P0-3-17 的铁律）
 * `score = 0` 是**考了 0 分**，是个真实取值；`possible` 缺失则画不出任何比例。
 * 所以这里**缺一个就整条拒收**，绝不用 0 兜底 —— 用 0 兜底会写进 `0 / 100`
 * 这种我们编出来的结论（见 `lib/numbers.ts` 的文件头）。
 *
 * ### 为什么不限制 score ≤ possible
 * 加分项（`5 / 4`）是真实存在的，`ScoreBar` 那边已经把比例夹在 `[0, 1]`，
 * 满分档照样画得出来。在这里拒收等于替老师改规则。
 *
 * ### 定标
 * 走 `roundToScale()`（= `numeric(10,2)` 的列标度），**写入与比较共用同一个已定标的值** ——
 * 这是 P0-3-28 修「同步永不收敛」时定下的纪律，本卡照用，不另写一套。
 */

import { roundToScale, toNumberOrNull } from '@/lib/numbers'

/** 一条手记分数（已定标，可直接落库）。 */
export type ScoreInput = {
  /** 分子（得分）。0 是合法取值。 */
  score: number
  /** 分母（满分）。必须 > 0，否则画不出比例。 */
  possible: number
}

/**
 * 校验并归一化一条手记分数。
 *
 * @param raw 请求体里的 `score` 字段。**`null` 不走这里** —— 那是「清除手记分数」，
 *   由调用方（PATCH 路由）自己处理成把三列置空。
 */
export function normalizeScoreInput(
  raw: unknown,
): { ok: true; value: ScoreInput } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'score 必须是 { score, possible } 对象（或 null 表示清除）' }
  }
  const r = raw as Record<string, unknown>

  // `toNumberOrNull` 而不是 `Number(...)`：后者把空串与 null 都变成 0，
  // 于是"没填满分"会被静默写成 0 分制（`lib/numbers.ts` 文件头那条坑）。
  const score = toNumberOrNull(r.score)
  const possible = toNumberOrNull(r.possible)

  if (score === null) {
    return { ok: false, message: 'score（得分）必须是数字 —— 0 分请写 0，不能省略' }
  }
  if (possible === null) {
    return { ok: false, message: 'possible（满分）必须是数字' }
  }
  if (score < 0) {
    return { ok: false, message: 'score（得分）不能是负数' }
  }
  if (possible <= 0) {
    return { ok: false, message: 'possible（满分）必须大于 0 —— 0 分制的作业画不出比例' }
  }

  const scaledScore = roundToScale(score)
  const scaledPossible = roundToScale(possible)
  if (scaledScore === null || scaledPossible === null) {
    return { ok: false, message: 'score / possible 无法解析成数字' }
  }

  return { ok: true, value: { score: scaledScore, possible: scaledPossible } }
}
