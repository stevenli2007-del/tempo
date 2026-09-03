'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/**
 * Demo Workspace 的入口 / 清空控件（P0-1-10）。
 *
 * - 还没生成过示例（`hasDemo = false`）：渲染「先看看效果」CTA，点一下调
 *   `POST /api/v1/demo/seed`，成功后 `router.refresh()` 让服务端组件重渲染出示例课程。
 * - 已生成示例（`hasDemo = true`）：渲染「清空示例数据」小按钮，调
 *   `DELETE /api/v1/demo`，级联清掉示例课程及其子数据。
 *
 * `variant` 控制外观：
 * - `cta`：空状态里的大按钮（PRD §6 要求的冷启动主入口）
 * - `inline`：顶栏里的小按钮（已有真实课程时也能随时清空示例）
 */
export function DemoControls({
  hasDemo,
  variant,
}: {
  hasDemo: boolean
  variant: 'cta' | 'inline'
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSeed() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/v1/demo/seed', { method: 'POST' })
      // 409 已在别处生成过（多标签页/重复点），直接刷新即可。
      if (res.status === 409) {
        router.refresh()
        return
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : `生成失败（HTTP ${res.status}）`)
        return
      }
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  async function handleClear() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/v1/demo', { method: 'DELETE' })
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : `清空失败（HTTP ${res.status}）`)
        return
      }
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  if (!hasDemo) {
    if (variant !== 'cta') return null
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          第一次用？先看一个真实 syllabus 被 Tempo 拆开的样子。
        </p>
        <button
          type="button"
          onClick={() => void handleSeed()}
          disabled={loading}
          className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {loading ? '生成中…' : '✨ 先看看效果'}
        </button>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  // 已生成示例：只渲染清空按钮（inline 小按钮）。
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void handleClear()}
        disabled={loading}
        className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
      >
        {loading ? '清空中…' : '清空示例数据'}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
