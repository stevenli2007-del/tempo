import { authorizeCronRequest } from '@/lib/api/cron-auth'
import { internalError, jsonError, jsonOk } from '@/lib/api/response'
import { loadMetrics } from '@/lib/metrics'
import { createServiceRoleClient } from '@/lib/supabase/admin'

/**
 * `GET /api/v1/metrics` —— 四项量化指标（P0-3-1，PRD 8.1 / Gate 0→1）。
 *
 * 返回编辑修正率 / 7 日回访 / 人均关联课程数 / token 续期完成率，供 Gate 0→1
 * 评审（G0-2 / G0-3 / G0-7）直接读数，不建管理后台界面 —— Phase 0 只有 5-6 个
 * 种子用户，一个受保护的 JSON 端点比一个后台页面省事，也不会把指标数据暴露给
 * 任何登录用户。
 *
 * ### 鉴权：与 `/sync/scheduled` 同一套（CRON_SECRET + 恒定时间比较 + fail closed）
 * 见 `lib/api/cron-auth.ts`。用 CRON_SECRET 而不是"管理员账号"：Phase 0 没有
 * 角色体系，为它引入一套 role 是纯粹的过度设计；这个 secret 已经配在 Vercel 上。
 *
 * ### 🔴 为什么必须走 service role
 * 四项指标全是**跨用户**的（人均、比例），而业务表全开 RLS —— 用户级客户端在
 * RLS 下只看得见自己，算出来的"人均"永远是 1。所以这里是 `lib/supabase/admin.ts`
 * 的第三个合法使用方（前两个：T3 定时同步、管理脚本）。
 *
 * ### 响应里的隐私边界
 * `perUser` 只带 `userId`（uuid）与数字，**不带邮箱**。端点本身受 secret 保护，
 * 但指标数据没必要带上可识别信息 —— 少存一份就少一处泄漏面。
 */

/** 指标绝不缓存：缓存一次就会拿着昨天的数做今天的判断。 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
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
        '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法跨用户统计指标',
      )
    }

    const supabase = createServiceRoleClient()
    const report = await loadMetrics(supabase)
    return jsonOk(request, report)
  } catch (error) {
    return internalError(request, error)
  }
}
