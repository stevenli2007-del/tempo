/**
 * Tempo 出站邮件 Worker（P0-3-14，ADR-017 秘书护城河 / ADR-019 出站归本卡）。
 *
 * 角色：Vercel 的提醒引擎组装好邮件后，POST 给本 Worker；Worker 调用 Cloudflare
 * Email Service 的 `send_email` 绑定把信发出去。逻辑保持"薄"：只做鉴权 + 转发，
 * 不引入任何业务判断（与入站 Worker 同一设计哲学）。
 *
 * ### 为什么单独一个 Worker
 * 入站 Worker（tempo-inbound-email）已验收、正在服务 3-11 的邮件入站。出站是新增能力，
 * 单独部署避免改坏已验收的入站链路（隔离优于复用）。
 *
 * ### 鉴权
 * 与入站 Worker 同款思路：Vercel ↔ Worker 之间用共享 Bearer 密钥（OUTBOUND_EMAIL_SECRET），
 * 不依赖收件人地址（可伪造）。
 *
 * ### from 地址
 * 必须是本 zone 已验证的目标地址（noreply@tempocourse.com）—— Cloudflare Email Sending
 * 的硬性要求。验证方式见 EMAIL 文档 §出站启用。
 */

interface Env {
  EMAIL: SendEmail
  OUTBOUND_EMAIL_SECRET: string
  FROM_ADDRESS: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${env.OUTBOUND_EMAIL_SECRET}`) {
      return new Response('Unauthorized', { status: 401 })
    }

    let body: { to?: unknown; subject?: unknown; html?: unknown; text?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return new Response('Bad Request: invalid JSON', { status: 400 })
    }

    const to = body.to
    const subject = typeof body.subject === 'string' ? body.subject : ''
    const html = typeof body.html === 'string' ? body.html : undefined
    const text = typeof body.text === 'string' ? body.text : ''
    if ((typeof to !== 'string' && !Array.isArray(to)) || !subject) {
      return new Response('Bad Request: missing to/subject', { status: 400 })
    }
    const recipients = (Array.isArray(to) ? to : [to]).map(String)

    try {
      await env.EMAIL.send({
        from: env.FROM_ADDRESS,
        to: recipients,
        subject,
        html,
        text,
      })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      // 发送失败不能让 Vercel 侧误判"成功"：明确 502 + 错误体，便于排障。
      console.error('[outbound-worker] send failed', err)
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }
  },
} satisfies ExportedHandler<Env>
