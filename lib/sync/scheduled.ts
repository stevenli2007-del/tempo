import type { SyncSkipReason } from '@/types/sync'

import { runCanvasSync } from '@/lib/sync/canvas-sync'
import type { createServiceRoleClient } from '@/lib/supabase/admin'

/**
 * T3 平台定时兜底：遍历全部有效凭据用户，逐个串行同步（P0-2-6 第二拍）。
 *
 * Sync-Strategy §3：T3 的存在意义是"捕捉用户没打开期间的变化"，**不是**新鲜度的主力
 * （那是 T1 打开应用时同步）。所以这里刻意做得保守：一天两次、串行、有总时间预算。
 *
 * ### 🔴 这个文件的客户端是 service role，**绕过了 RLS**
 * 因此所有用户隔离都必须在 `runCanvasSync` 内部靠显式 `user_id` 过滤完成
 * （P0-2-6 第二拍已给凭据 / 锁 / 节流 / 课程四处查询补上）。
 * 改动同步编排时如果新增了查询，**必须带上 user_id 条件**，否则就是跨用户串数据。
 *
 * ### 三个容错原则
 * 1. **一个用户失败不影响其他用户** —— 每人独立 try/catch，失败只记账继续走。
 * 2. **超预算就停**，剩下的用户留到下一次 cron（Vercel 函数上限 300 秒，
 *    这里给 240 秒，留 60 秒余量；单用户同步自身还有 60 秒预算）。
 * 3. **响应体里不出现任何用户的具体数据**（API-Contract §6）——
 *    聚合计数 + 错误消息，user_id 只进服务端日志，不进响应。
 */

type AdminSupabase = ReturnType<typeof createServiceRoleClient>

/** 整批的总时间预算（毫秒）。Vercel 函数上限 300s，留 60s 余量。 */
const TOTAL_TIME_BUDGET_MS = 240_000

export type ScheduledSkipCounts = Record<SyncSkipReason, number>

export type ScheduledSyncReport = {
  startedAt: string
  finishedAt: string
  durationMs: number
  /** 有效凭据用户数（去重后）。 */
  usersTotal: number
  /** 真正跑完一趟同步的用户数（含同步出失败课程的用户）。 */
  usersSynced: number
  /** 同步过程抛异常的用户数（不是同步失败，是代码/数据库层出错）。 */
  usersFailed: number
  /** 因各种前置条件被跳过的用户数，按原因分列。 */
  usersSkipped: ScheduledSkipCounts
  /** 超出总时间预算、留到下一轮的用户数。 */
  usersDeferred: number
  coursesSynced: number
  coursesFailed: number
  tasksCreated: number
  tasksUpdated: number
  tasksDeleted: number
  /** 只含错误消息，**不含 user_id / 课程名**（契约 §6：不返回任何用户的具体数据）。 */
  failures: string[]
}

function emptySkipCounts(): ScheduledSkipCounts {
  return {
    not_connected: 0,
    credential_inactive: 0,
    in_progress: 0,
    throttled: 0,
    no_courses: 0,
  }
}

/**
 * 扫一遍全部有效凭据用户并同步。
 *
 * **不做节流**（`throttleMs` 不传）：T3 一天只跑两次，节流保护的是"用户狂点按钮"
 * 这种场景，定时扫描不存在这个问题。真要防重复，靠的是 `sync_runs` 的 5 分钟锁
 * （`findRunningRun`）—— 同一用户上一趟没跑完会被跳过。
 */
export async function runScheduledSync(supabase: AdminSupabase): Promise<ScheduledSyncReport> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs)

  const { data, error } = await supabase
    .from('canvas_credentials')
    .select('user_id')
    .eq('status', 'active')

  if (error) {
    throw error
  }

  // 一个用户理论上只有一行凭据（UNIQUE 约束），去重是为了不把约束的可靠性当前提：
  // 万一将来放宽成"一人多凭据"，这里重复跑同一个用户就是给 Canvas 送双倍请求。
  const userIds = [
    ...new Set(
      ((data ?? []) as { user_id: string }[]).map((row) => row.user_id).filter(Boolean),
    ),
  ]

  const skipped = emptySkipCounts()
  const failures: string[] = []
  let usersSynced = 0
  let usersFailed = 0
  let usersDeferred = 0
  let coursesSynced = 0
  let coursesFailed = 0
  let tasksCreated = 0
  let tasksUpdated = 0
  let tasksDeleted = 0

  for (const userId of userIds) {
    // 总预算：时间到就停，剩下的下次 cron 再扫（不硬撑到函数超时被强杀）。
    if (Date.now() - startedAtMs > TOTAL_TIME_BUDGET_MS) {
      usersDeferred += 1
      continue
    }

    try {
      const outcome = await runCanvasSync(supabase, userId, { trigger: 'scheduled' })

      if ('skipped' in outcome) {
        skipped[outcome.skipped] += 1
        continue
      }

      usersSynced += 1
      coursesSynced += outcome.summary.coursesSynced
      coursesFailed += outcome.summary.coursesFailed
      tasksCreated += outcome.summary.tasksCreated
      tasksUpdated += outcome.summary.tasksUpdated
      tasksDeleted += outcome.summary.tasksDeleted

      if (outcome.summary.failures.length > 0) {
        failures.push(...outcome.summary.failures.map((failure) => failure.message))
      }
    } catch (error_) {
      // 一个用户炸了不能连累其他用户。user_id 只进日志（排障要能定位到人），不进响应。
      usersFailed += 1
      const message = error_ instanceof Error ? error_.message : String(error_)
      console.error('[sync:scheduled] 用户同步异常:', userId, message)
      failures.push(message)
    }
  }

  const finishedAtMs = Date.now()
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    usersTotal: userIds.length,
    usersSynced,
    usersFailed,
    usersSkipped: skipped,
    usersDeferred,
    coursesSynced,
    coursesFailed,
    tasksCreated,
    tasksUpdated,
    tasksDeleted,
    failures,
  }
}
