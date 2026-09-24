import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { loadNoteCount } from '@/lib/notes/store'

/**
 * 音符总数（`GET /api/v1/notes`）—— 侧栏那个「♪ N」的唯一取数口。
 *
 * ### 为什么是**只读**端点
 * 记入不在这里做。两个记入点各司其职（都是幂等的）：
 *   ① `PATCH /api/v1/tasks/:id` —— 用户手勾完成，当场记一枚；
 *   ② 总览页服务端渲染 —— 懒补 Canvas 代判完成的那部分。
 * 把写入塞进 GET 会让「刷新一下数字就变了」变成可能 —— 而 GET 在浏览器里
 * 会被预取 / 重试，副作用不可控。
 *
 * ### 失败必须可见（R3）
 * 查不到就 500 并把原因回出去，不返回 0 —— 静默的 0 会被读成"你一枚都没有"，
 * 那是把系统故障伪装成用户的数据。侧栏拿到非 2xx 时**不显示数字**（而不是显示 0）。
 */
export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { total, error } = await loadNoteCount(supabase, user.id)
    if (error) {
      throw new Error(error)
    }

    return jsonOk(request, { total })
  } catch (error) {
    return internalError(request, error)
  }
}
