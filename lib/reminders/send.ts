/**
 * 提醒邮件的「发送传输层」（P0-3-14）。
 *
 * ### 为什么是这一层
 * 把"怎么把邮件送出去"和"要送什么"分开：本文件只负责把 `{to, subject, html, text}`
 * 交给 Cloudflare 出站 Worker（`workers/outbound-email`），调用方（`engine.ts`）只管内容。
 *
 * ### 🔴 失败必须软降级（不抛错）
 * 提醒是"增强体验"，不是核心功能。发送失败（Worker 没配 / 网络抖 / Cloudflare 限流）
 * 绝不能让定时 cron 或手动触发接口 500 —— 那只会造成"排错时以为系统挂了"的误判。
 * 这里一律 catch 后返回 `{ ok: false, error }`，由调用方决定怎么记账。
 */

export type SendEmailPayload = {
  to: string
  subject: string
  html: string
  text: string
}

export type SendEmailResult = { ok: boolean; error?: string }

/**
 * 通过 Cloudflare 出站 Worker 发送邮件。
 *
 * 依赖两个环境变量：
 * - `OUTBOUND_EMAIL_WORKER_URL`：Worker 的 fetch 端点（部署后由 Cloudflare 给出）。
 * - `OUTBOUND_EMAIL_SECRET`：Worker 与 Vercel 之间的共享 Bearer 密钥。
 * 两者任一缺失 → 视为"尚未启用出站"，返回 `not_configured`（不报错）。
 */
export async function sendReminderEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  const url = process.env.OUTBOUND_EMAIL_WORKER_URL
  const secret = process.env.OUTBOUND_EMAIL_SECRET

  if (!url || !secret) {
    console.warn('[reminder:send] 未配置 OUTBOUND_EMAIL_WORKER_URL / OUTBOUND_EMAIL_SECRET，跳过发送')
    return { ok: false, error: 'not_configured' }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('[reminder:send] Worker 非 2xx:', res.status, detail.slice(0, 300))
      return { ok: false, error: `worker_${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    // 吞掉：网络/解析错误只记服务端日志，绝不冒泡。
    console.error('[reminder:send] 调用出站 Worker 失败:', err)
    return { ok: false, error: 'fetch_failed' }
  }
}
