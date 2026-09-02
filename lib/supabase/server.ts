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
 */
export async function createClient() {
  const { url, anonKey } = getSupabaseEnv()
  const cookieStore = await cookies()

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
