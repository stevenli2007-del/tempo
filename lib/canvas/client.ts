/**
 * 服务端 Canvas 请求封装（P0-2-2，Sync-Strategy.md 第 5 / 8 节）。
 *
 * ### 为什么必须是服务端
 * 前端直连 Canvas 会把 token 暴露给浏览器，且受 CORS 限制根本发不出去。
 * 所有 Canvas 请求一律经由这里，token 只存在于本次调用的参数里。
 *
 * ### 这个模块只做两件事
 * 1. 发请求、超时、解析 JSON
 * 2. **把失败归类**，让调用方（P0-2-5 同步）能按 Sync-Strategy §8 的表决策
 *
 * 它**不写数据库**、**不重试**、**不解密凭据**。
 * 重试与状态落库是同步编排层的职责，混进来会让"这次失败到底算谁的"说不清。
 *
 * ### 🔴 日志红线（Security-Privacy 第 8 节）
 * 本文件任何分支都不得打印 token、Authorization 头或完整 URL（URL 可能带 access_token 参数）。
 * 错误消息里出现的只有状态码、路径与 Canvas 返回的**错误码**，不含凭据本身。
 */

/** Sync-Strategy §5：单请求超时 10 秒。 */
const REQUEST_TIMEOUT_MS = 10_000

/** 失败的分类。调用方据此决定重试 / 标记 error / 跳过。 */
export type CanvasFailureKind =
  /** 401 / 403：凭证失效或被撤销。Sync-Strategy §8：绝不重试，立即停止该用户同步。 */
  | 'unauthorized'
  /** 404：资源不存在。跳过该资源，不影响同批次其他请求。 */
  | 'not_found'
  /** 429：限流。读 retryAfter 后退避，最多重试 1 次。 */
  | 'rate_limited'
  /** 5xx：服务端错误，可重试。 */
  | 'server_error'
  /** 请求超时。可重试。 */
  | 'timeout'
  /** 网络层失败（DNS / 连接重置）。可重试。 */
  | 'network'
  /** 响应不是预期 JSON。不重试 —— 记下错误，绝不能当成"没有数据"。 */
  | 'parse'

/** 哪些失败值得重试（Sync-Strategy §8 的表）。由调用方使用，本模块不自行重试。 */
export function isRetryable(kind: CanvasFailureKind): boolean {
  return kind === 'server_error' || kind === 'timeout' || kind === 'network'
}

export type CanvasResult<T> =
  | { ok: true; data: T; rateLimitRemaining: number | null }
  | {
      ok: false
      kind: CanvasFailureKind
      /** 给用户看的简短文案，不是堆栈。 */
      message: string
      /** 429 时 Canvas 给的等待秒数，没有则为 null。 */
      retryAfterSeconds: number | null
    }

/**
 * 向 Canvas 发一个 GET 请求。
 *
 * @param domain  Canvas 主机名，如 `bcourses.berkeley.edu`
 * @param token   明文 PAT（只在本次调用内存在）
 * @param path    API 路径，必须以 `/api/v1/` 开头
 */
export async function canvasGet<T>(
  domain: string,
  token: string,
  path: string,
): Promise<CanvasResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`https://${domain}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })

    // Sync-Strategy §6.2：读限流余量，调用方据此决定要不要继续发后续请求。
    const remaining = response.headers.get('x-rate-limit-remaining')
    const rateLimitRemaining = remaining === null ? null : Number(remaining)

    if (!response.ok) {
      return {
        ok: false,
        ...classifyHttpFailure(response.status, response.headers.get('retry-after')),
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      }
    }

    // 204 或空响应体：Canvas 的 DELETE 类接口会这样返回，GET 不该出现，但别崩。
    const text = await response.text()
    if (text.trim() === '') {
      return { ok: true, data: undefined as T, rateLimitRemaining }
    }

    try {
      return { ok: true, data: JSON.parse(text) as T, rateLimitRemaining }
    } catch {
      return {
        ok: false,
        kind: 'parse',
        message: 'Canvas 返回的内容不是合法 JSON',
        retryAfterSeconds: null,
      }
    }
  } catch (error) {
    return {
      ok: false,
      ...classifyTransportFailure(error),
      retryAfterSeconds: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP 状态码 → 失败分类 + 用户可见文案。 */
function classifyHttpFailure(
  status: number,
  retryAfter: string | null,
): { kind: CanvasFailureKind; message: string } {
  if (status === 401 || status === 403) {
    return { kind: 'unauthorized', message: 'Canvas 拒绝了这个 token，请重新生成并重新连接' }
  }
  if (status === 404) {
    return { kind: 'not_found', message: 'Canvas 上找不到该资源' }
  }
  if (status === 429) {
    return {
      kind: 'rate_limited',
      message: retryAfter
        ? `Canvas 限流，请 ${retryAfter} 秒后重试`
        : 'Canvas 限流，请稍后重试',
    }
  }
  if (status >= 500) {
    return { kind: 'server_error', message: `Canvas 服务暂时不可用（HTTP ${status}）` }
  }
  // 其余 4xx 一律当服务端错误以外的不可重试失败，交给调用方跳过。
  return { kind: 'parse', message: `Canvas 返回了未预期的响应（HTTP ${status}）` }
}

/** fetch 抛出的异常 → 失败分类。超时（AbortError）与网络错误分开。 */
function classifyTransportFailure(error: unknown): { kind: CanvasFailureKind; message: string } {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'timeout', message: '请求 Canvas 超时，请稍后重试' }
  }
  return { kind: 'network', message: '无法连接到 Canvas，请检查网络后重试' }
}

/** `Retry-After` 可能是秒数，也可能是 HTTP 日期。取不到就返回 null。 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds : null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const deltaMs = date.getTime() - Date.now()
  return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : null
}
