import { loadDataSummary } from '@/lib/account/data-summary'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * 「我们存了你什么」清单（P0-3-2，契约 §7）。
 *
 * 设置页是服务端渲染，直接调 `loadDataSummary()` 而不 fetch 自己 ——
 * 端点存在的意义是让这个清单可被脚本/验收直接核对，不是给页面自己绕一圈用。
 */
export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const summary = await loadDataSummary(supabase, user.id)
    return jsonOk(request, summary)
  } catch (error) {
    return internalError(request, error)
  }
}
