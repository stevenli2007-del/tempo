import type { CanvasFailureKind } from '@/lib/canvas/client'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { fetchCanvasCourses } from '@/lib/canvas/courses'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * Canvas 课程列表代理端点（API-Contract.md 第 6 节，P0-2-3）。
 *
 * 服务端拿着解密出的 token 去拉用户 Canvas 里的课程，供 P0-2-4 关联 UI 选择。
 * 前端从不直连 Canvas（会暴露 token 且受 CORS 限制）。
 *
 * ### 为什么不做筛选
 * 本端点忠实返回当前 token 可见的全部 active 课程（含 term）。是否过滤掉
 * "Default Term"/"Projects" 里的入学流程类模块（GBO / PartySafe 等）属于
 * P0-2-4 关联 UI 的产品决策 —— 到那一步 UI 才知道用户当前在关联哪门 Tempo 课，
 * 才知道哪些 Canvas 课程值得展示。代理层不做这个判断。
 *
 * ### 错误映射（已补进契约 §6）
 * - 未登录 → 401 `unauthenticated`
 * - 未连接 Canvas（无凭据）→ 404 `not_found`（与 credentials GET 同口径，ADR-010）
 * - Canvas 拒绝 token（401/403）→ 401 `credential_invalid`（token 失效，提示重新生成）
 * - Canvas 限流（429）→ 429 `rate_limited`
 * - Canvas 上游故障（5xx / 超时 / 网络 / 坏 JSON）→ 502 `upstream_error`
 *   不伪装成我们自己的 500 —— 这是"服务端代理第三方"失败，502 语义最准确。
 *
 * ### 🔴 响应红线（Security-Privacy 第 4 节）
 * 响应只含 `CanvasCourse`（externalId / name / term），token 绝不出现在任何响应里。
 * 解密出的 token 只存在于 `loadDecryptedCredential` 返回对象的生命周期内。
 */
export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const credential = await loadDecryptedCredential(supabase, user.id)
    if (!credential) {
      return jsonError(request, 404, 'not_found', '还没有连接 Canvas')
    }

    const result = await fetchCanvasCourses(credential.canvasDomain, credential.token)
    if (!result.ok) {
      return mapCanvasFailure(request, result.kind, result.message)
    }

    // 契约 §1.3：成功列表 = { data: [...] }。
    return jsonOk(request, { data: result.data })
  } catch (error) {
    return internalError(request, error)
  }
}

/** `canvasGet` 的失败分类 → HTTP 状态 + 契约错误码。 */
function mapCanvasFailure(
  request: Request,
  kind: CanvasFailureKind,
  message: string,
): ReturnType<typeof jsonError> {
  switch (kind) {
    case 'unauthorized':
      return jsonError(request, 401, 'credential_invalid', message)
    case 'not_found':
      return jsonError(request, 404, 'not_found', message)
    case 'rate_limited':
      return jsonError(request, 429, 'rate_limited', message)
    default:
      // server_error / timeout / network / parse —— 全部是 Canvas 上游不可用，
      // 不是 Tempo 的 bug。502 比 500 更诚实（详见上方文件头注释）。
      return jsonError(request, 502, 'upstream_error', message)
  }
}
