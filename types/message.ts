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

/**
 * 提案类型。与迁移的 CHECK 约束**必须一致**
 * （`20260917200000_messages.sql` 定前四个，`20260919000000_announcements.sql` 加第五个）。
 *
 * 🔴 加取值要**四处同改**（CodingRules §10.1 第 16 条），漏一处 `toMessage()` 返回 null、
 * 消息在列表里**静默消失**：
 * ① 本文件；② `lib/messages.ts` 的 `MESSAGE_TYPES`；③ 迁移的 CHECK 约束；
 * ④ `scripts/regress-messages.ts` 的断言。
 */
export type MessageType = 'syllabus_drift' | 'practice_test' | 'routine' | 'material' | 'announcement'

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
 *
 * ### P0-3-25 加的四个字段（公告用）
 * - `sourceUrl`：原文链接。公告正文被剥成纯文本之后，**这是唯一能看原貌的路**，
 *   必须存下来（`course_announcements.html_url` 同步写入）。
 * - `announcementId`：指向 `course_announcements.id`。applier 靠它回查正文去解析 ——
 *   不把正文塞进 payload，是因为正文可能很长，而消息栏只读摘要。
 * - `landing`：`true` = 有结构化落点（按钮叫「确认」）；`false` = 纯通知（按钮叫「知道了」）。
 *   判定见 `lib/course-update/landing.ts`。
 */
export type MessagePayload = {
  title: string
  details?: string[]
  courseId?: string
  courseName?: string
  confidence?: 'high' | 'low'
  /** 原文链接（点「原文」跳过去）。没有就是 null —— 绝不编一个链接。 */
  sourceUrl?: string | null
  /** 公告账的 id（`course_announcements.id`）。 */
  announcementId?: string
  /** 有没有结构化落点。 */
  landing?: boolean
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
