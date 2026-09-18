import type { MessagePayload, MessageType } from '@/types/message'

/**
 * 提案的「写入器」注册表（P0-3-18 定义的**接缝**）。
 *
 * ### 为什么要有这一层
 * P0-3-18 只负责「提案怎么排队、怎么被确认 / 忽略」；**每种提案确认之后到底写什么**，
 * 是产生它的那张卡的事：`syllabus_drift` → P0-3-20（改五板块 / `exam_dates`）、
 * `practice_test` → P0-3-23、`routine` → P0-3-21（Phase 1）、
 * `material`（资料索引通知）→ P0-3-19，本身**不需要写业务数据**。
 *
 * 所以这里只放「注册表 + 一个通知类实现」，其余类型明确返回"未接入" ——
 * 而不是塞一个空的 no-op 让确认看起来生效（那就是静默失败）。
 *
 * ### 后续卡怎么接
 * 1. 在 `APPLIERS` 里加自己的类型（函数签名见 `MessageApplier`）；
 * 2. applier 内部持有自己的写入纪律（如 3-20「绝不自动覆盖 exam_dates」）；
 * 3. 无需改 UI —— 按钮可用性由 `lib/messages/view.ts` 的 `canAccept` 自动跟随。
 *
 * 🔴 applier 只会被 `PATCH /api/v1/messages/:id` 在**确认**路径上调用一次；
 * 忽略路径永不调用（`lib/messages/decide.ts`）。
 */

export type ApplyOutcome =
  | { ok: true; summary: string }
  | { ok: false; code: string; message: string }

export type MessageApplier = (ctx: {
  type: MessageType
  payload: MessagePayload
}) => Promise<ApplyOutcome>

/**
 * `material`：资料索引通知（P0-3-19 产出）。
 * 语义是"告诉你发现了 N 个新文件"，**确认只代表看到了**，没有业务数据要写 ——
 * 这是**刻意**的空写入，不是"还没实现"。
 */
const materialApplier: MessageApplier = async () => ({
  ok: true,
  summary: '已确认（资料索引通知，无需写入业务数据）',
})

const APPLIERS: Partial<Record<MessageType, MessageApplier>> = {
  material: materialApplier,
}

/** 该类型是否有已接入的 applier —— UI 的「确认」按钮可用性与 API 的 501 判定共用它。 */
export function isApplierReady(type: MessageType): boolean {
  return typeof APPLIERS[type] === 'function'
}

/** 执行写入。未接入的类型返回明确的失败，**绝不假装成功**。 */
export async function applyMessage(ctx: {
  type: MessageType
  payload: MessagePayload
}): Promise<ApplyOutcome> {
  const applier = APPLIERS[ctx.type]
  if (!applier) {
    return {
      ok: false,
      code: 'applier_not_implemented',
      message: `这类提案（${ctx.type}）的写入逻辑还没接入，现在请先「忽略」`,
    }
  }
  return applier(ctx)
}
