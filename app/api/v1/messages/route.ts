import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { loadMessages } from '@/lib/messages'
import type { MessageStatus } from '@/types/message'

/**
 * 消息栏列表（P0-3-18）。
 *
 * `GET /api/v1/messages?status=pending` —— 默认返回全部状态、按时间倒序。
 *
 * ### 为什么列表端点可以直接给"全部状态"
 * 消息栏要同时看到待处理的和已处理的（`accepted` / `dismissed`）——
 * 处理完就消失会让用户失去"我点过什么"的凭据，那是 P0-3-2「可审计」的同一取向。
 *
 * 归属靠 RLS（`auth.uid() = user_id`），所以这里**不需要**像 tasks 那样显式收口课程 id；
 * 但**必须**用带会话的客户端（`getCurrentUser()` 里的 `createClient()`），
 * 换成 service role 就会读到别人的消息（`lib/messages.ts` 顶部注释）。
 */

const MESSAGE_STATUSES: readonly MessageStatus[] = ['pending', 'accepted', 'dismissed']

export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const statusParam = new URL(request.url).searchParams.get('status')
    if (statusParam !== null && !MESSAGE_STATUSES.includes(statusParam as MessageStatus)) {
      // 不静默忽略非法筛选值：忽略会返回"全部"，而调用方以为拿到的是筛过的集合。
      return jsonError(request, 400, 'bad_request', 'status 只支持 pending / accepted / dismissed')
    }

    const { messages, error } = await loadMessages(supabase, {
      status: (statusParam as MessageStatus | null) ?? undefined,
    })
    if (error) {
      throw new Error(error)
    }

    const pending = messages.filter((message) => message.status === 'pending').length
    return jsonOk(request, {
      data: messages,
      meta: { total: messages.length, pending },
    })
  } catch (error) {
    return internalError(request, error)
  }
}
