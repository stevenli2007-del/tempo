/**
 * 同步对外形状（P0-2-5，API-Contract.md 第 6 节 `POST /api/v1/sync/now`）。
 *
 * 字段一律 camelCase（Database.md 第 1 节）；snake_case 只出现在 `lib/sync/` 的映射层。
 */

/**
 * 一次同步的结果状态。
 *
 * 取值与 `sync_runs.status` 的 CHECK 约束对齐，但**不含 `running`** ——
 * `running` 是库内部的中间态，不会出现在任何响应里。
 */
export type SyncStatus = 'success' | 'partial' | 'failed'

/**
 * 触发来源。取值与 `sync_runs.trigger_type` 的 CHECK 约束一致。
 *
 * Phase 0 的 P0-2-5 只会用到 `manual`（`POST /sync/now`）与 `link`
 * 两条路径；`app_open` / `scheduled` 等 P0-2-6 的刷新机制接上后才会出现。
 */
export type SyncTrigger = 'app_open' | 'manual' | 'scheduled'

/** 单门课的失败原因。文案是给用户看的（Sync-Strategy §9：人话，不是堆栈）。 */
export type SyncFailure = {
  courseId: string
  courseName: string
  message: string
}

/**
 * 公告同步的记账（P0-3-25，Sync-Strategy §14）。
 *
 * ### 为什么单独一块，而不是塞进 `failures`
 * `SyncFailure` 的每一项都是**某一门课**的失败，而公告走的是**批量**端点 ——
 * 一次请求覆盖所有课，失败也不是某一门课的问题。硬塞进去会让
 * `coursesFailed` 虚高（"6 门课里 1 门失败"其实是"公告那次请求挂了"），
 * 用户看到的归因就是错的。
 *
 * ### 为什么公告失败不改 `status`
 * 公告是**附加**能力。它挂掉时把整次同步判成 `partial`，用户会以为作业也没同步上，
 * 而其实作业好好的 —— 这是误报。所以失败只记在这里 + `sync_runs.error_message`，
 * **不伪装成成功、也不冤枉作业**。
 */
export type SyncAnnouncementSummary = {
  status: 'success' | 'failed'
  /** 本轮从 Canvas 拿到的公告条数（去重前）。 */
  scanned: number
  /**
   * 新进消息栏的**消息**条数（C 口径：有落点的逐条 + 无落点的摘要 1 条）。
   *
   * ⚠️ 这是"消息"不是"公告"：48 条公告可能只产出 9 条消息。
   * 想对"公告都进来了吗"的账请用 `created + digested`（无落点的那批折进摘要里，
   * 逐条通道与摘要通道一一对应，不重不漏）。
   */
  created: number
  /**
   * 被折进**摘要**（不是各自建消息）的公告条数 —— C 口径的产物（2026-09-18 Steven 拍板）。
   *
   * 为什么要单独记：`created` 只数消息，光看它会让"40 条通知类合并成 1 条"
   * 看起来像"只收到 1 条公告"。两个数一起才是完整账：
   * `created` 是用户要点几次，`digested` 是这批摘要里装了多少条。
   */
  digested: number
  /** 已在账上、本轮重复覆盖的条数（滚动窗口的正常现象）。 */
  seen: number
  /**
   * 本轮的查询窗口（`YYYY-MM-DD`，含端点）。
   *
   * 为什么要透出来：窗口是**动态**的（起点 = 上次成功同步那天，见
   * `lib/canvas/announcements.ts` 的 `announcementWindow`），
   * 而"这一轮到底抓了哪一段"是验收与排障时第一个要问的问题。
   * 只报条数的话，"今天怎么只有 2 条"和"窗口算错了"分不开。
   */
  windowStart: string
  windowEnd: string
  /** 拉取没拿全（翻页 / 预算 / 时间触顶）。 */
  incomplete: boolean
  /** 失败说明；null = 成功。 */
  error: string | null
}

/**
 * 资料索引（Canvas 文件元数据）的记账（P0-3-19）。
 *
 * ### 为什么又是一块独立的 summary
 * 与 `SyncAnnouncementSummary` 同一个道理：资料区是**附加能力**，且它的失败
 * **绝大多数是正常的**（详见下）—— 塞进 `failures` 会让 `coursesFailed` 虚高，
 * 用户看到"6 门课里 5 门同步失败"，而其实作业全好。
 *
 * ### 🔴 `coursesSkipped` 通常**不是**故障
 * 实测（2026-09-18，Steven 真账号）：14 门课里 **8 门** `/files` 返回 **403**
 * —— 这些课压根没开 Files 区（Assessment Pilot / GBA / Hazing Prevention /
 * PartySafe / SHAPE …），同一个 token 打它们的 `/assignments` 与 `/folders` 全是 200。
 * 所以「跳过」是本功能的**常态结果**，不是错误。真正要报警的是
 * `error`（端点整片挂掉 / 写库失败），而不是"有几门课没资料"。
 */
export type SyncFileSummary = {
  status: 'success' | 'failed'
  /** 本轮真正扫了资料的课程数。 */
  coursesScanned: number
  /**
   * 被跳过的课程数（**正常现象，不是失败**）：
   * ① 这门课没开 Files 区（`/files` 403）；
   * ② 24 小时内刚扫过（预算保护，见 `FILES_SCAN_INTERVAL_MS`）。
   */
  coursesSkipped: number
  /** 新索引到的文件数。 */
  created: number
  /** 元数据有变化而更新的文件数（改名 / 移动 / 内容更新）。 */
  updated: number
  /**
   * 因为**落在学生看不见的文件夹里**而没被索引的文件数。
   * Chem 1AL 实测 55 个文件夹里 24 个是 hidden（教师区）——
   * 这批数字不为 0 是**正常且正确**的，不是漏数据。
   */
  hiddenSkipped: number
  /** 老师在 Canvas 上删掉而软删除的文件数（不是物理删除）。 */
  deleted: number
  /**
   * 是否有课程的拉取**不完整**（翻页触顶 / 预算耗尽）。
   * 为 true 时那一门课**不做删除判定** —— 不完整的拉取会把没拿到的行误判成"已删除"。
   */
  incomplete: boolean
  /** 失败说明；`null` = 成功。 */
  error: string | null
}

export type SyncSummary = {
  status: SyncStatus
  /** 成功同步的课程数。 */
  coursesSynced: number
  /** 失败的课程数。 */
  coursesFailed: number
  tasksCreated: number
  tasksUpdated: number
  /** 外部源删除而软删除的任务数（不是物理删除）。 */
  tasksDeleted: number
  /** 失败的课程明细。全部成功时为空数组。 */
  failures: SyncFailure[]
  /**
   * 公告同步结果。`null` = 本轮没跑公告（凭证失效 / 没有已关联课程）。
   * 与 `failures` 分开的理由见 `SyncAnnouncementSummary`。
   */
  announcements: SyncAnnouncementSummary | null
  /**
   * 资料索引结果。`null` = 本轮没跑资料区（凭证失效 / 没有已关联课程）。
   * 与 `failures` 分开的理由见 `SyncFileSummary`。
   */
  files: SyncFileSummary | null
  startedAt: string
  finishedAt: string
}

/**
 * 同步没跑起来的原因。
 *
 * **刻意与 `SyncStatus` 分开**：这些都是"根本没发请求"的情形，
 * 不是一种同步结果 —— 把它们塞进 `status` 会污染 `sync_runs.status` 的取值，
 * 也会让 UI 把"没连接 Canvas"和"同步失败"画成同一种东西（Sync-Strategy §9
 * 明确要求 `never` 引导连接数据源，而不是显示"同步失败"）。
 */
export type SyncSkipReason =
  /** 没存 Canvas 凭据。 */
  | 'not_connected'
  /** 凭据状态不是 active（expired / revoked / error）。 */
  | 'credential_inactive'
  /** 凭据已过期（expires_at < now，P0-2-8）：跳过定时同步，不浪费请求。 */
  | 'credential_expired'
  /** 上一次同步还在跑（5 分钟锁）。 */
  | 'in_progress'
  /** 距上次同步太近，被服务端节流拦下。 */
  | 'throttled'
  /** 没有任何已关联 Canvas 且未归档的课程。 */
  | 'no_courses'

export type SyncOutcome =
  | { skipped: SyncSkipReason; retryAfterSeconds: number | null }
  | { summary: SyncSummary }
