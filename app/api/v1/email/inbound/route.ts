/**
 * 邮件入站 webhook（P0-3-11，ADR-019：纯入站 + 密址绑定）。
 *
 * `POST /api/v1/email/inbound` —— 由 Cloudflare Email Routing Worker 转发调用，
 * body：`{ to, from, subject, textBody }`。
 *
 * ### 鉴权
 * 与定时端点同款恒定时间 + fail closed（`authorizeCronRequest`），只是换了个
 * secret 名（`INBOUND_EMAIL_SECRET`）。Worker 与 Vercel 路由之间用这把共享密钥，
 * 而不是依赖发件人地址（From 可伪造）。
 *
 * ### 🔴 永远回 2xx
 * 邮件服务商对 5xx 会重试、退信会触发循环；解析/匹配失败都已在内部记审计日志，
 * 这里只如实回传结果。鉴权失败（401）与请求体非法（400）例外 —— 那不是"邮件本身"的问题。
 */

import { authorizeCronRequest } from '@/lib/api/cron-auth'
import { handleInboundEmail } from '@/lib/email/inbound'
import { internalError, jsonError, jsonOk } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

type RawBody = Record<string, unknown>

function pickText(body: RawBody): string | null {
  if (typeof body.textBody === 'string') return body.textBody
  if (typeof body.text === 'string') return body.text
  return null
}

export async function POST(request: Request) {
  try {
    const auth = authorizeCronRequest(request, process.env.INBOUND_EMAIL_SECRET, {
      envName: 'INBOUND_EMAIL_SECRET',
    })
    if (!auth.ok) return auth.response

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }
    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }
    const raw = body as RawBody
    const to = typeof raw.to === 'string' ? raw.to.trim() : ''
    const from = typeof raw.from === 'string' ? raw.from.trim() : ''
    const subject = typeof raw.subject === 'string' ? raw.subject : null
    const textBody = pickText(raw)

    if (!to || !from) {
      return jsonError(request, 400, 'bad_request', 'to 与 from 为必填')
    }

    const outcome = await handleInboundEmail({ to, from, subject, textBody })

    return jsonOk(request, { data: outcome })
  } catch (error) {
    // 即便编排抛错也回 200，避免邮件网关重试风暴；异常只在服务端留痕。
    console.error('[inbound] 处理入站邮件异常:', error)
    return jsonOk(request, { data: { status: 'error' } })
  }
}
