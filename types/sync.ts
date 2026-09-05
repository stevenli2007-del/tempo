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
