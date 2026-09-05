import {
  assignmentsPath,
  MAX_PAGES_PER_COURSE,
  toCanvasAssignments,
} from '@/lib/canvas/assignments'
import {
  canvasGet,
  isRetryable,
  type CanvasFailureKind,
  type CanvasResult,
} from '@/lib/canvas/client'
import {
  loadDecryptedCredential,
  markCredentialFailed,
  touchCredentialSuccess,
} from '@/lib/canvas/credentials'
import { toSyncStateUpdate } from '@/lib/courses'
import { applyCanvasTasks } from '@/lib/sync/canvas-tasks'
import { findLastRunStartedAt, findRunningRun, finishRun, startRun } from '@/lib/sync/runs'
import type { CanvasAssignment } from '@/types/canvas'
import type { SyncFailure, SyncOutcome, SyncStatus, SyncTrigger, SyncSummary } from '@/types/sync'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * Canvas 同步编排（P0-2-5，Sync-Strategy.md 第 4 / 6 / 8 节）。
 *
 * ### 这份文件负责"调度"，不负责"内容"
 * - 拉什么数据 → `lib/canvas/assignments.ts`
 * - 怎么写库   → `lib/sync/canvas-tasks.ts`
 * - 请求本身   → `lib/canvas/client.ts`（它刻意不重试、不写库）
 * 这里只管：串行、重试、熔断、失败隔离、状态落账。
 *
 * ### 🔴 三条来自实测的硬约束
 * 1. **必须串行，禁止 `Promise.all`** —— Canvas 官方文档：并发请求有
 *    "additional pre-flight penalty"。直觉上"6 门课一起拉更快"是错的（Sync-Strategy §2）。
 * 2. **三级熔断**：单次同步 ≤ 20 个请求、≤ 60 秒、单课 ≤ 3 页。
 *    违反任一 → 停止并标记 `partial`，剩下的课下次再补（Sync-Strategy §6.3）。
 * 3. **401 / 403 绝不重试**，立即把凭证置为 `error` 并停止后续课程（§8）。
 *    对一个被拒绝的 token 重试只会浪费额度，并把真正的故障（token 失效）藏在一堆重试噪声里。
 *
 * ### 与 Sync-Strategy §4 的一处刻意偏离：不做 `upcoming_events` 主扫描
 * 原 pipeline 的第 4 步是"1 个请求拿到全部课程的近期事件"。**本卡跳过它**，理由两条：
 * - 它只返回**未来**的事件。逾期未完成的作业是总览页最该被看见的信号，
 *   走这条路会系统性丢失它们 —— 与 Tempo「不隐藏逾期任务」的原则直接冲突。
 * - 它不带 `updated_at`，做不了 Database.md §4.2 的变更判定，第 5 步的逐课详情
 *   **依然非拉不可**。也就是说那个"1 个请求"省不下来，只是多出一个需要合并的数据源。
 * Phase 0 六门课 7 个请求，远在 20 个的预算内，这个优化此时是净负债。
 * 已在 Sync-Strategy §4 记录（Steven 2026-09-04 拍板）。
 *
 * ### 🔴 日志红线（Security-Privacy 第 8 节）
 * 明文 token 只在 `loadDecryptedCredential()` 的返回值里存在，
 * 不进日志、不进响应、不进异常消息。失败信息里只有状态码与 Canvas 的错误分类。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** Sync-Strategy §5：单次同步 Canvas 请求上限 20 个。 */
const MAX_REQUESTS_PER_SYNC = 20
/** Sync-Strategy §5：单次同步总预算 60 秒（Vercel 上限 300s，留 5 倍余量）。 */
const SYNC_TIME_BUDGET_MS = 60_000
/** Sync-Strategy §8：可重试失败的退避 1s → 4s（指数 + 抖动）。 */
const RETRY_DELAYS_MS = [1_000, 4_000]
/** 429 的等待上限：Canvas 让等 60 秒时不等（会吃掉整个时间预算），留给下一轮。 */
const MAX_RATE_LIMIT_WAIT_MS = 10_000
/** Sync-Strategy §5：手动刷新最小间隔 30 秒。 */
export const MANUAL_THROTTLE_MS = 30_000
/** Sync-Strategy §5：打开应用自动同步最小间隔 60 秒（P0-2-6 会用）。 */
export const APP_OPEN_THROTTLE_MS = 60_000

type CourseTarget = {
  id: string
  courseName: string
  canvasCourseId: string
}

type FetchResult =
  | { ok: true; items: CanvasAssignment[]; complete: boolean }
  | { ok: false; kind: CanvasFailureKind; message: string }

export async function runCanvasSync(
  supabase: SupabaseClient,
  userId: string,
  options: {
    trigger: SyncTrigger
    /** 只同步这几门课（关联成功后按课程触发用）。不传 = 全部已关联课程。 */
    courseIds?: string[]
    /** 节流窗口（毫秒）；0 或 undefined = 不节流。 */
    throttleMs?: number
  },
): Promise<SyncOutcome> {
  const { trigger, courseIds, throttleMs = 0 } = options

  // ---------- 1) 锁：上一次还没跑完 ----------
  if (await findRunningRun(supabase, userId)) {
    return { skipped: 'in_progress', retryAfterSeconds: null }
  }

  // ---------- 2) 凭据 ----------
  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    return { skipped: 'not_connected', retryAfterSeconds: null }
  }
  // status ≠ active 时一个请求都不发 —— 拿一个已知失效的 token 去试是纯浪费（§8）。
  if (credential.status !== 'active') {
    return { skipped: 'credential_inactive', retryAfterSeconds: null }
  }

  // ---------- 3) 目标课程 ----------
  //
  // 🔴 `.eq('user_id', userId)` 是 P0-2-6 第二拍补的：定时同步（T3）传进来的是
  // **service role** 客户端，RLS 不生效。少了这一行，第一个被扫到的用户会把
  // **所有人的已关联课程**都同步一遍（写进自己的库里还带别人的作业）。
  // 用户级客户端下这一行是冗余但无害的，等于把隐式保证变成显式。
  let query = supabase
    .from('courses')
    .select('id, course_name, canvas_course_id')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .not('canvas_course_id', 'is', null)
  if (courseIds && courseIds.length > 0) {
    query = query.in('id', courseIds)
  }
  const { data: courseRows, error: courseError } = await query
  if (courseError) {
    throw courseError
  }

  const targets: CourseTarget[] = ((courseRows ?? []) as {
    id: string
    course_name: string
    canvas_course_id: string | null
  }[])
    .filter((row) => row.canvas_course_id !== null)
    .map((row) => ({
      id: row.id,
      courseName: row.course_name,
      canvasCourseId: row.canvas_course_id as string,
    }))

  if (targets.length === 0) {
    return { skipped: 'no_courses', retryAfterSeconds: null }
  }

  // ---------- 4) 节流：服务端独立校验，不靠前端置灰（§6.4） ----------
  //
  // ⚠️ 位置刻意靠后：节流保护的是 Canvas 的限流额度，**只有当真的要发请求时它才有意义**。
  // 把它排在凭据与课程检查之前会产生两个错误引导：
  //   ① token 已失效 → 用户看到"同步太频繁，27 秒后重试"，而真正该做的是重新生成 token；
  //   ② 没有已关联的课 → 用户以为自己刷新太勤，其实是一发请求都不会发。
  // 排在这里，每种返回都指向用户真正能做的那个动作。
  if (throttleMs > 0) {
    const lastStartedAt = await findLastRunStartedAt(supabase, userId)
    if (lastStartedAt !== null) {
      const elapsed = Date.now() - Date.parse(lastStartedAt)
      if (Number.isFinite(elapsed) && elapsed < throttleMs) {
        return {
          skipped: 'throttled',
          retryAfterSeconds: Math.ceil((throttleMs - elapsed) / 1000),
        }
      }
    }
  }

  // ---------- 5) 开工：先落一行 running，锁才有落点 ----------
  const startedAt = new Date()
  const runId = await startRun(supabase, userId, trigger)
  const budget = { requestsUsed: 0 }
  const now = startedAt.toISOString()

  const failures: SyncFailure[] = []
  let coursesSynced = 0
  let created = 0
  let updated = 0
  let deleted = 0
  let credentialBroken = false

  for (const target of targets) {
    // 凭证已失效：后面的课一个都不再试（§8：停止该用户同步）。
    if (credentialBroken) {
      failures.push({
        courseId: target.id,
        courseName: target.courseName,
        message: 'Canvas 连接已失效，已停止同步，请重新生成 token',
      })
      continue
    }

    // 熔断：请求数或时间超预算 → 剩下的课留到下一轮，不硬撑（§6.3）。
    if (budget.requestsUsed >= MAX_REQUESTS_PER_SYNC || Date.now() - startedAt.getTime() > SYNC_TIME_BUDGET_MS) {
      failures.push({
        courseId: target.id,
        courseName: target.courseName,
        message: '本次同步已达上限，这门课留到下次再同步',
      })
      continue
    }

    const fetched = await fetchCourseAssignments(
      credential.canvasDomain,
      credential.token,
      target.canvasCourseId,
      budget,
      startedAt.getTime(),
    )

    if (!fetched.ok) {
      const message = fetched.message
      if (fetched.kind === 'unauthorized') {
        credentialBroken = true
        await markCredentialFailed(supabase, credential.id, message)
      }
      failures.push({ courseId: target.id, courseName: target.courseName, message })
      await writeCourseState(supabase, target.id, { syncStatus: 'failed', syncError: message, now })
      continue
    }

    const applied = await applyCanvasTasks({
      supabase,
      courseId: target.id,
      assignments: fetched.items,
      now,
      complete: fetched.complete,
    })

    if (!applied.ok) {
      failures.push({
        courseId: target.id,
        courseName: target.courseName,
        message: `作业已拉取但写入失败：${applied.error}`,
      })
      await writeCourseState(supabase, target.id, {
        syncStatus: 'failed',
        syncError: `作业已拉取但写入失败：${applied.error}`,
        now,
      })
      continue
    }

    created += applied.counts.created
    updated += applied.counts.updated
    deleted += applied.counts.deleted
    coursesSynced += 1
    await writeCourseState(supabase, target.id, { syncStatus: 'success', syncError: null, now })
  }

  // ---------- 6) 收尾 ----------
  if (!credentialBroken) {
    await touchCredentialSuccess(supabase, credential.id)
  }

  const status: SyncStatus =
    failures.length === 0 ? 'success' : coursesSynced === 0 ? 'failed' : 'partial'
  const errorMessage = failures.length === 0 ? null : failures[0].message

  await finishRun(supabase, runId, {
    status,
    coursesSynced,
    tasksCreated: created,
    tasksUpdated: updated,
    tasksDeleted: deleted,
    errorMessage,
  })

  const summary: SyncSummary = {
    status,
    coursesSynced,
    coursesFailed: failures.length,
    tasksCreated: created,
    tasksUpdated: updated,
    tasksDeleted: deleted,
    failures,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  }
  return { summary }
}

// ---------- 内部：拉一门课的作业（含翻页） ----------

/**
 * 拉一门课的全部作业，按预算翻页。
 *
 * @param complete false 表示"没拿全"（翻到页数上限 / 请求预算耗尽 / 时间到）。
 *   调用方据此**跳过软删除** —— 一次不完整的拉取会把没拿到的行误判成"外部已删除"。
 */
async function fetchCourseAssignments(
  domain: string,
  token: string,
  externalCourseId: string,
  budget: { requestsUsed: number },
  startedAtMs: number,
): Promise<FetchResult> {
  let path: string | null = assignmentsPath(externalCourseId)
  let pages = 0
  const items: CanvasAssignment[] = []

  while (path !== null) {
    if (pages >= MAX_PAGES_PER_COURSE) return { ok: true, items, complete: false }
    if (budget.requestsUsed >= MAX_REQUESTS_PER_SYNC) {
      return { ok: true, items, complete: false }
    }
    if (Date.now() - startedAtMs > SYNC_TIME_BUDGET_MS) {
      return { ok: true, items, complete: false }
    }

    const result = await requestWithRetry(domain, token, path, budget, startedAtMs)
    if (!result.ok) {
      return { ok: false, kind: result.kind, message: result.message }
    }

    items.push(...result.items)
    pages += 1
    path = result.nextPath
  }

  return { ok: true, items, complete: true }
}

/**
 * 发一个请求，按 Sync-Strategy §8 的表重试。
 *
 * - 5xx / 超时 / 网络 → 最多 2 次，退避 1s → 4s（加抖动，避免多用户同时重试撞车）
 * - 429 → 最多 1 次，等 `Retry-After`（封顶 10s，超过就放弃留给下一轮）
 * - 401/403 / 404 / 解析异常 → **不重试**
 */
async function requestWithRetry(
  domain: string,
  token: string,
  path: string,
  budget: { requestsUsed: number },
  startedAtMs: number,
): Promise<
  | { ok: true; items: CanvasAssignment[]; nextPath: string | null }
  | { ok: false; kind: CanvasFailureKind; message: string }
> {
  let attempt = 0
  let waitMs = 0

  for (;;) {
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    if (Date.now() - startedAtMs > SYNC_TIME_BUDGET_MS) {
      return { ok: false, kind: 'timeout', message: '同步超出时间预算，已停止' }
    }

    budget.requestsUsed += 1
    const result: CanvasResult<unknown> = await canvasGet<unknown>(domain, token, path)

    if (result.ok) {
      return {
        ok: true,
        items: toCanvasAssignments(result.data),
        nextPath: result.nextPath,
      }
    }

    // 不重试的三类：凭证失效 / 资源不存在 / 响应结构异常。
    if (!isRetryable(result.kind) && result.kind !== 'rate_limited') {
      return { ok: false, kind: result.kind, message: result.message }
    }

    const maxRetries = result.kind === 'rate_limited' ? 1 : RETRY_DELAYS_MS.length
    if (attempt >= maxRetries) {
      return { ok: false, kind: result.kind, message: result.message }
    }

    waitMs =
      result.kind === 'rate_limited'
        ? Math.min((result.retryAfterSeconds ?? 5) * 1000, MAX_RATE_LIMIT_WAIT_MS)
        : RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250)
    attempt += 1
  }
}

/**
 * 写回一门课的同步状态。失败不抛 —— 记账失败不该把已经同步好的数据说成失败。
 *
 * 🔴 **`last_synced_at` 只在成功时推进**（P0-2-7 修正，此前失败也写）。
 * `last_synced_at` 在 UI 上的含义是"数据停留在什么时候"。失败时把它写成失败那一刻，
 * 用户看到的就是「最后同步于 1 分钟前」，而屏幕上的其实是三天前的旧数据 ——
 * 这正是 Sync-Strategy §9 明令禁止的"同步失败后继续展示旧数据且不作任何提示"。
 * 失败只记 `sync_status` / `sync_error`，时间留给上一次成功的值。
 */
async function writeCourseState(
  supabase: SupabaseClient,
  courseId: string,
  state: { syncStatus: 'success' | 'failed'; syncError: string | null; now: string },
): Promise<void> {
  const { error } = await supabase
    .from('courses')
    .update(
      toSyncStateUpdate({
        lastSyncedAt: state.syncStatus === 'success' ? state.now : null,
        syncStatus: state.syncStatus,
        syncError: state.syncError,
      }),
    )
    .eq('id', courseId)
    .eq('is_archived', false)

  if (error) {
    console.error('[sync] 写回课程同步状态失败:', courseId, error.message)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
