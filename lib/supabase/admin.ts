import { createClient } from '@supabase/supabase-js'

import type { createClient as createUserClient } from '@/lib/supabase/server'
import { getSupabaseEnv } from './env'

/**
 * ⚠️⚠️ Service role 客户端 —— **绕过 RLS**，本项目唯一的一把"万能钥匙"。
 *
 * 只有四处允许使用（P0-2-6 第二拍引入，其余一律用 `@/lib/supabase/server` 的
 * 用户级客户端）：
 * 1. **T3 定时兜底同步** `/api/v1/sync/scheduled` —— 必须遍历全部用户的凭据，
 *    这在 RLS 下做不到（看不到别人的行）。
 * 2. **运营指标** `GET /api/v1/metrics`（P0-3-1）—— 四项都是跨用户指标，
 *    用户级客户端算出的"人均"永远是 1。
 * 3. **删除账号** `DELETE /api/v1/account`（P0-3-2）—— 删 Supabase Auth 用户
 *    只能走 `auth.admin.deleteUser()`，用户级客户端没有这个权限。
 *    其余动作（删 Storage）仍用用户级客户端走 RLS。
 * 4. 将来的管理脚本（清理 / 迁移），同样不走用户请求。
 *
 * 🔴🔴 三条红线
 * 1. **绝不在处理用户请求的路由里调用它。** 用户请求一律走 `lib/supabase/server`，
 *    让 RLS 兜底 —— 那是当前唯一在拦跨用户访问的机制。
 * 2. **绝不把客户端本身或 `SUPABASE_SERVICE_ROLE_KEY` 暴露到响应 / 日志 / 前端。**
 *    这把 key 没有 `NEXT_PUBLIC_` 前缀，一旦加了就会被打进前端产物，等于把整库交出去。
 * 3. **它绕过了 RLS，所以调用它的代码必须自己把 user_id 写进每一个查询条件。**
 *    这也是 P0-2-6 第二拍给 `loadDecryptedCredential` / `loadCredentialMeta` /
 *    `findRunningRun` / `findLastRunStartedAt` 加上**强制 userId 参数**的原因 ——
 *    靠"RLS 会帮我隔离"的隐式保证在这个客户端下完全不成立，串数据不会报错，只会静默出错。
 *
 * 会话相关全部关掉：这是无状态的服务端调用，没有浏览器 cookie 可持久化，
 * 也不需要刷新 token（service role key 本身不过期）。
 */
type UserSupabase = Awaited<ReturnType<typeof createUserClient>>

export function createServiceRoleClient(): UserSupabase {
  const { url } = getSupabaseEnv()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!serviceRoleKey) {
    throw new Error(
      '缺少环境变量 SUPABASE_SERVICE_ROLE_KEY（定时同步需要它来遍历全部用户的凭据）。' +
        '从 Supabase Dashboard → Project Settings → API Keys 复制 service_role key，' +
        '填入 .env.local 与 Vercel Environment Variables。' +
        '⚠️ 绝不要加 NEXT_PUBLIC_ 前缀。',
    )
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    // 这里是 @supabase/supabase-js 的客户端，与 @supabase/ssr 的返回值结构等价
    // （查询构造器 API 完全一致），只是没有 cookie 适配层。断言一次，全项目复用。
  }) as unknown as UserSupabase
}
