/**
 * URL → 文本端点（P0-3-27，**不落库、不调 LLM**）。
 *
 * `POST /api/v1/ingest/url` —— 收 `{ url }`，抓取该网页（+ 同源子页）并返回**合并纯文本**。
 *
 * ### 🔴 它只负责"链接 → 文本"，解析与写入一个字都不碰
 * 返回的文本由前端填回输入框，再走**现有的** `POST /api/v1/tasks/parse`（3-24 通道）→
 * 预览 → 确认 → `POST /api/v1/course-updates` 写入。这样"网页文本"与"手打文本"共用
 * 同一条解析路径，不会长出第二条会漂移的实现（ADR-015 / 3-24 边界）。
 *
 * ### 🔴 安全
 * 用户能让服务端去请求任意 URL —— 护栏全在 `lib/ingest/url-fetch.ts`：
 * 仅 http(s)、禁内网 / 本机（字面量 + DNS 解析 + 每跳复检）、超时 5s、单页 ≤1MB、
 * 只跟同源子页 ≤5。
 */

import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { fetchUrlText } from '@/lib/ingest/url-fetch'

/** `node:dns` / `node:net` 需要 Node runtime（不是 Edge）。 */
export const runtime = 'nodejs'

/** 输入长度上限（正常网页链接远短于此；挡住把整段文本当 url 传的花招）。 */
const MAX_URL_LENGTH = 2048

export async function POST(request: Request) {
  try {
    const { user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }
    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }

    const raw = body as Record<string, unknown>
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (url === '') {
      return jsonError(request, 400, 'bad_request', 'url 不能为空')
    }
    if (url.length > MAX_URL_LENGTH) {
      return jsonError(request, 400, 'bad_request', 'url 太长了')
    }

    const result = await fetchUrlText(url)
    if (!result.ok) {
      return jsonError(request, result.status, result.code, result.message)
    }

    return jsonOk(request, { data: { text: result.text, meta: result.meta } })
  } catch (error) {
    return internalError(request, error)
  }
}
