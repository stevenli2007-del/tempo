import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { ensureDrift } from '@/lib/syllabus-drift/ensure'

/**
 * 大纲漂移的**懒补**端点（P0-3-20）。
 *
 * `POST /api/v1/messages/drift` body `{ messageIds: string[] }`
 *
 * ### 为什么是 POST 而不是"在 GET /messages 里顺手算"
 * 与公告要点（3-25b）同一条理由，但更硬：算一条差异要**下载那份 PDF + 抽文本 +
 * 一次带 30k 字符的模型调用**（几秒到十几秒）。塞进 GET 会把"打开消息栏"
 * 变成"等模型 + 等腰几 MB 的文件"。分成两步之后，客户端**先拿到提案**
 * （标题、原文链接、按钮都在），差异晚几秒补进 `payload.details` ——
 * 也就是说这条链路挂了也完全不影响消息栏能用。
 *
 * ### 与 ADR-026 的关系
 * 这个端点**就是** ADR-026 说的"用户触发的路径"：下载只发生在这里，
 * 而且只下载消息指向的**那一个**文件。原文与抽取出的全文不落库、不落盘、不进日志
 * （落库的只有差异结论与 ≤200 字符的逐字摘录）。
 *
 * ### 幂等
 * 资格判定要求 `payload.driftStatus === 'pending'`，算完的会被改写状态，
 * 所以这端点"多打几次"是安全的（最多重算一次刚好被写掉的那几条）。两个标签页
 * 同时打开最多各算一次，写回收敛到同一份结论。
 *
 * ### 🔴 归属靠会话 client
 * 入参 id 来自**客户端**，因此绝不能用 service role：那样 `.in('id', ids)` 会读到
 * 别人的消息、并用别人的大纲去跑模型。会话 client 下别人的 id 直接查不出来
 * （静默不在候选里）—— 不回 404、不确认 id 是否存在（ADR-010）。
 *
 * ### 失败怎么表达
 * - 输入不合法 → 400（明确，不静默回退）；
 * - 读库失败（迁移没跑 / 连接问题）→ 502 + 日志：核对不了这件事必须留痕，
 *   否则表现是"那行「正在核对差异…」永远不动"而没有任何线索；
 * - **单条失败不进 HTTP 状态**：它落在 `payload.driftStatus='failed'` 与
 *   响应的 `meta` 里。"3 条里 1 条读不出来"不是请求失败，客户端不该为它弹错。
 */

/** 客户端能送来的 id 上限（服务端还有一道，见 `ensure.ts` 的 `MAX_INPUT_IDS`）。 */
const MAX_MESSAGE_IDS = 50

/**
 * 解析请求体。
 *
 * ⚠️ 刻意**不接受**空数组（400 而不是 200 空结果）：真跑起来时客户端只在
 * `needsDrift` 为真时才请求，送空数组说明调用方的判定已经坏了 ——
 * 回 200 会把这个 bug 藏起来。
 */
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
    return { ok: false, message: `一次最多核对 ${MAX_MESSAGE_IDS} 条` }
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

    const outcome = await ensureDrift({
      supabase,
      userId: user.id,
      messageIds: parsed.messageIds,
    })

    if (outcome.error) {
      return jsonError(request, 502, 'drift_unavailable', `差异暂时无法核对：${outcome.error}`)
    }

    return jsonOk(request, {
      // 整条 Message（不是视图）—— 与 `GET /api/v1/messages` 同一个形状。
      // 差异就住在 payload 里，客户端按 id 替换本地那几条即可，
      // 视图交给同一个 `toMessageView()` 现算（不允许两处各派生一遍）。
      data: { messages: outcome.messages },
      meta: {
        eligible: outcome.eligible,
        computed: outcome.computed,
        failed: outcome.failed,
        // 暂时性失败（网络 / 5xx / 限流）：**状态没动**，下次打开消息栏会重试。
        // 与 `failed` 分开报，客户端与排障才能分清"读不出来"和"刚才网抖了"。
        deferred: outcome.deferred,
        // 还没轮到的条数（本轮上限之外）。客户端据此知道"再补一轮还有"，
        // 而不是以为剩下的永远不会算。
        remaining: outcome.remaining,
      },
    })
  } catch (error) {
    return internalError(request, error)
  }
}
