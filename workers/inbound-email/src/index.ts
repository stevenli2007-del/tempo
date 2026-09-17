/**
 * Tempo 邮件入站转发 Worker（P0-3-11，ADR-019）。
 *
 * 角色：Cloudflare Email Routing 收到发往 `inbound+<token>@<域>` 的邮件后，
 * 调用本 Worker；Worker 只做一件事 —— 把邮件正文 POST 给 Vercel 的入站路由
 * （带 Bearer 共享密钥）。所有业务逻辑（解析 / 匹配 / 落写）都在 Vercel 那边，
 * 这里保持"薄"：只负责把原始 MIME 解析成明文正文，不引入任何业务判断。
 *
 * ### 为什么必须解析 `message.raw`（而不是 `message.text()`）
 * Cloudflare 的 `ForwardableEmailMessage` **没有** `text()` 方法（多个官方/社区来源确认，
 * 只有 `raw` 这个原始 MIME 流）。直接 `message.text()` 会抛 TypeError 被吞掉、正文恒为空。
 * 因此用 `postal-mime` 解析 `message.raw`，正确取出 `text/plain`；缺失时再兜底剥 `html` 标签。
 * postal-mime 只装在本 Worker 的 `workers/` 独立部署单元，不进 Next bundle。
 *
 * ### 为什么不调 message.forward()
 * 邮件已被我们"收下"并转交后端处理，不需要再投递到别处。Worker 不 forward / 不 reject
 * 即表示"已接受并丢弃原始邮件副本"，避免重复投递。
 */

import PostalMime from 'postal-mime'

interface Env {
  INBOUND_WEBHOOK_URL: string
  INBOUND_EMAIL_SECRET: string
}

const emailHandler = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = message.to
    const from = message.from
    const subject =
      message.headers && typeof message.headers.get === 'function'
        ? message.headers.get('subject') ?? ''
        : ''

    let textBody = ''
    try {
      const raw = await new Response(message.raw).arrayBuffer()
      const email = await PostalMime.parse(raw)
      textBody = (email.text ?? '').trim()
      // HTML-only 邮件兜底：剥标签后给 LLM 一个可读正文。
      if (!textBody && email.html) {
        textBody = email.html
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }
    } catch (err) {
      // 解析失败也不应让邮件网关重试/退信：正文留空，由 Vercel 侧记 no_text 审计。
      console.error('[inbound-worker] MIME 解析失败，正文置空', err)
    }

    try {
      const res = await fetch(env.INBOUND_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.INBOUND_EMAIL_SECRET}`,
        },
        body: JSON.stringify({ to, from, subject, textBody }),
      })
      // 必须把非 2xx 打出来：否则 Vercel 端 401（两边密钥不一致）/ 4xx 会被静默吞掉，
      // `wrangler tail` 里什么都看不到 —— 排查时极易误判成"邮件没进 Worker"。
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        console.error(
          `[inbound-worker] webhook 非 2xx: ${res.status} to=${to} body=${detail.slice(0, 300)}`,
        )
      }
    } catch (err) {
      // 吞掉：邮件网关不应因我们 POST 失败而重试 / 退信，造成循环。
      console.error('[inbound-worker] forward failed', err)
    }
  },
}

export default emailHandler
