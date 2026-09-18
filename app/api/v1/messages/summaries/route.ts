import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { ensureSummaries } from '@/lib/messages/summary/generate'
import { validateSummaryRequest } from '@/lib/messages/summary/normalize'

/**
 * 公告要点的**懒生成**端点（P0-3-25b）。
 *
 * `POST /api/v1/messages/summaries` body `{ messageIds: string[], locale?: 'zh-CN' | 'en' }`
 *
 * ### 为什么是 POST 而不是"在 GET /messages 里顺手生成"
 * GET 必须**快且无副作用**（消息栏首屏靠它），而生成要点是一次 3 秒起步的模型调用。
 * 把它塞进 GET 会让"打开消息栏"变成"等模型"。（同步路径同理，见 `generate.ts` 文件头。）
 * 分成两步还有一层好处：客户端**先拿到消息**（原文、按钮立刻可用），
 * 要点晚几秒补进来 —— 也就是说模型挂了也完全不影响消息栏能用。
 *
 * ### 幂等
 * 缓存命中就直接返回，不重复调用模型。所以这端点"多打几次"是安全的
 * （两个标签页同时打开最多各算一次，upsert 收敛）。
 *
 * ### 🔴 归属靠会话 client
 * 入参 id 来自**客户端**，因此绝不能用 service role：那样 `.in('id', ids)` 会读到
 * 别人的消息、并用别人的公告去跑模型。这里用 `getCurrentUser()` 的会话 client，
 * 别人的 id 直接查不出来（静默不在候选里）—— 不回 404，不确认 id 是否存在（ADR-010）。
 *
 * ### 失败怎么表达
 * - 输入不合法 → 400（明确，不静默回退）；
 * - 读库失败（迁移没跑 / 连接问题）→ 502 + 日志：要点生成不了这件事必须留痕，
 *   否则表现是"要点一直不出现"而没有任何线索；
 * - **单条生成失败不进 HTTP 状态**：它落在响应的 `meta.failed` 里，
 *   因为"3 条里 1 条没算出来"不是请求失败，客户端也不该为它弹错。
 */

export async function POST(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }

    const parsed = validateSummaryRequest(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }

    const outcome = await ensureSummaries({
      supabase,
      userId: user.id,
      messageIds: parsed.value.messageIds,
      locale: parsed.value.locale,
    })

    if (outcome.error) {
      return jsonError(request, 502, 'summary_unavailable', `要点暂时无法生成：${outcome.error}`)
    }

    return jsonOk(request, {
      data: {
        summaries: outcome.summaries.map(({ messageId, summary }) => ({
          messageId,
          ...summary,
        })),
      },
      meta: {
        eligible: outcome.eligible,
        cached: outcome.cached,
        generated: outcome.generated,
        failed: outcome.failed,
        // 还没轮到的条数（本轮上限之外）。客户端据此知道"再打开一次会继续补"，
        // 而不是以为剩下的永远不会出现。
        remaining: outcome.remaining,
      },
    })
  } catch (error) {
    return internalError(request, error)
  }
}
