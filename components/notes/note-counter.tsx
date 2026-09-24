'use client'

import { useEffect, useState } from 'react'

import { useT } from '@/lib/i18n/use-i18n'
import { NOTES_UPDATED_EVENT } from '@/lib/notes/event'

/**
 * 侧栏的音符计数（P0-5-4）。
 *
 * ### 为什么在这里自己 fetch，而不是从页面把数字传下来
 * `Sidebar` 在 `AppShell` 里全局渲染，页面并不 owning 它 —— 与侧栏的
 * 待处理徽标同一个理由（见 `sidebar.tsx` 的那段注释）。
 * 挂载时拉一次 `GET /api/v1/notes`，并监听 `tempo-notes-updated`
 * （标记完成时 dispatch）即时刷新。
 *
 * ### 🔴 查不到就**不显示**，绝不显示 0
 * 0 有两种含义：真的一枚都没有 / 查询挂了。把后者显示成 0，
 * 用户会读成"我什么都没做完"—— 把系统故障伪装成他的数据（R3）。
 * 端点失败时返回非 2xx，这里一律不渲染。
 *
 * ### 为什么不做成"进度"或"等级"
 * 它就是一个已完成事项的计数，没有目标、没有下一档、没有百分比。
 * 任何"距离下一级还差 N"都是把用户往回拉的机制，与 ADR-016 相反。
 */
export function NoteCounter() {
  const t = useT()
  /** `null` = 还没拿到（首次渲染不画，避免闪一个 0 出来）。 */
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      try {
        const response = await fetch('/api/v1/notes')
        if (!response.ok) return
        const body: unknown = await response.json()
        const next =
          typeof body === 'object' && body !== null && 'total' in body
            ? (body as { total?: unknown }).total
            : undefined
        if (!cancelled && typeof next === 'number') setTotal(next)
      } catch {
        // 网络抖动不影响导航 —— 与待处理徽标同一条纪律（辅助信息，查不动就不显示）。
      }
    }

    void refresh()
    const onUpdated = () => void refresh()
    window.addEventListener(NOTES_UPDATED_EVENT, onUpdated)
    return () => {
      cancelled = true
      window.removeEventListener(NOTES_UPDATED_EVENT, onUpdated)
    }
  }, [])

  if (total === null) return null

  return (
    <p
      className="flex items-center gap-1.5 text-xs text-ink-muted"
      title={t('notes.total', { n: total })}
    >
      <span aria-hidden className="text-[13px] leading-none">
        ♪
      </span>
      {/* tabular-nums：数字变化时整块不左右抖。 */}
      <span aria-hidden className="tabular-nums">
        {total}
      </span>
      <span className="sr-only">
        {t('notes.label')}：{t('notes.total', { n: total })}
      </span>
    </p>
  )
}
