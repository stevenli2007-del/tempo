import { isEffectivelyDone } from '@/lib/tasks/progress'
import type { TaskStatus, TaskSubmissionState } from '@/types/task'

/**
 * 音符规则的**纯逻辑层**（P0-5-4，零依赖 —— 可被 regress 脚本直接 import）。
 *
 * ### 这一层只回答两个问题
 * ① 这条任务**值不值**一枚音符？② 在已经挣到的那些里，**还差哪几条**没记？
 *
 * 读写数据库在 `store.ts`（它 import 了 `lib/supabase/server`，脚本跑不起来），
 * 按 CodingRules §10.2 那条规矩分成两个文件。
 *
 * ### 🔴 判定绝不自己重写一遍
 * 「算不算完成」**只有** `isEffectivelyDone()` 一个来源（`lib/tasks/progress.ts`）。
 * 它同时含 `status === 'done'`（用户手勾）与 `isCanvasDone()`（Canvas 代判）——
 * 2026-09-24 Steven 拍板：**Canvas 代判完成也给音符**（否则越 hands-off、音符越不涨，
 * 与 ADR-016「操作量趋零才是成功」反向）。
 */

/** 一条任务值几枚音符。**刻意是常量 1**：不做加权（考试 3 枚之类会变成「鼓励挑软柿子」）。 */
export const NOTE_UNIT = 1

/** 判定所需的最小字段集 —— 只取 `isEffectivelyDone()` 真正看的那两列。 */
export interface NoteCandidate {
  id: string
  status: TaskStatus
  submissionState: TaskSubmissionState | null
}

/**
 * 这条任务值不值一枚音符。
 *
 * 直接转调 `isEffectivelyDone()`，**不在这里加第二条判据** ——
 * 一旦加了（比如"考试才算"），界面上"已完成"与"有音符"就会对不上，
 * 而这两件事用户是**同一个动作**里看到的。
 */
export function earnsNote(task: NoteCandidate): boolean {
  return isEffectivelyDone(task)
}

export interface AwardPlan {
  /** 本次**应当新记入**的任务 id（已挣到的不在里面）。 */
  toAward: string[]
  /** 这批里已经挣到、跳过不记的条数（诊断用）。 */
  alreadyHeld: number
  /** 本次会让总数增加多少（= `toAward.length * NOTE_UNIT`）。 */
  delta: number
}

/**
 * 排出「还差哪几条没记」——**幂等的核心**。
 *
 * 为什么是纯函数：真正的幂等由数据库主键 `(user_id, task_id)` 兜底（见迁移注释），
 * 这里的作用是**少发一次无谓的插入**：总览页每次渲染都会拿整屏任务跑一遍懒补，
 * 若不管已挣到与否都 insert，那一屏里已完成的任务每刷新一次就要白写一遍。
 *
 * ### 同一批里重复 id 只算一次
 * 调用方给的数组可能含重复行（`Task[]` 经过 `dropCanvasExamPlaceholders` 之后不会，
 * 但别把"上游不会重复"当成前提）—— 不去重的话 `toAward` 里两个相同 id
 * 插进去只有一个成功，而 `delta` 却算了 2，数字与库里就对不上了。
 */
export function planAwards(
  candidates: readonly NoteCandidate[],
  awardedIds: readonly string[],
): AwardPlan {
  const held = new Set(awardedIds)
  const seen = new Set<string>()
  const toAward: string[] = []
  let alreadyHeld = 0

  for (const candidate of candidates) {
    if (!earnsNote(candidate)) continue
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    if (held.has(candidate.id)) {
      alreadyHeld += 1
      continue
    }
    toAward.push(candidate.id)
  }

  return { toAward, alreadyHeld, delta: toAward.length * NOTE_UNIT }
}
