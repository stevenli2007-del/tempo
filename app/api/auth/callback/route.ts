import { NextResponse, type NextRequest } from 'next/server'

import { createClient } from '@/lib/supabase/server'

/**
 * 邮箱确认 / OAuth 回调。
 *
 * Phase 0 关闭了邮箱验证（注册后直接有 session），所以这条路由目前是"休眠"状态。
 * 保留它的原因：等哪天打开邮箱验证或接了 OAuth，只要把 Supabase 的 Site URL /
 * Redirect URL 指向这里就能用，不用临时补代码。
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth`)
  }

  return NextResponse.redirect(`${origin}/dashboard`)
}
