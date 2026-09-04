import { MANUAL_THROTTLE_MS, runCanvasSync } from '@/lib/sync/canvas-sync'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import type { SyncSummary } from '@/types/sync'

/**
 * `POST /api/v1/sync/now` —— 立即同步一次（API-Contract.md 第 6 节）。
 *
 * 遍历「已关联 Canvas 且未归档」的课程，串行拉取作业并对齐到 `tasks`。
 * 编排细节（串行 / 重试 / 熔断 / 状态落库）全在 `lib/sync/canvas-sync.ts`，
 * 这个路由只做三件事：鉴权 → 调编排 → 把编排结果翻译成 HTTP 语义。
 *
 * ### 为什么"没跑起来"和"跑失败了"是两种不同的返回
 * | 情形 | HTTP | 理由 |
 * |---|---|---|
 * | 未连接 Canvas | 404 `not_found` | 没有凭据 = 这个资源不存在。与 `GET /canvas/credentials`、`GET /canvas/courses` 同口径（ADR-010：越权与不存在统一 404） |
 * | 凭据失效/过期 | 401 `credential_invalid` | 与 §6 课程列表"Canvas 拒绝该 token"同一个码，前端只需认一个错误去引导重新生成 |
 * | 上一次还在跑 | 409 `sync_in_progress` | 契约原文：不排队，直接拒绝 |
 * | 太频繁 | 429 `rate_limited` | 契约原文：429 + retryAfter。服务端独立校验，不靠前端置灰（Sync-Strategy §6.4） |
 * | 没有已关联的课 | 200 全零 | 不是错误，只是"没东西可同步"。返回 200 让前端不必为"零门课"写一条特殊分支 |
 *
 * ⚠️ 检查顺序（在 `runCanvasSync` 里）是有讲究的：锁 → 凭据是否存在 → 凭据是否可用 →
 * 有没有课可同步 → 节流。节流**排在最后**，因为它保护的是 Canvas 的限流额度 ——
 * 一个请求都不会发的时候（没连接 / token 失效 / 没关联课），回"同步太频繁"是错误引导。
 * 排在这个位置，每种返回都指向用户真正能做的那个动作。
 *
 * ⚠️ 节流只在本端点生效：关联成功后按课程触发的那次同步走编排函数本身，**不做节流** ——
 * 用户刚点完关联就被"同步太频繁"拦下是最差的一种体验，而它的成本只有一个请求。
 */

export async function POST(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const outcome = await runCanvasSync(supabase, user.id, {
      trigger: 'manual',
      throttleMs: MANUAL_THROTTLE_MS,
    })

    if ('skipped' in outcome) {
      switch (outcome.skipped) {
        case 'not_connected':
          return jsonError(request, 404, 'not_found', '还没有连接 Canvas，请先连接后再同步')
        case 'credential_inactive':
          return jsonError(
            request,
            401,
            'credential_invalid',
            'Canvas 连接已失效或已过期，请重新生成 token',
          )
        case 'in_progress':
          return jsonError(request, 409, 'sync_in_progress', '上一次同步还没结束，请稍后再试')
        case 'throttled':
          return jsonError(
            request,
            429,
            'rate_limited',
            `同步太频繁，请在 ${outcome.retryAfterSeconds} 秒后重试`,
            { retryAfter: outcome.retryAfterSeconds },
          )
        case 'no_courses':
          return jsonOk(request, emptySummary())
      }
    }

    return jsonOk(request, outcome.summary)
  } catch (error) {
    return internalError(request, error)
  }
}

/** 没有已关联课程时的响应：形状与真实结果一致，只是全是 0（前端不必特殊处理）。 */
function emptySummary(): SyncSummary {
  const now = new Date().toISOString()
  return {
    status: 'success',
    coursesSynced: 0,
    coursesFailed: 0,
    tasksCreated: 0,
    tasksUpdated: 0,
    tasksDeleted: 0,
    failures: [],
    startedAt: now,
    finishedAt: now,
  }
}
