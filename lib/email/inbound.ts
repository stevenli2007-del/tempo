import type { TaskCandidate } from '@/types/task'

import { createServiceRoleClient } from '@/lib/supabase/admin'

import { extractTokenFromAddress } from './token'
import { parseInboundEmail } from './parse'
import { decideInboundAction } from './plan'

/**
 * 邮件入站编排（P0-3-11，ADR-019：纯入站 + 密址绑定）。
 *
 * ### 🔴 为什么这里用 service role（admin.ts 红线 #3 的合规用法）
 * 入站 webhook 是**服务器对服务器**调用，没有用户会话（拿不到 cookie），
 * 但又必须代表某用户改他的任务。token 已解析出 `user_id`，因此**每一条查询都显式
 * 带上该 user_id 派生出的 `course_id` 集合**（red line #3），绝不靠 RLS 隐式隔离。
 * 这与「定时同步」「运营指标」同属 admin.ts 列举的服务端无会话场景，是第五类合规用途。
 *
 * ### 落写纪律（红线）
 * 邮件**只写 `status='done'`**；绝不写 `submission_state` / `submitted_at`
 * （那两列只有 Canvas 同步可写，ADR-015）。且只改 token 解析出的用户**已有的**任务，
 * 绝不新建任务 / 绝不自动改 dueDate。
 */

export type InboundInput = {
  to: string
  from: string
  subject: string | null
  textBody: string | null
}

export type InboundOutcome =
  | { status: 'unknown_address' }
  | { status: 'no_text' }
  | { status: 'parse_failed'; reason: string }
  | { status: 'processed'; action: 'mark_done' | 'none'; taskId?: string; event?: string; reason?: string }

const MIN_TEXT_LENGTH = 3

export async function handleInboundEmail(input: InboundInput): Promise<InboundOutcome> {
  const token = extractTokenFromAddress(input.to)
  if (!token) {
    return { status: 'unknown_address' }
  }

  const admin = createServiceRoleClient()

  // 1) 用 token 定位用户（token 即身份，不依赖发件人）。
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id')
    .eq('inbound_token', token)
    .maybeSingle()
  if (profileError) {
    console.error('[inbound] 查询 inbound_token 失败:', profileError.message)
    return { status: 'unknown_address' }
  }
  if (!profile) {
    return { status: 'unknown_address' }
  }
  const userId = profile.id

  // 2) 该用户的未归档课程（任务可见性收口点，与 tasks.ts 一致）。
  const { data: courseRows, error: courseError } = await admin
    .from('courses')
    .select('id')
    .eq('user_id', userId)
    .eq('is_archived', false)
  if (courseError) {
    console.error('[inbound] 查询课程失败:', courseError.message)
    return { status: 'unknown_address' }
  }
  const courseIds = ((courseRows ?? []) as { id: string }[]).map((r) => r.id)

  // 3) 全部候选任务（跨课程，匹配时自然归到正确的那条）。
  // 带上 `status`：完全相等可能命中多条同名任务（真实数据里 `Homework 7` 就有两条），
  // 决策层要靠它挑出"还没完成的那条"，见 plan.ts。
  let candidates: TaskCandidate[] = []
  if (courseIds.length > 0) {
    const { data: taskRows } = await admin
      .from('tasks')
      .select('id, title, due_date, task_type, source, is_derived, status')
      .in('course_id', courseIds)
      .eq('is_deleted', false)
    candidates = ((taskRows ?? []) as Array<{
      id: string
      title: string
      due_date: string | null
      task_type: string
      source: string
      is_derived: boolean
      status: string
    }>).map((r) => ({
      id: r.id,
      title: r.title,
      dueDate: r.due_date,
      taskType: r.task_type as TaskCandidate['taskType'],
      source: r.source as TaskCandidate['source'],
      isDerived: r.is_derived,
      status: r.status as TaskCandidate['status'],
    }))
  }

  const text = input.textBody?.trim() ?? ''
  if (text.length < MIN_TEXT_LENGTH) {
    return { status: 'no_text' }
  }

  // 4) LLM 解析（文本档，DeepSeek）。
  const parsed = await parseInboundEmail({ userId, text })
  if (!parsed.ok) {
    await logEvent(admin, {
      userId,
      from: input.from,
      subject: input.subject,
      eventType: 'parse_failed',
      actionTaken: 'none',
      detail: { reason: parsed.error.code },
    })
    return { status: 'parse_failed', reason: parsed.error.code }
  }

  // 5) 决策：只可能是 mark_done 或 none。
  const decision = decideInboundAction(parsed.data, candidates)
  const eventType = parsed.data.event

  if (decision.action === 'mark_done' && candidates.some((c) => c.id === decision.taskId)) {
    const { error: updateError } = await admin
      .from('tasks')
      .update({ status: 'done' })
      .eq('id', decision.taskId)
    if (updateError) {
      console.error('[inbound] 更新任务状态失败:', updateError.message)
      await logEvent(admin, {
        userId,
        from: input.from,
        subject: input.subject,
        eventType,
        actionTaken: 'none',
        detail: { error: updateError.message, title: parsed.data.taskTitle },
      })
      return { status: 'processed', action: 'none', event: eventType, reason: 'update_failed' }
    }
    await logEvent(admin, {
      userId,
      from: input.from,
      subject: input.subject,
      eventType,
      actionTaken: 'mark_done',
      matchedTaskId: decision.taskId,
      detail: { title: parsed.data.taskTitle, matchedTitle: decision.matchedTitle, matchMode: 'exact' },
    })
    return { status: 'processed', action: 'mark_done', taskId: decision.taskId, event: eventType }
  }

  await logEvent(admin, {
    userId,
    from: input.from,
    subject: input.subject,
    eventType,
    actionTaken: 'none',
    detail: { decision, title: parsed.data.taskTitle },
  })
  return {
    status: 'processed',
    action: 'none',
    event: eventType,
    reason: decision.action === 'none' ? decision.reason : undefined,
  }
}

/** 审计日志落库；失败只记服务端日志，绝不影响本次入站结果（邮件不重试）。 */
async function logEvent(
  admin: ReturnType<typeof createServiceRoleClient>,
  row: {
    userId: string
    from: string
    subject: string | null
    eventType: string
    actionTaken: string
    matchedTaskId?: string
    detail?: unknown
  },
): Promise<void> {
  try {
    const { error } = await admin.from('email_inbound_events').insert({
      user_id: row.userId,
      received_from: row.from,
      subject: row.subject,
      event_type: row.eventType,
      action_taken: row.actionTaken,
      matched_task_id: row.matchedTaskId ?? null,
      detail: row.detail ?? null,
    })
    if (error) {
      console.error('[inbound] 写入审计日志失败（不影响本次处理）:', error.message)
    }
  } catch (error) {
    console.error('[inbound] 写入审计日志抛错（不影响本次处理）:', error)
  }
}
