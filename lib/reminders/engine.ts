import type { TaskRow } from '@/lib/tasks'
import { TASK_COLUMNS, toTask } from '@/lib/tasks'
import type { Task } from '@/types/task'
import type { createClient } from '@/lib/supabase/server'
import { generateUnsubToken } from './token'
import { buildReminderEmail } from './build'
import { sendReminderEmail } from './send'

/**
 * 提醒引擎（P0-3-14，出站体系）。
 *
 * ### 🔴 这个文件的客户端是 service role，绕过了 RLS（同 sync/scheduled、email/inbound）
 * 因此**每一条查询都显式带 user_id / course_id**，绝不靠 RLS 隐式隔离（admin.ts 红线 #3）。
 * 尤其不能用 `loadActiveCourseIds()` —— 那套靠 RLS 按当前用户过滤，换成 service role 会
 * 把全部用户的课程都捞出来（静默串数据）。这里课程的 user_id 过滤全部手写。
 *
 * ### 三条产品纪律（ADR-016 / ADR-017）
 * 1. **准确优先于频繁**：只发"有逾期或即将到期任务"的邮件；否则不发，也不更新时间戳。
 * 2. **频控**：每用户每天至多一封（last_reminder_at 距现在 < 24h 直接跳过）。
 * 3. **绝不误报**：邮件只列 `status='pending'` 的任务，已完成的永远不出现。
 */

/** service role 客户端类型（与 `lib/tasks.ts` 的 ServerSupabase 同款 —— admin 客户端被 cast 成它）。 */
type AdminSupabase = Awaited<ReturnType<typeof createClient>>

/** 一天毫秒数（频控窗口）。 */
const DAY_MS = 86_400_000

/** 整批定时提醒的总时间预算（毫秒）。Vercel 函数上限 300s，留 60s 余量。 */
const TOTAL_TIME_BUDGET_MS = 240_000

/** 应用基础 URL（退订链接用）。生产固定值，可用 APP_BASE_URL 覆盖（本地预览）。 */
function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'https://tempo-six-neon.vercel.app'
}

/** 单用户提醒结果（供调用方记账 / 手动端点回显）。 */
export type ReminderResult = {
  userId: string
  /** 是否真的发出了邮件。 */
  sent: boolean
  /** 未发送的原因（sent=false 时有效）。 */
  reason?: 'disabled' | 'recent' | 'no_actionable' | 'no_tasks' | 'no_email' | 'send_failed' | 'preview'
  /** preview 或调试时回带的邮件内容（含 subject/html/text）。 */
  email?: { subject: string; html: string; text: string; actionable: boolean; totalCount: number }
}

export type BuildAndSendOptions = {
  /** 预览：只组装邮件、不发送、不更新时间戳、不卡开关/频控。用于手动自测。 */
  preview?: boolean
  /** 强制：跳过 disabled / recent 闸门（定时扫描永远不传；手动端点 preview 时自动为真）。 */
  force?: boolean
}

/**
 * 为单个用户组装（并可选发送）提醒邮件。
 *
 * 流程：读 profile 开关/时间戳 → 取收件邮箱 → 取未归档课程 → 取 pending 任务 →
 * 可行动判定 → 组装邮件 → （非预览且可行动时）发送 + 更新 last_reminder_at。
 */
export async function buildAndSendReminder(
  admin: AdminSupabase,
  userId: string,
  options: BuildAndSendOptions = {},
): Promise<ReminderResult> {
  const { preview = false, force = false } = options

  // 1) profile：开关 / 上次发送 / 退订 token / 时区。显式按 id。
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('reminder_enabled, last_reminder_at, reminder_unsub_token, timezone')
    .eq('id', userId)
    .maybeSingle()
  if (profileError) {
    console.error('[reminder] 读 profile 失败:', profileError.message)
    return { userId, sent: false, reason: 'no_tasks' }
  }
  if (!profile) {
    return { userId, sent: false, reason: 'no_tasks' }
  }

  // 2) 闸门：关闭 / 24h 内已发（preview 与 force 都跳过）。
  if (!force && profile.reminder_enabled === false) {
    return { userId, sent: false, reason: 'disabled' }
  }
  if (!force && profile.last_reminder_at && Date.now() - Date.parse(profile.last_reminder_at) < DAY_MS) {
    return { userId, sent: false, reason: 'recent' }
  }

  // 3) 收件邮箱（在 auth.users，service role 可读）。
  const { data: authUser } = await admin.auth.admin.getUserById(userId)
  const email = authUser?.user?.email
  if (!email) {
    console.warn('[reminder] 用户无邮箱，跳过:', userId)
    return { userId, sent: false, reason: 'no_email' }
  }

  // 4) 未归档课程（**显式 user_id**，service role 下不能靠 RLS）。
  const { data: courseRows, error: courseError } = await admin
    .from('courses')
    .select('id, course_name')
    .eq('user_id', userId)
    .eq('is_archived', false)
  if (courseError) {
    console.error('[reminder] 读课程失败:', courseError.message)
    return { userId, sent: false, reason: 'no_tasks' }
  }
  const courses = ((courseRows ?? []) as { id: string; course_name: string }[]).filter((c) => c.id)
  if (courses.length === 0) {
    return { userId, sent: false, reason: 'no_tasks' }
  }
  const courseIds = courses.map((c) => c.id)
  const courseNames = new Map(courses.map((c) => [c.id, c.course_name]))

  // 5) pending 任务（**显式 course_id 集合**，不靠 RLS）。按 due_date 升序（null 最后）。
  const { data: taskRows, error: taskError } = await admin
    .from('tasks')
    .select(TASK_COLUMNS)
    .in('course_id', courseIds)
    .eq('is_deleted', false)
    .eq('status', 'pending')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
  if (taskError) {
    console.error('[reminder] 读任务失败:', taskError.message)
    return { userId, sent: false, reason: 'no_tasks' }
  }
  if (!taskRows || (taskRows as TaskRow[]).length === 0) {
    return { userId, sent: false, reason: 'no_tasks' }
  }
  const tasks: Task[] = (taskRows as TaskRow[]).map((row) => toTask(row, courseNames.get(row.course_id) ?? ''))

  // 6) 退订 token（首次发送时懒生成并写回；查询已带 user_id，更新按 id）。
  let unsubToken = profile.reminder_unsub_token
  if (!unsubToken) {
    unsubToken = generateUnsubToken()
    const { error: tokError } = await admin
      .from('profiles')
      .update({ reminder_unsub_token: unsubToken })
      .eq('id', userId)
    if (tokError) {
      console.error('[reminder] 写退订 token 失败（仍继续发送）:', tokError.message)
    }
  }
  const unsubscribeUrl = `${getAppBaseUrl()}/api/v1/reminders/unsubscribe?t=${unsubToken}`

  // 7) 组装邮件。
  const built = buildReminderEmail({
    tasks,
    timezone: profile.timezone ?? 'America/Los_Angeles',
    now: new Date(),
    unsubscribeUrl,
  })

  // 预览：只回带内容，不发送、不更新时间戳。
  if (preview) {
    return {
      userId,
      sent: false,
      reason: 'preview',
      email: {
        subject: built.subject,
        html: built.html,
        text: built.text,
        actionable: built.actionable,
        totalCount: built.totalCount,
      },
    }
  }

  // 8) 无「可行动」任务 → 不发（也不更新时间戳，留待有任务的那天再发）。
  if (!built.actionable) {
    return {
      userId,
      sent: false,
      reason: 'no_actionable',
      email: {
        subject: built.subject,
        html: built.html,
        text: built.text,
        actionable: built.actionable,
        totalCount: built.totalCount,
      },
    }
  }

  // 9) 发送（失败软降级）。
  const sendResult = await sendReminderEmail({
    to: email,
    subject: built.subject,
    html: built.html,
    text: built.text,
  })
  if (!sendResult.ok) {
    return { userId, sent: false, reason: 'send_failed' }
  }

  // 10) 发送成功 → 记录时间戳（频控依据）。
  const { error: tsError } = await admin
    .from('profiles')
    .update({ last_reminder_at: new Date().toISOString() })
    .eq('id', userId)
  if (tsError) {
    console.error('[reminder] 更新 last_reminder_at 失败（不影响本次已发送）:', tsError.message)
  }

  return { userId, sent: true }
}

// ---------- 定时批量入口（service role，镜像 sync/scheduled） ----------

export type ReminderSkipCounts = {
  disabled: number
  recent: number
  no_actionable: number
  no_tasks: number
  no_email: number
}

export type ScheduledReminderReport = {
  startedAt: string
  finishedAt: string
  durationMs: number
  /** 开启提醒的用户数（reminder_enabled = true）。 */
  usersTotal: number
  /** 真正发出邮件的用户数。 */
  usersReminded: number
  /** 因各类前置条件被跳过的用户数，按原因分列。 */
  usersSkipped: ReminderSkipCounts
  /** 发送失败（Worker/网络问题）的用户数。 */
  usersFailed: number
  /** 超出总时间预算、留到下一轮的用户数。 */
  usersDeferred: number
  /** 只含错误消息，不含 user_id / 邮箱（契约 §6：不返回任何用户具体数据）。 */
  failures: string[]
}

function emptySkipCounts(): ReminderSkipCounts {
  return { disabled: 0, recent: 0, no_actionable: 0, no_tasks: 0, no_email: 0 }
}

/**
 * 遍历全部开启提醒的用户并发送（T3 同款定时兜底）。
 *
 * 三个容错原则与 `runScheduledSync` 一致：单用户失败不影响其他；超预算就停；
 * 响应不出现任何用户具体数据。
 */
export async function runScheduledReminders(admin: AdminSupabase): Promise<ScheduledReminderReport> {
  const startedAtMs = Date.now()

  const { data, error } = await admin
    .from('profiles')
    .select('id')
    .eq('reminder_enabled', true)
  if (error) {
    throw error
  }
  const userIds = ((data ?? []) as { id: string }[]).map((r) => r.id).filter((id) => id)

  const skipped = emptySkipCounts()
  const failures: string[] = []
  let usersReminded = 0
  let usersFailed = 0
  let usersDeferred = 0

  for (const userId of userIds) {
    if (Date.now() - startedAtMs > TOTAL_TIME_BUDGET_MS) {
      usersDeferred += 1
      continue
    }
    try {
      const result = await buildAndSendReminder(admin, userId)
      if (result.sent) {
        usersReminded += 1
      } else {
        switch (result.reason) {
          case 'disabled':
            skipped.disabled += 1
            break
          case 'recent':
            skipped.recent += 1
            break
          case 'no_actionable':
            skipped.no_actionable += 1
            break
          case 'no_tasks':
            skipped.no_tasks += 1
            break
          case 'no_email':
            skipped.no_email += 1
            break
          default:
            // preview / send_failed 不该出现在定时路径里；send_failed 记失败。
            if (result.reason === 'send_failed') {
              usersFailed += 1
            }
        }
      }
    } catch (error_) {
      usersFailed += 1
      const message = error_ instanceof Error ? error_.message : String(error_)
      console.error('[reminder:scheduled] 用户提醒异常:', userId, message)
      failures.push(message)
    }
  }

  const finishedAtMs = Date.now()
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    usersTotal: userIds.length,
    usersReminded,
    usersSkipped: skipped,
    usersFailed,
    usersDeferred,
    failures,
  }
}
