import { canvasGet, isRetryable, type CanvasFailureKind, type CanvasResult } from '@/lib/canvas/client'

/**
 * 带重试与预算的 Canvas 翻页拉取（P0-3-25 从 `canvas-sync.ts` 抽出来的）。
 *
 * ### 为什么抽出来
 * 作业（`lib/canvas/assignments.ts`）与公告（`lib/canvas/announcements.ts`）是**两个端点、
 * 同一套纪律**：串行、单次同步 ≤ 20 请求、≤ 60 秒、单资源 ≤ 3 页、按 Sync-Strategy §8
 * 的表重试。留在同步编排里各写一份，两份会慢慢漂开 ——
 * 「作业按 §8 重试、公告不重试」这种差异没有任何人会发现，直到某天公告总是少几条。
 *
 * 抽出来之后：**要什么数据**仍在各自的 `lib/canvas/*.ts`，**怎么调度请求**只在这里一份。
 *
 * ### 🔴 继承自 P0-2-5 的三条硬约束（改这里就是改全站的 Canvas 纪律）
 * 1. **必须串行**：调用方循环调用本函数，绝不 `Promise.all`
 *    —— Canvas 官方文档写明并发请求有 "additional pre-flight penalty"（Sync-Strategy §2）。
 * 2. **三级熔断**：请求数 / 总时间 / 单资源页数，任一触顶就停并标 `complete: false`。
 * 3. **401 / 403 绝不重试**（`isRetryable` 不覆盖 `unauthorized`），立刻让调用方停止。
 *
 * ### 日志红线（Security-Privacy §8）
 * 不打印 token、Authorization 头或完整 URL。
 */

/** Sync-Strategy §5：单次同步 Canvas 请求上限 20 个。 */
export const MAX_REQUESTS_PER_SYNC = 20
/** Sync-Strategy §5：单次同步总预算 60 秒（Vercel 上限 300s，留 5 倍余量）。 */
export const SYNC_TIME_BUDGET_MS = 60_000
/** Sync-Strategy §8：可重试失败的退避 1s → 4s（指数 + 抖动）。 */
const RETRY_DELAYS_MS = [1_000, 4_000]
/** 429 的等待上限：Canvas 让等 60 秒时不等（会吃掉整个时间预算），留给下一轮。 */
const MAX_RATE_LIMIT_WAIT_MS = 10_000

/** 跨资源共享的请求预算。由同步编排创建、传给每一次拉取。 */
export type CanvasBudget = { requestsUsed: number }

/**
 * 拉取结果。
 *
 * @param complete `false` = **没拿全**（翻到页数上限 / 请求预算耗尽 / 时间到）。
 *   调用方必须据此跳过"外部已删除"类判定 —— 一次不完整的拉取会把没拿到的行
 *   误判成"外部删掉了它们"（作业侧会误软删，公告侧会误判为"没发过"）。
 */
export type CanvasFetchResult<T> =
  | { ok: true; items: T[]; complete: boolean }
  | { ok: false; kind: CanvasFailureKind; message: string }

/**
 * 单页请求的结果。
 *
 * ⚠️ 显式写出来而不是让 TS 推断：`fetchCanvasPages` 里
 * `const result = await requestWithRetry<T>(...)` 会被推成
 * `any`（TS7022，泛型参数在自己的初始化式里被间接引用）——
 * 那样 `result.items` 就完全失去类型，`map()` 的返回值不再被检查。
 */
type SinglePageResult<T> =
  | { ok: true; items: T[]; nextPath: string | null }
  | { ok: false; kind: CanvasFailureKind; message: string }

/**
 * 沿 `Link` 头翻页拉取，直到没有下一页 / 触顶。
 *
 * @param map 原始响应 → 业务对象的映射（`toCanvasAssignments` / `toCanvasAnnouncements`）。
 *   放在参数里是为了让本模块完全不认识业务形状。
 */
export async function fetchCanvasPages<T>(input: {
  domain: string
  token: string
  /** 第一页路径（各 `lib/canvas/*.ts` 的 `*Path()` 产出）。 */
  path: string
  budget: CanvasBudget
  startedAtMs: number
  maxPages: number
  map: (raw: unknown) => T[]
}): Promise<CanvasFetchResult<T>> {
  const { domain, token, budget, startedAtMs, maxPages, map } = input

  let path: string | null = input.path
  let pages = 0
  const items: T[] = []

  while (path !== null) {
    if (pages >= maxPages) return { ok: true, items, complete: false }
    if (budget.requestsUsed >= MAX_REQUESTS_PER_SYNC) return { ok: true, items, complete: false }
    if (Date.now() - startedAtMs > SYNC_TIME_BUDGET_MS) {
      return { ok: true, items, complete: false }
    }

    const result: SinglePageResult<T> = await requestWithRetry<T>(
      domain,
      token,
      path,
      budget,
      startedAtMs,
      map,
    )
    if (!result.ok) {
      return { ok: false, kind: result.kind, message: result.message }
    }

    items.push(...result.items)
    pages += 1
    path = result.nextPath
  }

  return { ok: true, items, complete: true }
}

/**
 * 发一个请求，按 Sync-Strategy §8 的表重试。
 *
 * - 5xx / 超时 / 网络 → 最多 2 次，退避 1s → 4s（加抖动，避免多用户同时重试撞车）
 * - 429 → 最多 1 次，等 `Retry-After`（封顶 10s，超过就放弃留给下一轮）
 * - 401/403 / 404 / 解析异常 → **不重试**
 */
async function requestWithRetry<T>(
  domain: string,
  token: string,
  path: string,
  budget: CanvasBudget,
  startedAtMs: number,
  map: (raw: unknown) => T[],
): Promise<SinglePageResult<T>> {
  let attempt = 0
  let waitMs = 0

  for (;;) {
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    if (Date.now() - startedAtMs > SYNC_TIME_BUDGET_MS) {
      return { ok: false, kind: 'timeout', message: '同步超出时间预算，已停止' }
    }

    budget.requestsUsed += 1
    const result: CanvasResult<unknown> = await canvasGet<unknown>(domain, token, path)

    if (result.ok) {
      return { ok: true, items: map(result.data), nextPath: result.nextPath }
    }

    // 不重试的三类：凭证失效 / 资源不存在 / 响应结构异常。
    if (!isRetryable(result.kind) && result.kind !== 'rate_limited') {
      return { ok: false, kind: result.kind, message: result.message }
    }

    const maxRetries = result.kind === 'rate_limited' ? 1 : RETRY_DELAYS_MS.length
    if (attempt >= maxRetries) {
      return { ok: false, kind: result.kind, message: result.message }
    }

    waitMs =
      result.kind === 'rate_limited'
        ? Math.min((result.retryAfterSeconds ?? 5) * 1000, MAX_RATE_LIMIT_WAIT_MS)
        : RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250)
    attempt += 1
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
