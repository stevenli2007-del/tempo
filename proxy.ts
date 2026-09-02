import type { NextRequest } from 'next/server'

import { updateSession } from '@/lib/supabase/proxy'

/**
 * 每次请求都走这里：刷新 Supabase session + 保护受路由。
 *
 * Next.js 16 起，根目录的 `middleware.ts` 约定已改名为 `proxy.ts`
 *（两者同时存在会直接报 E900 构建错误），导出函数名也由 `middleware` 改为 `proxy`。
 * 全部逻辑放在 `lib/supabase/proxy.ts`，因为约定文件本身没法被单元测试覆盖。
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  /**
   * 跳过静态资源：这些文件跟 session 无关，让 proxy 跑一遍纯属浪费。
   * 注意字体和图片后缀必须排除，否则本地 woff / 图标也会触发 Supabase 请求。
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
}
