import type { User } from '@supabase/supabase-js'

import type { getCurrentUser } from '@/lib/api/response'

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/**
 * 确保当前用户的 profiles 行存在。
 *
 * `auth.users` 与 `public.profiles` 本该由 `handle_new_user` 触发器同步，
 * 但在项目早期或触发器尚未稳定时注册的测试账号可能没有 profiles 行。
 * 任何对 `courses` 的写入都会因外键约束而失败，所以写课程前先 upsert 兜底。
 *
 * 幂等：已存在 → `on conflict (id) do nothing`；不存在 → 插入。
 * RLS `profiles_own_all` 的 WITH CHECK 是 `auth.uid() = id`，
 * upsert 的 id 就是当前用户 id，所以策略放行。
 */
export async function ensureProfile(supabase: SupabaseClient, user: User): Promise<void> {
  const displayName =
    (user.user_metadata?.display_name as string | undefined) ??
    user.email?.split('@')[0] ??
    'Tempo User'

  const { error } = await supabase.from('profiles').upsert(
    {
      id: user.id,
      display_name: displayName,
      timezone: 'America/Los_Angeles',
    },
    { onConflict: 'id' },
  )

  if (error) {
    throw error
  }
}
