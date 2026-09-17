import { NextResponse } from 'next/server'

import { internalError, jsonError } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'

/**
 * `GET /api/v1/reminders/unsubscribe?t=<token>` —— 一键退订（公开，无需登录）。
 *
 * 邮件里的退订链接指向这里。token 即身份（每个用户一个随机 `reminder_unsub_token`），
 * 按 token 定位用户并关掉 `reminder_enabled`。不依赖登录态 —— 用户从邮件点进来时
 * 大概率没带着 Tempo 的 session cookie。
 *
 * ### 安全
 * token 是 36 字符随机 hex（不可预测），且只用于"关自己的提醒"这一件低危操作，
 * 不暴露任何其它数据。长度不足直接 400（防盲猜）。
 */

export const dynamic = 'force-dynamic'

const MIN_TOKEN_LENGTH = 12

function unsubscribedPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:48px 24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;text-align:center">
  <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:32px 24px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
    <div style="font-size:32px;margin-bottom:12px">✅</div>
    <h1 style="margin:0 0 12px;font-size:18px;color:#1d1d1f">已退订 Tempo 提醒</h1>
    <p style="margin:0;font-size:14px;color:#6b6b70;line-height:1.6">
      你不会再收到 Tempo 的邮件提醒。<br>想重新开启，去 Tempo 设置页即可。
    </p>
  </div>
</body>
</html>`
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('t')
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    return jsonError(request, 400, 'bad_request', '缺少或非法的退订令牌')
  }

  try {
    const admin = createServiceRoleClient()
    const { error } = await admin
      .from('profiles')
      .update({ reminder_enabled: false })
      .eq('reminder_unsub_token', token)

    if (error) {
      return internalError(request, error)
    }

    return new NextResponse(unsubscribedPage(), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    return internalError(request, error)
  }
}
