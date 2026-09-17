/**
 * Tempo 邮件入站转发 Worker（P0-3-11，ADR-019）。
 *
 * 角色：Cloudflare Email Routing 收到发往 `inbound+<token>@<域>` 的邮件后，
 * 调用本 Worker；Worker 只做一件事 —— 把邮件正文 POST 给 Vercel 的入站路由
 * （带 Bearer 共享密钥）。所有业务逻辑（解析 / 匹配 / 落写）都在 Vercel 那边，
 * 这里保持"薄"，不引入任何业务逻辑或第三方 MIME 解析依赖。
 *
 * 为什么不调 message.forward()：
 * 邮件已被我们"收下"并转交后端处理，不需要再投递到别处。Worker 不 forward / 不 reject
 * 即表示"已接受并丢弃原始邮件副本"，避免重复投递。
 */

interface Env {
  INBOUND_WEBHOOK_URL: string
  INBOUND_EMAIL_SECRET: string
}

export default {
  async email(message: any, env: Env): Promise<void> {
    const to = message.to
    const from = message.from
    const subject =
      message.headers && typeof message.headers.get === 'function'
        ? message.headers.get('subject') ?? ''
        : ''

    let textBody = ''
    try {
      textBody = await message.text()
    } catch {
      textBody = ''
    }

    try {
      await fetch(env.INBOUND_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.INBOUND_EMAIL_SECRET}`,
        },
        body: JSON.stringify({ to, from, subject, textBody }),
      })
    } catch (err) {
      // 吞掉：邮件网关不应因我们 POST 失败而重试 / 退信，造成循环。
      console.error('[inbound-worker] forward failed', err)
    }
  },
}
