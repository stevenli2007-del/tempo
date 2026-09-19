import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { ensureExamProposals } from '@/lib/messages/exam-proposals/ensure'

/**
 * 公告**考试提案**的懒补端点（P0-3-29）。
 *
 * `POST /api/v1/messages/exam-proposals` body `{ messageIds: string[] }`
 *
 * ### 与 `POST /messages/drift` 的关系
 * 同一条范式（ADR-024：打开消息栏后才算、不进同步路径、单条失败不进 HTTP 状态），
 * 但**成本低得多**：这里只打模型，不下载文件。所以写在另一个端点里 ——
 * 混进 drift 会让"下载 + 抽文本 + 30k 字符"那条重路径的限流参数套到这条轻路径上。
 *
 * ### 🔴 它不禁用「确认」
 * 与漂移不同：公告即使没算出提案也能确认（applier 会退回"确认那一刻解析"）。
 * 所以这个端点挂了的表现只是"看不到 9/28 → 9/27 那行"，不是"按钮变灰"。
 *
 * ### 幂等
 * 资格判定要求 `examProposalsStatus` 不是 `ready` / `clean` / `failed`，
 * 算完的会改写状态，多打几次最多重算一次刚好被写掉的那几条。
 */

/** 客户端能送来的 id 上限（服务端还有一道，见 `ensure.ts` 的 `MAX_INPUT_IDS`）。 */
const MAX_MESSAGE_IDS = 50

function parseBody(body: unknown): { ok: true; messageIds: string[] } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const raw = (body as { messageIds?: unknown }).messageIds
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'messageIds 必须是字符串数组' }
  }
  if (raw.length === 0) {
    return { ok: false, message: 'messageIds 不能为空' }
  }
  if (raw.length > MAX_MESSAGE_IDS) {
    return { ok: false, message: `一次最多算 ${MAX_MESSAGE_IDS} 条` }
  }
  const messageIds: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      return { ok: false, message: 'messageIds 里出现了非字符串或空值' }
    }
    messageIds.push(item.trim())
  }
  return { ok: true, messageIds }
}

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

    const parsed = parseBody(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }

    const outcome = await ensureExamProposals({
      supabase,
      userId: user.id,
      messageIds: parsed.messageIds,
    })

    if (outcome.error) {
      return jsonError(request, 502, 'exam_proposals_unavailable', `提案暂时无法核对：${outcome.error}`)
    }

    return jsonOk(request, {
      // 整条 Message（不是视图）—— 与 `POST /messages/drift` 同一个形状。
      data: { messages: outcome.messages },
      meta: {
        eligible: outcome.eligible,
        computed: outcome.computed,
        failed: outcome.failed,
        deferred: outcome.deferred,
        remaining: outcome.remaining,
      },
    })
  } catch (error) {
    return internalError(request, error)
  }
}
