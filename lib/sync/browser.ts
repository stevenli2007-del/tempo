import type { SyncSummary } from '@/types/sync'

/**
 * 浏览器端调 `POST /api/v1/sync/now` 的**唯一**封装。
 *
 * P0-2-7 之前这段逻辑只存在于 `components/sync/sync-controls.tsx` 内部。
 * 状态条需要一个「重试」按钮（Sync-Strategy §9 对 failed / partial 的硬性要求），
 * 与其把响应解析再抄一遍，不如抽出来共用 —— 抄一遍的后果是两处对同一份响应
 * 给出不同的失败文案。
 *
 * ⚠️ 只在客户端组件里 import（它用的是浏览器 `fetch`）。
 */

/** 一次同步调用的结果，按「可展示」预分类。 */
export type SyncCallResult =
  | { ok: true; summary: SyncSummary }
  | { ok: false; status: number; message: string }

/** 从响应体里安全取 `error.message`（服务端是我们自己的，但响应可能被代理改写）。 */
function extractErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const message = (body as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  return fallback
}

/** 弱校验响应是不是 SyncSummary —— 形状不对宁可说"响应异常"也不渲染成 NaN。 */
function toSyncSummary(body: unknown): SyncSummary | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const b = body as Record<string, unknown>
  if (
    typeof b.status !== 'string' ||
    typeof b.coursesSynced !== 'number' ||
    !Array.isArray(b.failures)
  ) {
    return null
  }
  return body as SyncSummary
}

export async function callSyncNow(trigger: 'manual' | 'app_open'): Promise<SyncCallResult> {
  let res: Response
  try {
    res = await fetch('/api/v1/sync/now', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trigger }),
    })
  } catch {
    return { ok: false, status: 0, message: '网络错误，请稍后重试' }
  }

  const body: unknown = await res.json().catch(() => null)
  if (res.ok) {
    const summary = toSyncSummary(body)
    if (summary) {
      return { ok: true, summary }
    }
    return { ok: false, status: res.status, message: '同步完成，但响应格式异常' }
  }

  return {
    ok: false,
    status: res.status,
    message: extractErrorMessage(body, `同步失败（HTTP ${res.status}）`),
  }
}

/** 把一次成功的同步结果压成一行人话。 */
export function summarize(summary: SyncSummary): string {
  if (summary.coursesSynced === 0 && summary.coursesFailed === 0) {
    return '没有已关联 Canvas 的课程，本次未同步'
  }
  const changes: string[] = []
  if (summary.tasksCreated > 0) changes.push(`新增 ${summary.tasksCreated}`)
  if (summary.tasksUpdated > 0) changes.push(`更新 ${summary.tasksUpdated}`)
  if (summary.tasksDeleted > 0) changes.push(`移除 ${summary.tasksDeleted}`)
  const changeLine = changes.length > 0 ? changes.join('，') : '没有新变化'
  const failureLine =
    summary.failures.length > 0
      ? `；${summary.failures.length} 门失败（${summary.failures[0].courseName}：${summary.failures[0].message}）`
      : ''
  return `已同步 ${summary.coursesSynced} 门课，${changeLine}${failureLine}`
}
