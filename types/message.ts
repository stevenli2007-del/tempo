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
 * 合并摘要里的一条公告（P0-3-25 C 口径，2026-09-18 Steven 拍板）。
 *
 * ### 为什么要有它
 * 一轮同步实测 48 条公告、其中 40 条「通知类」（office hours 改了、本周课取消…）。
 * 若每条都独立进消息栏，用户要点 40 次「知道了」—— 与 ADR-016「用户操作量趋零」直接冲突。
 * 于是这 40 条**合并成一条**消息：**「不漏」保住**（用户照样知道老师发了什么，
 * 每条都带原文入口），**操作量从 48 降到 9**（有落点的 8 条各自可写，加这 1 条摘要）。
 *
 * 🔴 合并**只对无落点的公告**生效。有落点的那条一旦被折进摘要，
 * 用户就没法「确认」写入考试 / 成绩构成了 —— 那是能力被藏起来，代价更大。
 */
export type MessageDigestItem = {
  title: string
  courseName?: string
  postedAtLabel?: string
  /** 原文链接。渲染前过 http(s) 白名单（见 `lib/messages/view.ts` 的 `readSafeUrl`）。 */
  sourceUrl?: string | null
}

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
  /**
   * 「通知类公告」的合并摘要（P0-3-25 C 口径）。
   *
   * 只有**无落点**的公告走这条路：它们合并成一条消息，逐条列在这里。
   * 读取侧必须当"可能不存在 / 可能是任何形状"处理（jsonb 无 schema 约束）。
   */
  digest?: MessageDigestItem[]
  /** 条数超过上限（`MAX_DIGEST_ITEMS`）时，没被列进 `digest` 的条数。 */
  digestOverflow?: number
  [key: string]: unknown
}

/**
 * 一条消息的 AI 要点（P0-3-25b，缓存表 `message_summaries`）。
 *
 * ### 🔴 它是**缓存**，不是消息的一部分
 * 要点由模型从公告原文提炼，生成一次就永久复用（公告正文不可变：老师改了内容
 * 会是一条新公告）。所以它不写进 `payload`：payload 是同步的产物，
 * 而这是"事后补上的派生物"，两者混在一起会让"重放同步"和"重算要点"互相踩。
 *
 * ### `status: 'failed'` 的语义是"别再问了"
 * `failed` 的行照样会出现在这里（`points` 为空数组）—— 界面上什么都不画，
 * 但**要点的生成方能看到"这条已经问过了"**，于是不会每次打开消息栏都重打一次模型。
 * 这与 `points: []`（模型说"这条公告没有实质信息"）在界面上长得一样，
 * 但语义不同，所以两个字段都留着。
 */
export type MessageSummary = {
  points: string[]
  /** 实际喂给模型的公告条数。 */
  itemsUsed: number
  /** 这条消息挂着的公告总数。两者不等时界面必须标出覆盖率。 */
  itemsTotal: number
  status: 'ok' | 'failed'
  createdAt: string
}

/** 提案（camelCase，供 UI 使用；snake_case 的列名只出现在 `lib/messages.ts`）。 */
export type Message = {
  id: string
  type: MessageType
  payload: MessagePayload
  status: MessageStatus
  createdAt: string
  /**
   * AI 要点（P0-3-25b）。**可选**，因为两条读取路径的取法不同：
   * - 列表（`loadMessages`）会一并查出来附上 —— 打开消息栏时要立刻看到缓存里的要点，
   *   而不是先画一遍空白再等客户端补（那会闪一下）；
   * - 单条 / PATCH 的返回值不带 —— 已处理的提案只画一行回执，要点在那儿没有位置。
   */
  summary?: MessageSummary | null
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
