import type { TaskCandidate } from '@/types/task'

import { normalizeTitle } from '@/lib/tasks/match'

/**
 * 入站邮件解析结果（P0-3-11）。由 `lib/email/parse.ts` 的 LLM 调用产出。
 *
 * 🔴 **决策边界（ADR-019 / 砍 scope 的结论）**：
 * 邮件**只更新已存在的任务**，且**仅在识别到「已提交」时写 `status='done'`**。
 * 绝不自动新建任务（防幻觉 + 防与 Canvas 同步撞车），也不自动改 dueDate
 * （那会与 Canvas 同步打架，且属于"出站/提醒"范畴，归 3-14）。
 * 其它事件（改期 / 新作业 / 无关）只记录审计日志，不落写。
 */
export type InboundEventType = 'submitted' | 'due_date_changed' | 'new_assignment' | 'other'

export type ParsedInbound = {
  /** 邮件提到的作业/任务名称；无关邮件填 null。 */
  taskTitle: string | null
  event: InboundEventType
  /** 仅 due_date_changed 时给日期，否则 null。 */
  newDueDate: string | null
  /** 邮件可能提到的课程名/代码，没有填 null（目前仅作日志，不参与绑定）。 */
  courseHint: string | null
  warnings: string[]
}

export type InboundDecision =
  | { action: 'mark_done'; taskId: string; matchedTitle: string }
  | {
      action: 'none'
      reason:
        | 'no_event'
        | 'no_title'
        | 'unsupported_event'
        | 'no_match'
        | 'already_done'
        | 'ambiguous_title'
      /** 歧义时列出「还没完成」的同名候选 id，便于从审计表回查到底卡在哪。 */
      candidates?: string[]
    }

/**
 * 纯决策函数：解析结果 + 候选任务 → 该做什么。
 *
 * ### 🔴 为什么这里**不用** `matchTasks` 的模糊阈值（2026-09-17 实测后收紧）
 * `lib/tasks/match.ts` 的 `MATCH_THRESHOLD = 0.6` 是为**对话框**定的：那里有人确认，
 * "多列一条候选让用户划掉"是可接受的代价，所以**召回优先**。
 * 但邮件入站**无人确认、直接写 `status='done'`** —— 同一个阈值实测会让**不存在的**
 * 作业以 **0.84** 命中真实作业（`Homework 9999` → `Homework 9`），
 * 而且同分时 `matchTasks` 只按 `score` 排序、**没有确定性 tie-break**，
 * 会退化成"看数据库返回顺序"（`Homework 5` 与 `Homework 2/6/7` 同分 0.89）。
 *
 * 因此本路径改用**归一化后完全相等**（`normalizeTitle`）：确定性、可复现、零误标。
 * `normalizeTitle` 仍能吸收大小写 / 全角 / 标点 / 空白 / `HW`↔`Homework` 缩写差异，
 * 所以不影响正常使用；只是**不再猜**。
 *
 * ### 同名多条的处置（真实数据里 `Homework 7` 就有两条）
 * 完全相等可能命中多条，此时依次尝试：
 * 1. 只剩**一条**未完成 → 就是它（已完成的同名项写 `done` 是空操作，不参与）；
 * 2. **全部已完成** → `already_done`，不落写（无事可做，也就无需挑一条）；
 * 3. 仍有**多条未完成** → `ambiguous_title`，**放弃落写**，只记审计。
 *
 * 本函数零 IO，可回归（`npm run regress:inbound`）。
 */
export function decideInboundAction(
  parsed: ParsedInbound,
  candidates: TaskCandidate[],
): InboundDecision {
  // 只处理「已提交」事件，且必须能定位到一条已存在的任务。
  if (parsed.event !== 'submitted') {
    if (parsed.event === 'other' || parsed.taskTitle === null) {
      return { action: 'none', reason: 'no_event' }
    }
    // due_date_changed / new_assignment 当前只记录、不落写。
    return { action: 'none', reason: 'unsupported_event' }
  }
  if (!parsed.taskTitle) {
    return { action: 'none', reason: 'no_title' }
  }

  const key = normalizeTitle(parsed.taskTitle)
  if (key === '') {
    return { action: 'none', reason: 'no_match' }
  }

  const exact = candidates.filter((candidate) => normalizeTitle(candidate.title) === key)
  if (exact.length === 0) {
    return { action: 'none', reason: 'no_match' }
  }

  // 未完成的那条才是这次"已提交"该指向的目标。
  const outstanding = exact.filter((candidate) => candidate.status !== 'done')
  if (outstanding.length === 1) {
    return { action: 'mark_done', taskId: outstanding[0].id, matchedTitle: outstanding[0].title }
  }
  if (outstanding.length === 0) {
    return { action: 'none', reason: 'already_done' }
  }
  return {
    action: 'none',
    reason: 'ambiguous_title',
    candidates: outstanding.map((candidate) => candidate.id),
  }
}
