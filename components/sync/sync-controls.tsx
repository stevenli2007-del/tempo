'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import type { SyncSummary } from '@/types/sync'

/**
 * Canvas 同步控件（P0-2-6，Sync-Strategy §3 的 T1 + T2）。
 *
 * - **T2 手动按钮**：点「同步 Canvas」→ `POST /api/v1/sync/now`（trigger: manual，30s 节流），
 *   即时展示结果（同步了几门课 / 有没有新变化 / 失败原因）。
 * - **T1 打开应用自动同步**：组件挂载（= 进入 dashboard）与页面重新可见时，
 *   自动发 trigger: app_open（60s 节流）。成功后 `router.refresh()` 静默换新数据。
 *
 * ### 两个刻意取舍
 * - **`hasCanvasLink = false` 时整个组件不渲染、自动同步也不发** ——
 *   没有关联任何 Canvas 课程的用户，同步注定返回"没有可同步的课"，
 *   每次打开都白发一个请求，还可能让新用户误以为必须连接 Canvas。
 * - **自动同步的 409 / 429 静默**（手动点击则全部展示）——
 *   "上一次还在跑 / 刚同步过"是自动触发的正常路径，弹出来只是噪声；
 *   而凭据失效这类**可行动**的错误两种触发都展示，
 *   这是 P0-2-7 完整同步状态条落地前的最小失败可见性（PRD F4：绝不静默展示旧数据）。
 *
 * ### 节流的分工（Sync-Strategy §6.4）
 * 客户端 60s 闸门只是**礼貌**（少发无谓请求）；**权威是服务端节流** ——
 * 直接打接口或多标签页绕过前端时，由 `/sync/now` 的 429 兜底。
 */

/** 客户端自动同步最小间隔。与服务端 `APP_OPEN_THROTTLE_MS` 一致，改一处要同步另一处。 */
const AUTO_SYNC_MIN_INTERVAL_MS = 60_000

/** 一次同步调用的结果，按「可展示」预分类。 */
type SyncCallResult =
  | { ok: true; summary: SyncSummary }
  | { ok: false; status: number; message: string }

/** 界面上要展示的一条反馈。 */
type Feedback = { kind: 'ok'; line: string } | { kind: 'error'; message: string }

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
  if (typeof b.status !== 'string' || typeof b.coursesSynced !== 'number' || !Array.isArray(b.failures)) {
    return null
  }
  return body as SyncSummary
}

function summarize(summary: SyncSummary): string {
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

async function callSyncNow(trigger: 'manual' | 'app_open'): Promise<SyncCallResult> {
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

export function SyncControls({ hasCanvasLink }: { hasCanvasLink: boolean }) {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  /** 防重入：自动同步与手动按钮共用一次进行中的同步。 */
  const syncingRef = useRef(false)
  /** 上次自动同步发起时间（客户端闸门；服务端节流才是权威）。 */
  const lastAutoSyncAtRef = useRef(0)

  const runSync = useCallback(
    async (trigger: 'manual' | 'app_open') => {
      if (syncingRef.current) {
        return
      }
      syncingRef.current = true
      setSyncing(true)
      try {
        const result = await callSyncNow(trigger)
        if (result.ok) {
          // 手动点击给完整反馈；自动同步成功保持安静，数据由 refresh 换新。
          if (trigger === 'manual') {
            setFeedback({ kind: 'ok', line: summarize(result.summary) })
          }
          router.refresh()
          return
        }
        // 409（上次还在跑）/ 429（刚同步过）是自动触发的正常路径，不值得打扰用户。
        const quiet = trigger === 'app_open' && (result.status === 409 || result.status === 429)
        if (!quiet) {
          setFeedback({ kind: 'error', message: result.message })
        }
      } finally {
        syncingRef.current = false
        setSyncing(false)
      }
    },
    [router],
  )

  // T1：挂载即同步（= 打开应用），页面重新可见时再同步（均受 60s 闸门约束）。
  // 用 setTimeout(0) 而不是直接调用 —— 避免在 effect 体内同步 setState
  // （eslint react-hooks/set-state-in-effect，P0-1-6 踩过）。
  useEffect(() => {
    if (!hasCanvasLink) {
      return
    }

    const maybeAutoSync = () => {
      if (document.visibilityState !== 'visible') {
        return
      }
      const now = Date.now()
      if (now - lastAutoSyncAtRef.current < AUTO_SYNC_MIN_INTERVAL_MS) {
        return
      }
      lastAutoSyncAtRef.current = now
      void runSync('app_open')
    }

    lastAutoSyncAtRef.current = Date.now()
    const mountTimer = setTimeout(maybeAutoSync, 0)
    document.addEventListener('visibilitychange', maybeAutoSync)
    return () => {
      clearTimeout(mountTimer)
      document.removeEventListener('visibilitychange', maybeAutoSync)
    }
  }, [hasCanvasLink, runSync])

  if (!hasCanvasLink) {
    return null
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void runSync('manual')}
        disabled={syncing}
      >
        {syncing ? '同步中…' : '同步 Canvas'}
      </Button>
      {feedback ? (
        feedback.kind === 'ok' ? (
          <p className="max-w-64 text-right text-xs text-muted-foreground">{feedback.line}</p>
        ) : (
          <p role="alert" className="max-w-64 text-right text-xs text-destructive">
            {feedback.message}
          </p>
        )
      ) : null}
    </div>
  )
}
