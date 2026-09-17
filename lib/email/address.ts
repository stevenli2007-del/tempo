import type { SupabaseClient } from '@supabase/supabase-js'

import { generateInboundToken, MIN_TOKEN_LENGTH } from './token'

/**
 * 邮件入站地址的懒生成与读取（P0-3-11）。
 *
 * 在**用户会话上下文**下调用（设置页 / GET 路由），走 RLS —— 不需要 service role：
 * 用户只能读写自己的 profiles 行。token 首次访问时生成并写回。
 */

/** 取当前用户的入站密址（`inbound+<token>@<domain>`），首次访问时懒生成 token。 */
export async function getOrCreateInboundAddress(
  supabase: SupabaseClient,
  userId: string,
  domain: string,
): Promise<string> {
  const { data } = await supabase
    .from('profiles')
    .select('inbound_token')
    .eq('id', userId)
    .maybeSingle()
  const existing = (data as { inbound_token: string | null } | null)?.inbound_token
  if (existing && existing.length >= MIN_TOKEN_LENGTH) {
    return `inbound+${existing}@${domain}`
  }
  const token = await createTokenForUser(supabase, userId)
  return `inbound+${token}@${domain}`
}

async function createTokenForUser(supabase: SupabaseClient, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateInboundToken()
    const { error } = await supabase.from('profiles').update({ inbound_token: token }).eq('id', userId)
    if (!error) return token
    // 唯一索引冲突才重试；其它错误上抛。
    if (!/duplicate|unique/i.test(error.message)) throw error
  }
  throw new Error('生成入站 token 失败：唯一索引反复冲突')
}
