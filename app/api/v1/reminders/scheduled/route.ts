import { authorizeCronRequest } from '@/lib/api/cron-auth'
import { internalError, jsonError, jsonOk } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { runScheduledReminders } from '@/lib/reminders/engine'

/**
 * `GET|POST /api/v1/reminders/scheduled` —— 定时批量提醒（T3 同款）。
 *
 * 由 `vercel.json` 的 cron 每天触发一次（与 `/api/v1/sync/scheduled` 同机制）。
 * 遍历全部开启提醒的用户，逐个组装 + 发送。鉴权、service role、响应不泄露用户数据，
 * 全部沿用 `sync/scheduled` 的约定（见该端点注释与 `lib/api/cron-auth.ts`）。
 */

export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  try {
    const auth = authorizeCronRequest(request)
    if (!auth.ok) {
      return auth.response
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonError(
        request,
        500,
        'service_role_key_missing',
        '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法遍历用户',
      )
    }

    const admin = createServiceRoleClient()
    const report = await runScheduledReminders(admin)
    return jsonOk(request, report)
  } catch (error) {
    return internalError(request, error)
  }
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
