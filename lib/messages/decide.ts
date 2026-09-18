import type { MessageStatus } from '@/types/message'

/**
 * 「确认 / 忽略」的**唯一判定**（P0-3-18）。
 *
 * 抽成纯函数是为了两件事：
 * 1. **只有一处**决定"要不要写" —— 浮窗与整页、API 与 UI 都问它，
 *    杜绝 P0-3-15 那种「分组按 A、渲染按 B」的分叉（CodingRules §10.1 第 21 条）。
 * 2. 可以被回归脚本直接断言（`scripts/regress-messages.ts`），不依赖数据库。
 *
 * 🔴 核心承诺（ADR-015「确认才写」）：
 * - `dismissed` **永不**触发 applier（忽略就是什么都不发生）；
 * - `accepted` 只有在 applier 就绪时才改状态；applier 没接入就**报错且不改状态** ——
 *   绝不能出现"状态显示已确认、其实什么都没写"这种静默失败（ADR-016 R3）。
 */

export type Decision = 'accepted' | 'dismissed'

export type DecisionPlan =
  | { kind: 'update'; nextStatus: MessageStatus; callApplier: boolean }
  | { kind: 'reject'; status: number; code: string; message: string }

export function planDecision(input: {
  currentStatus: MessageStatus
  decision: Decision
  /** 该类型是否有已接入的 applier（`isApplierReady(type)`）。 */
  applierReady: boolean
}): DecisionPlan {
  const { currentStatus, decision, applierReady } = input

  // 已经不是 pending：**拒绝**而不是幂等放过 ——
  // 幂等放过会让"连点两下确认"在 applier 有副作用时执行两次（将来 3-20 会真写 exam_dates）。
  if (currentStatus !== 'pending') {
    return {
      kind: 'reject',
      status: 409,
      code: 'already_decided',
      message: '这条提案已经处理过了',
    }
  }

  if (decision === 'dismissed') {
    return { kind: 'update', nextStatus: 'dismissed', callApplier: false }
  }

  if (!applierReady) {
    return {
      kind: 'reject',
      status: 501,
      code: 'applier_not_implemented',
      message: '这类提案的写入逻辑还没接入（由后续卡实现），现在请先「忽略」',
    }
  }

  return { kind: 'update', nextStatus: 'accepted', callApplier: true }
}
