import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { buildAndSendReminder } from '@/lib/reminders/engine'

/**
 * `POST /api/v1/reminders/send` —— 手动触发**当前用户**的提醒（自测 / 想立刻看一眼时用）。
 *
 * ### 两个用途
 * - 默认（不带参数）：组装 + 发送自己的提醒（走完整频控/开关闸门）。
 * - `?preview=1`：只组装、回带邮件内容、**不发送、不更新时间戳、不卡闸门** ——
 *   用来在 Cloudflare 出站还没配好时也能看到邮件长什么样、验证排序与口径。
 *
 * ### 为什么用户态就能发自己的
 * 收件人就是当前登录用户本人，用 `getCurrentUser()` 拿 id 即可，不需要遍历全部用户。
 * 真正的"给所有人发"在 `scheduled` 端点（service role）。
 */

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const { user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const preview = new URL(request.url).searchParams.get('preview') === '1'
    const admin = createServiceRoleClient()
    // preview 时强制跳过闸门并回带内容；非 preview 走正常逻辑。
    const result = await buildAndSendReminder(admin, user.id, { preview, force: preview })

    return jsonOk(request, { data: result })
  } catch (error) {
    return internalError(request, error)
  }
}
