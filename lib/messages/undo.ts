import type { ApplierReadyType } from '@/lib/messages/registry'
import type { ApplierSupabase } from '@/lib/messages/apply'
import { announcementUndoer } from '@/lib/messages/undoers/announcement'
import { syllabusDriftUndoer } from '@/lib/messages/undoers/syllabus-drift'
import type { MessagePayload, MessageType } from '@/types/message'

/**
 * 提案的「撤销」注册表（P0-3-26）。
 *
 * ### 与 `apply.ts` 的 APPLIERS 对称
 * 确认写什么，撤销就回滚什么。键同样取自 `APPLIER_READY_TYPES`（`satisfies` 强制一致），
 * 不会出现"写了却不能撤"或"撤了却没写过"的分叉。
 *
 * ### 🔴 只作服务端调用（与 applier 同）
 * 撤销要删 `exam_dates` / `grade_components` 并调 `syncExamToTask` —— 全是写操作，
 * 只有 `PATCH /api/v1/messages/:id` 的撤销分支会 import 本文件，**绝不**进客户端组件链。
 *
 * ### 撤销的纪律（与写入同一套红线）
 * - **按 id 精准删**，绝不 `delete().eq('course_id', …)` 整表清空；
 * - 考试删完**必须重跑 `syncExamToTask`**（ADR-004 唯一派生实现），否则派生任务孤儿滞留；
 * - 删 0 行不报失败（可能已被手动删过，那是目标状态），但留日志；
 * - 任一步失败 → 返回明确失败，**绝不假装撤销成功**（ADR-016 R3）。
 */
export type UndoOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string }

export type UndoContext = {
  type: MessageType
  payload: MessagePayload
  supabase: ApplierSupabase
  userId: string
}

export type MessageUndoer = (ctx: UndoContext) => Promise<UndoOutcome>

/** 没有业务数据可撤的类型（如 material）。 */
const materialUndoer: MessageUndoer = async () => ({ ok: true })

/**
 * 同上（P0-3-23）。practice_test 的确认是空写入 → 没有行可回滚。
 *
 * ⚠️ 这不是"能撤但撤不出东西"：`appliedCount` 为 0 时界面**根本不显示撤销按钮**
 * （见 `messages-view.tsx` 的 `canUndo`），这个空撤销器只是为了满足
 * `satisfies Record<ApplierReadyType, MessageUndoer>` 的键一致。
 */
const practiceTestUndoer: MessageUndoer = async () => ({ ok: true })

/**
 * 加载器表（与 APPLIERS 同形）。这里不需要动态 import（撤销只在服务端跑，
 * 不存在"把服务端依赖拖进客户端图"的问题），直接静态引用。
 */
const UNDOERS = {
  material: materialUndoer,
  practice_test: practiceTestUndoer,
  announcement: announcementUndoer,
  // ⚠️ 3-20 的撤销器与公告那一个**本质不同**：漂移里有 update（改期），
  // 撤销要按确认时留下的旧值快照写回去，不能按 id 删。见 `undoers/syllabus-drift.ts`。
  syllabus_drift: syllabusDriftUndoer,
} satisfies Record<ApplierReadyType, MessageUndoer>

/** 宽化后的索引视图。 */
const UNDOERS_BY_TYPE = UNDOERS as Partial<Record<MessageType, MessageUndoer>>

/** 执行撤销。未接入的类型（理论上不会发生，因为键与 APPLIER_READY_TYPES 一致）返回明确失败。 */
export async function undoMessage(ctx: UndoContext): Promise<UndoOutcome> {
  const undoer = UNDOERS_BY_TYPE[ctx.type]
  if (!undoer) {
    return {
      ok: false,
      code: 'undo_not_implemented',
      message: `这类提案（${ctx.type}）没有可撤销的写入`,
    }
  }
  return undoer(ctx)
}
