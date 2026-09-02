import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getSupabaseEnv } from './env'

/**
 * 服务端 Supabase client（Server Component / Route Handler / Server Action）。
 *
 * 只能在服务端调用。浏览器端请改用 @/lib/supabase/browser。
 *
 * 关于 setAll 的 try/catch：Server Component 里 cookie 是只读的，
 * 写入会抛错，这里静默忽略。session 刷新统一由 middleware 负责（见 P0-0-3）。
 *
 * ⚠️ 关于调用顺序：cookies() 必须先于 getSupabaseEnv() 执行。
 * Next.js 靠「渲染期间是否读过 cookies()」来判定路由是否依赖请求上下文。
 * 顺序反了的话，env 缺失时会在 cookies() 之前就抛错，Next 看不到 cookies()
 * → 误判为静态页 → build 期预渲染崩溃（Vercel P0-0-6 部署实测踩坑）。
 */
export async function createClient() {
  const cookieStore = await cookies()
  const { url, anonKey } = getSupabaseEnv()

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Server Component 内 cookie 只读，忽略即可。
        }
      },
    },
  })
}
