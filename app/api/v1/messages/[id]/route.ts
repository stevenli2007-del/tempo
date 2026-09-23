import { UUID_PATTERN } from '@/lib/api/params'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { finalizeConfirmation, loadMessage, updateMessageStatus } from '@/lib/messages'
import { applyMessage, isApplierReady } from '@/lib/messages/apply'
import { undoMessage } from '@/lib/messages/undo'
import { planDecision } from '@/lib/messages/decide'
import { applyExamChoices, readExamChoices } from '@/lib/messages/exam-proposals/choose'

/** 撤销窗口（毫秒）：确认后 24h 内可撤销。 */
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000

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
    const action = (body as Record<string, unknown>).action

    // ---------- 撤销分支（P0-3-26） ----------
    if (action === 'undo') {
      return await handleUndo(request, supabase, id, user.id)
    }

    const nextStatus = (body as Record<string, unknown>).status
    if (nextStatus !== 'accepted' && nextStatus !== 'dismissed') {
      return jsonError(request, 400, 'validation_failed', 'status 只接受 accepted 或 dismissed')
    }
    const choiceInput = (body as Record<string, unknown>).examChoices

    const { message, error } = await loadMessage(supabase, id)
    if (error) {
      throw new Error(error)
    }
    // 不存在 / 不是自己的，统一 404（ADR-010）。
    if (!message) {
      return jsonError(request, 404, 'not_found', '提案不存在或无权访问')
    }

    // ---------- P0-3-36：用户在消息栏挑的「覆盖哪一条 / 新增一条」 ----------
    //
    // 选择**合并进 payload 再**交给写入器：写入器只认 `kind` + `targetId`，
    // 于是「界面上挑的那条」与「真正写进库的那行」是同一份数据（所见即所写）。
    // 校验失败直接 400 —— 静默忽略会让用户以为选了、结果一个字都没写（R3）。
    const choiceResult = applyExamChoices(message.payload, readExamChoices(choiceInput))
    if (choiceResult.error !== null) {
      return jsonError(request, 400, 'validation_failed', choiceResult.error)
    }
    const payloadForApply = choiceResult.payload

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
      // 带上用户挑的那一条（没挑时与 `updated.payload` 全等）。
      payload: payloadForApply,
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

    // 确认成功：把回执 / 写入行 id / 确认时刻落库（刷新后仍在，撤销按 id 精准回滚）。
    const decidedAt = new Date().toISOString()
    const mergedPayload = {
      ...payloadForApply,
      ...(outcome.applied ? { applied: outcome.applied } : {}),
      receipt: outcome.summary,
    }
    const { message: finalized, error: finalizeError } = await finalizeConfirmation(
      supabase,
      id,
      mergedPayload,
      decidedAt,
    )
    if (finalizeError) {
      // 回执没落库不算致命：业务数据已写入、状态已 accepted。但必须报出来，
      // 否则出现"显示已确认、回执却丢了"的半截状态。
      console.error('[messages] 确认回执落库失败:', finalizeError)
    }

    return jsonOk(request, {
      data: finalized ?? updated,
      applied: true,
      summary: outcome.summary,
    })
  } catch (error) {
    return internalError(request, error)
  }
}

/**
 * 撤销（P0-3-26）：把确认那一刻写入的考试 / 成绩构成回滚，并同步移除派生任务。
 *
 * 🔴 这是不可逆操作的最后一道闸，规则比确认更严：
 * - 只有 `accepted` 能撤（pending / dismissed / 已 undone 都拒绝）；
 * - **服务端卡 24h 窗口**：超窗返回 403，不依赖前端隐藏按钮（前端只是 UX）；
 * - 没有 `decided_at`（本功能上线前确认的老消息）直接拒绝 —— 它们本就没有可撤销的数据；
 * - 撤销器失败 → 502，**绝不**把状态改成 undone 假装成功（ADR-016 R3）。
 */
async function handleUndo(
  request: Request,
  supabase: Awaited<ReturnType<typeof getCurrentUser>>['supabase'],
  id: string,
  userId: string,
): Promise<Response> {
  const { message, error } = await loadMessage(supabase, id)
  if (error) {
    throw new Error(error)
  }
  if (!message) {
    return jsonError(request, 404, 'not_found', '提案不存在或无权访问')
  }
  if (message.status !== 'accepted') {
    return jsonError(request, 409, 'not_undoable', '这条提案当前不可撤销')
  }
  if (!message.decidedAt) {
    // 本功能上线前确认的老消息：没有可撤销的数据，且无法判定窗口。
    return jsonError(request, 409, 'not_undoable', '这条提案没有可撤销的写入记录')
  }

  const now = Date.now()
  const decided = new Date(message.decidedAt).getTime()
  if (Number.isNaN(decided) || now - decided > UNDO_WINDOW_MS) {
    return jsonError(request, 403, 'undo_window_expired', '已超过 24 小时撤销窗口，无法撤销')
  }

  const outcome = await undoMessage({
    type: message.type,
    payload: message.payload,
    supabase,
    userId,
  })
  if (!outcome.ok) {
    return jsonError(request, 502, outcome.code, outcome.message)
  }

  // 撤销成功才改终态。payload 里的 applied / receipt 保留（对账与回放用）。
  const { message: undone, error: updateError } = await updateMessageStatus(supabase, id, 'undone')
  if (updateError) {
    throw new Error(updateError)
  }
  if (!undone) {
    return jsonError(request, 404, 'not_found', '提案不存在或无权访问')
  }
  return jsonOk(request, { data: undone, undone: true })
}
