import { authorizeCronRequest } from '@/lib/api/cron-auth'
import { internalError, jsonError, jsonOk } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { runScheduledSync } from '@/lib/sync/scheduled'

/**
 * `GET|POST /api/v1/sync/scheduled` —— T3 平台定时兜底（API-Contract.md §6）。
 *
 * ### 为什么 GET 和 POST 都支持
 * - **Vercel Cron 只发 GET**，这是平台行为，改不了（Sync-Strategy §3.1）。
 * - 契约 §6 原文写的是 POST，而 Sync-Strategy §3.2 的 T4 外部调度器示例写的又是 GET
 *   —— 两份文档本来就打架。两个方法都导出，谁都能调，省掉一次"到底该用哪个"的往返。
 *
 * ### 鉴权：CRON_SECRET + 恒定时间比较
 * 校验逻辑已在 P0-3-1 抽到 `lib/api/cron-auth.ts`（与 `GET /api/v1/metrics` 共用），
 * 三条规则不变：sha256 + `timingSafeEqual` 恒定时间比较、没配 secret 即 fail closed
 * （500 而不是放行）、只认 `Authorization: Bearer`。
 */

/** cron 端点绝不缓存：万一被 CDN 缓存一次，后续定时扫描就全部落空。 */
export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  try {
    const auth = authorizeCronRequest(request)
    if (!auth.ok) {
      return auth.response
    }

    // 与上面同款 fail closed：配了 secret 却没配 service role key 时，
    // 明确说缺什么，而不是笼统的 500 internal_error（那种消息排障时等于没有）。
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonError(
        request,
        500,
        'service_role_key_missing',
        '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法遍历用户凭据',
      )
    }

    const supabase = createServiceRoleClient()
    const report = await runScheduledSync(supabase)
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
