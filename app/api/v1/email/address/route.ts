/**
 * 当前用户的邮件入站地址（P0-3-11）。
 *
 * `GET /api/v1/email/address` —— 返回 `inbound+<token>@<域>`。
 * token 首次访问时懒生成（写回 `profiles.inbound_token`），后续稳定不变。
 *
 * 走用户会话（RLS），不是内部端点 —— 调用方必须是已登录用户本人。
 */

import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { getOrCreateInboundAddress } from '@/lib/email/address'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const domain = process.env.INBOUND_EMAIL_DOMAIN
    if (!domain) {
      return jsonError(request, 500, 'inbound_not_configured', '服务端未配置 INBOUND_EMAIL_DOMAIN')
    }

    const address = await getOrCreateInboundAddress(supabase, user.id, domain)
    return jsonOk(request, { data: { address } })
  } catch (error) {
    return internalError(request, error)
  }
}
