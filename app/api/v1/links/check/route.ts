import { authorizeCronRequest } from '@/lib/api/cron-auth'
import { internalError, jsonError, jsonOk } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { runLinkCheck } from '@/lib/course-links/check'

/**
 * `GET|POST /api/v1/links/check` —— P0-5-3 的每日链接重抓（Vercel Cron 触发）。
 *
 * 与 `sync/scheduled` 同一套：Vercel Cron 只发 GET，但契约也认 POST；
 * 鉴权走 `authorizeCronRequest`（CRON_SECRET + 恒定时间比较 + fail closed）；
 * 用 service_role 客户端遍历全部用户的链接（RLS 下看不到别人的行）。
 *
 * 幂等：变化被报告后指纹立即推进，下一轮必然零新消息（验收第 3 条）。
 */

export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  try {
    const auth = authorizeCronRequest(request)
    if (!auth.ok) return auth.response

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonError(
        request,
        500,
        'service_role_key_missing',
        '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法遍历用户链接',
      )
    }

    const supabase = createServiceRoleClient()
    const report = await runLinkCheck(supabase)
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
