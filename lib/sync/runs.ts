import type { SyncStatus, SyncTrigger } from '@/types/sync'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * `sync_runs` 表的唯一映射点（P0-2-5，Database.md §3.11）。
 *
 * 这张表是 Sync-Strategy §13 的调频依据 —— "轮询频率该不该调"靠的就是这里的记录。
 * 因此**每一次真正发起的同步都要留一行**，包括 0 门课、0 变更的那次：
 * "同步跑了但什么都没变"正是判断"轮询在空转"的唯一证据（变更率的分母）。
 *
 * 反过来，**根本没发起的（未连接 / 被锁 / 被节流）不写行** ——
 * 那不是一次同步，写进去会让"我从没同步成功过"的排查被噪声淹没。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** 锁的过期时间：超过这个时长的 running 行视为上次异常终止，不再拦截（Sync-Strategy §5）。 */
export const STALE_RUNNING_MS = 5 * 60 * 1000

/** 一次同步跑完后的统计。 */
export type SyncRunFinish = {
  status: SyncStatus
  coursesSynced: number
  tasksCreated: number
  tasksUpdated: number
  tasksDeleted: number
  /** 面向用户的简短失败原因；成功时为 null。 */
  errorMessage: string | null
}

/**
 * 当前是否有一趟同步还在跑。
 *
 * 只看 `running` 且 `started_at` 在 5 分钟内的行 —— 更老的行说明上次进程
 * 被强制终止（Vercel 超时、部署中断），不该永远把用户锁在外面。
 */
export async function findRunningRun(supabase: SupabaseClient): Promise<boolean> {
  const since = new Date(Date.now() - STALE_RUNNING_MS).toISOString()
  const { data, error } = await supabase
    .from('sync_runs')
    .select('id')
    .eq('status', 'running')
    .gt('started_at', since)
    .limit(1)

  if (error) {
    throw error
  }
  return (data ?? []).length > 0
}

/**
 * 最近一次同步（不论成败）的开始时间，供服务端节流使用。
 *
 * Sync-Strategy §6.4：**节流必须是服务端的**。前端把刷新按钮置灰只是礼貌，
 * 直接打接口的人（以及多标签页）绕得过去，而 Canvas 的限流额度是共享的。
 */
export async function findLastRunStartedAt(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from('sync_runs')
    .select('started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw error
  }
  return data ? (data as { started_at: string }).started_at : null
}

/**
 * 开一趟同步，返回 run id。
 *
 * 先插行再干活，是为了让"同步正在进行中"有一个真实的落点（锁就靠这行判定）；
 * 如果先干活再记账，中途崩溃时锁从来没存在过，并发的第二次同步会照跑。
 */
export async function startRun(
  supabase: SupabaseClient,
  userId: string,
  trigger: SyncTrigger,
): Promise<string> {
  const { data, error } = await supabase
    .from('sync_runs')
    .insert({ user_id: userId, trigger_type: trigger, status: 'running' })
    .select('id')
    .single()

  if (error) {
    throw error
  }
  return (data as { id: string }).id
}

/**
 * 收尾：写入最终状态与统计。
 *
 * 失败也要写（Sync-Strategy §2 S2「失败必须可见」）——
 * 没有这行记录，用户看到的"最后一次成功同步"会是上一次的，等于把故障藏起来。
 */
export async function finishRun(
  supabase: SupabaseClient,
  runId: string,
  finish: SyncRunFinish,
): Promise<void> {
  const { error } = await supabase
    .from('sync_runs')
    .update({
      status: finish.status,
      courses_synced: finish.coursesSynced,
      tasks_created: finish.tasksCreated,
      tasks_updated: finish.tasksUpdated,
      tasks_deleted: finish.tasksDeleted,
      error_message: finish.errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId)

  if (error) {
    throw error
  }
}
