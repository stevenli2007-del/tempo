import type { TaskCandidate } from '@/types/task'

import { MATCH_THRESHOLD, matchTasks } from '@/lib/tasks/match'

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
  | { action: 'mark_done'; taskId: string; score: number }
  | { action: 'none'; reason: 'no_event' | 'no_title' | 'unsupported_event' | 'no_match' }

/**
 * 纯决策函数：解析结果 + 候选任务 → 该做什么。
 *
 * 召回 > 精确、且只用确定性匹配（复用 `matchTasks`，不靠 LLM 选 id，见 match.ts 头部说明）。
 * 本函数零 IO，可回归。
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

  const matches = matchTasks(parsed.taskTitle, candidates, { threshold: MATCH_THRESHOLD })
  const best = matches[0]
  if (!best) {
    return { action: 'none', reason: 'no_match' }
  }
  return { action: 'mark_done', taskId: best.id, score: best.score }
}
