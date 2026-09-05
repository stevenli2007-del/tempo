'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { callSyncNow } from '@/lib/sync/browser'

/**
 * 同步状态条里的「重试 / 立即同步」按钮（P0-2-7，Sync-Strategy §9 的硬性要求）。
 *
 * 为什么不是复用标题行的 `SyncControls`：那组件身上挂着一个**挂载即自动同步**的 effect，
 * 在同一个页面渲染两个实例会同时发两趟同步（第二个只会撞锁拿到 409）。
 * 这个按钮刻意只做一件事：手动打一次 `manual` 触发 + 刷新页面。
 *
 * 触发档位固定 `manual`（30s 节流），与标题行按钮共用一个服务端窗口 ——
 * 刚点过标题行再来点这里会拿到 429，那也是正确答案（保护 Canvas 额度）。
 */
export function SyncRetryButton({ label = '重试' }: { label?: string }) {
  const router = useRouter()
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setError(null)
    setIsSyncing(true)
    try {
      const result = await callSyncNow('manual')
      if (!result.ok) {
        setError(result.message)
        return
      }
      // 成功不在这里展示摘要 —— 状态条本身会随 refresh 变成新文案，
      // 再多一行"已同步 N 门课"是重复信息。
      router.refresh()
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={isSyncing}
        className="h-8 shrink-0 rounded-md border border-border bg-card px-3 text-sm text-foreground disabled:opacity-50"
      >
        {isSyncing ? '同步中…' : label}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
