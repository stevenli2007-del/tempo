import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { getSupabaseEnv } from './env'

/**
 * 需要登录才能访问的路径前缀。
 *
 * 新增受保护页面时，在这里加一条即可，不要把判断逻辑散落到各个页面里。
 */
const PROTECTED_PREFIXES = ['/dashboard']

/** 已登录用户不该再看到的页面（会被送去 /dashboard）。 */
const AUTH_PAGES = ['/login', '/signup']

function matches(pathname: string, paths: string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/** 把刷新出来的 cookie 复制到重定向响应上，避免丢 session。 */
function redirectWithCookies(target: URL, source: NextResponse): NextResponse {
  const response = NextResponse.redirect(target)
  source.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie)
  })
  return response
}

/**
 * 每次请求都刷新 Supabase session，并做路由保护。
 *
 * 两点必须记住（踩过的人都懂）：
 * 1. 一定要调 `getUser()` 而不是 `getSession()` —— 前者会真的去 Auth 服务端校验
 *    JWT，后者只解本地 cookie，cookie 被伪造时 getSession 会放行。
 * 2. 不能省略 `NextResponse.next({ request })`，否则刷新后的新 cookie 不会回写
 *    给浏览器，用户会随机掉线。
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request })

  const { url, anonKey } = getSupabaseEnv()

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        )
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && matches(pathname, PROTECTED_PREFIXES)) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = ''
    return redirectWithCookies(loginUrl, supabaseResponse)
  }

  if (user && matches(pathname, AUTH_PAGES)) {
    const dashboardUrl = request.nextUrl.clone()
    dashboardUrl.pathname = '/dashboard'
    dashboardUrl.search = ''
    return redirectWithCookies(dashboardUrl, supabaseResponse)
  }

  return supabaseResponse
}
