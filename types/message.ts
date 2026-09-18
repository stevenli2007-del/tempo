/**
 * P0-3-18 消息栏：系统提案消息。
 *
 * ### 为什么表里只有「系统提案」，没有「用户消息」
 * 2026-09-17 Steven 拍板：用户自己的更新**不落这张表**。
 * 「HW7 截止改到 9/20」这类输入，效果落在 `tasks`（那才是数据），
 * 不留成一条聊天记录 —— 一旦落成聊天记录，就得面对回放 / 编辑 / 删除的期待，
 * 而浮窗对话框（P0-3-8b）本来就是「说完即走、零留存」，两边行为一致才没有落差。
 *
 * ### 提案的生命周期
 * `pending` → 「确认」→ `accepted` ／ 「忽略」→ `dismissed`。
 * 🔴 本表**不写任何业务数据**：`accepted` 只代表"用户批准了"，
 * 真正的写入由 applier 执行（`lib/messages/apply.ts`，ADR-015「确认才写」）。
 */

/** 提案类型。与迁移 `20260917200000_messages.sql` 的 CHECK 约束**必须一致**。 */
export type MessageType = 'syllabus_drift' | 'practice_test' | 'routine' | 'material'

/** 提案状态。同上，与迁移的 CHECK 约束一致。 */
export type MessageStatus = 'pending' | 'accepted' | 'dismissed'

/**
 * 提案载荷的**最小契约**（P0-3-18 定义，后续卡按此产出）。
 *
 * 本卡是「全站系统提案的唯一出口」，所以载荷的公共形状定在这里，
 * 避免 3-19 / 3-20 / 3-23 各发一套。各类型自己的字段放 `extra`，本表不做 schema 校验。
 *
 * - `title`：一句话摘要，**直接渲染成消息标题**（必填 —— 没有标题的提案等于没说话）。
 * - `details`：细节行，一行一句（如「Unit 3 Exam 从 10/20 → 10/27」）。
 * - `confidence`：抽取出处不可靠时（扫描件 PDF 等）标 `low`。
 *   🔴 `low` **不许一键接受** —— 见 `lib/messages/view.ts` 的 `canAccept`。
 */
export type MessagePayload = {
  title: string
  details?: string[]
  courseId?: string
  courseName?: string
  confidence?: 'high' | 'low'
  [key: string]: unknown
}

/** 提案（camelCase，供 UI 使用；snake_case 的列名只出现在 `lib/messages.ts`）。 */
export type Message = {
  id: string
  type: MessageType
  payload: MessagePayload
  status: MessageStatus
  createdAt: string
}

/** `messages` 表在数据库中的行（与 Database.md / 迁移一致）。 */
export type MessageRow = {
  id: string
  user_id: string
  type: string
  payload: unknown
  status: string
  created_at: string
}
