import { APP_OPEN_THROTTLE_MS, MANUAL_THROTTLE_MS, runCanvasSync } from '@/lib/sync/canvas-sync'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import type { SyncSummary, SyncTrigger } from '@/types/sync'

/** 客户端允许声明的触发来源。`scheduled` 只属于 `/sync/scheduled` + CRON_SECRET，这里传了就是 400。 */
const CLIENT_TRIGGERS = ['manual', 'app_open'] as const

/**
 * 解析可选的请求体 `{ "trigger": "manual" | "app_open" }`。
 *
 * - 空体 / 非 JSON / 无 trigger 字段 → 按 `manual` 处理（兼容 P0-2-5 时期的裸 POST）。
 * - 非法值（含 `scheduled`）→ 400 `validation_failed`。
 */
function parseTrigger(body: unknown): { trigger: SyncTrigger } | { error: string } {
  if (body === null || body === undefined) {
    return { trigger: 'manual' }
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' }
  }
  const trigger = (body as { trigger?: unknown }).trigger
  if (trigger === undefined) {
    return { trigger: 'manual' }
  }
  if (typeof trigger !== 'string' || !(CLIENT_TRIGGERS as readonly string[]).includes(trigger)) {
    return { error: "trigger 只能是 'manual' 或 'app_open'" }
  }
  return { trigger: trigger as SyncTrigger }
}

/**
 * `POST /api/v1/sync/now` —— 立即同步一次（API-Contract.md 第 6 节）。
 *
 * 遍历「已关联 Canvas 且未归档」的课程，串行拉取作业并对齐到 `tasks`。
 * 编排细节（串行 / 重试 / 熔断 / 状态落库）全在 `lib/sync/canvas-sync.ts`，
 * 这个路由只做三件事：鉴权 → 调编排 → 把编排结果翻译成 HTTP 语义。
 *
 * **触发来源与节流**（P0-2-6 起支持，Sync-Strategy §3 的 T1/T2）：
 * - `manual`（缺省，手动按钮）：30s 节流
 * - `app_open`（打开应用 / 重新聚焦自动触发）：60s 节流
 * - 两档共用同一个节流窗口（`findLastRunStartedAt` 不区分 trigger）——
 *   手动同步刚跑完，紧接着的自动同步会被拦下，这正是节流的本意。
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
 * ⚠️ 节流只对本端点生效：关联成功后按课程触发的那次同步走编排函数本身，**不做节流** ——
 * 用户刚点完关联就被"同步太频繁"拦下是最差的一种体验，而它的成本只有一个请求。
 */

export async function POST(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const rawBody: unknown = await request.json().catch(() => null)
    const parsed = parseTrigger(rawBody)
    if ('error' in parsed) {
      return jsonError(request, 400, 'validation_failed', parsed.error)
    }

    const outcome = await runCanvasSync(supabase, user.id, {
      trigger: parsed.trigger,
      throttleMs: parsed.trigger === 'app_open' ? APP_OPEN_THROTTLE_MS : MANUAL_THROTTLE_MS,
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
        case 'credential_expired':
          // 目前只在 T3 定时扫描里由 `runScheduledSync` 产生（Sync-Strategy §10：已过期跳过同步）。
          // `runCanvasSync` 自身对 status !== 'active' 统一返回 `credential_inactive`，
          // 但 `SyncSkipReason` 含此项，switch 必须穷尽，故保留此分支供未来直连路径复用。
          return jsonError(
            request,
            401,
            'credential_invalid',
            'Canvas 访问令牌已过期，请重新生成 token',
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
