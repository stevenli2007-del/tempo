import { UUID_PATTERN } from '@/lib/api/params'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { loadMessage, updateMessageStatus } from '@/lib/messages'
import { applyMessage, isApplierReady } from '@/lib/messages/apply'
import { planDecision } from '@/lib/messages/decide'

/**
 * 提案的「确认 / 忽略」（P0-3-18）。
 *
 * `PATCH /api/v1/messages/:id` body `{ status: 'accepted' | 'dismissed' }`
 *
 * ### 🔴 这是全站唯一能让提案"生效"的地方
 * 判定全部收在 `planDecision()`（纯函数、有回归断言）：忽略永不调用 applier；
 * 确认只在 applier 就绪时才改状态。**任何"顺手自动写"的路径都不该存在**（ADR-015）。
 *
 * ### 写入顺序（刻意的）
 * 先改状态、再执行 applier，applier 失败则**尽力回滚状态为 pending** 并返回 502。
 * 反过来（先写业务数据再改状态）在 applier 有副作用时更危险：
 * 状态更新失败 → 用户重试 → **同一个变更被写两次**（3-20 会真写 `exam_dates`，
 * 重复写意味着把用户已确认的考试日期覆盖两遍）。宁可"少写一次、报错让用户重试"。
 */

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { id } = await context.params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', '提案 id 格式不正确')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }
    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }
    const nextStatus = (body as Record<string, unknown>).status
    if (nextStatus !== 'accepted' && nextStatus !== 'dismissed') {
      return jsonError(request, 400, 'validation_failed', 'status 只接受 accepted 或 dismissed')
    }

    const { message, error } = await loadMessage(supabase, id)
    if (error) {
      throw new Error(error)
    }
    // 不存在 / 不是自己的，统一 404（ADR-010）。
    if (!message) {
      return jsonError(request, 404, 'not_found', '提案不存在或无权访问')
    }

    const plan = planDecision({
      currentStatus: message.status,
      decision: nextStatus,
      applierReady: isApplierReady(message.type),
    })
    if (plan.kind === 'reject') {
      return jsonError(request, plan.status, plan.code, plan.message)
    }

    const { message: updated, error: updateError } = await updateMessageStatus(
      supabase,
      id,
      plan.nextStatus,
    )
    if (updateError) {
      throw new Error(updateError)
    }
    if (!updated) {
      return jsonError(request, 404, 'not_found', '提案不存在或无权访问')
    }

    if (!plan.callApplier) {
      return jsonOk(request, { data: updated, applied: false })
    }

    const outcome = await applyMessage({
      type: updated.type,
      payload: updated.payload,
      supabase,
      // 会话里的用户 id，不是 payload 里的任何字段（见 `ApplyContext` 的注释）。
      userId: user.id,
    })
    if (!outcome.ok) {
      // 状态已改但没写成业务数据 —— 回滚成 pending，避免"显示已确认、其实没生效"。
      const { error: rollbackError } = await updateMessageStatus(supabase, id, 'pending')
      if (rollbackError) {
        console.error('[messages] 回滚到 pending 失败:', rollbackError)
      }
      return jsonError(request, 502, outcome.code, outcome.message)
    }

    return jsonOk(request, { data: updated, applied: true, summary: outcome.summary })
  } catch (error) {
    return internalError(request, error)
  }
}
