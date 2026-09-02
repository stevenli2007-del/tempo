import { createBrowserClient } from '@supabase/ssr'
import { getSupabaseEnv } from './env'

/**
 * 浏览器端 Supabase client。
 *
 * 只能在 Client Component（"use client"）里调用。
 * 服务端请改用 @/lib/supabase/server，两者不可混用。
 */
export function createClient() {
  const { url, anonKey } = getSupabaseEnv()
  return createBrowserClient(url, anonKey)
}
