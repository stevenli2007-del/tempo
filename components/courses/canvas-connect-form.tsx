'use client'

import { useState } from 'react'

/**
 * 连接 Canvas 的表单（P0-2-4）。
 *
 * 调 `POST /api/v1/canvas/credentials`（P0-2-2 交付）：token 走 HTTPS 到我们自己的
 * 服务端，加密后入库，**之后永不再下发**（响应里没有任何密钥字段）。
 * 前端从不直连 Canvas —— 那既会暴露 token，也会被 CORS 挡住。
 *
 * ### 三个字段为什么都要用户填
 * - `canvasDomain`：服务端会拿它发请求，所以必须校验（SSRF 防护在服务端）。
 *   默认填 `bcourses.berkeley.edu`（伯克利），别的学校能改。
 * - `token`：bCourses → Settings → "+ New Access Token" 生成。
 * - `expiresAt`：**必填**。2026-09-04 实测 bCourses 强制填过期时间、上限 90 天，
 *   用户生成 token 时一定看得到。P0-2-8 的过期提醒要用这个真实值，
 *   不填就等于让系统将来靠猜。
 *
 * ### 🔴 前端红线
 * token 只在这一次请求里出现：不进 localStorage、不打日志、不进 error message。
 * 表单用 `type="password"` + `autoComplete="off"`，提交成功即 `form.reset()`，
 * 免得明文 token 留在 DOM 里。
 */

const INPUT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

const LABEL_CLASS = 'block text-sm font-medium text-foreground'

export function CanvasConnectForm({
  onConnected,
  onCancel,
}: {
  /** 凭证保存成功后回调（父组件接着去拉课程列表）。 */
  onConnected: () => void
  onCancel: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = event.currentTarget
    const text = (key: string) => String(new FormData(form).get(key) ?? '').trim()

    const canvasDomain = text('canvasDomain')
    const token = text('token')
    const expiresLocal = text('expiresAt')

    // datetime-local 是本地时区的"墙上时间"，交给 Date 解析成绝对时刻再转 ISO。
    // 直接把 "2026-11-01T00:00" 当 ISO 传会给服务端一个按 UTC 解释的值（差 7/8 小时）。
    const expiresAt = new Date(expiresLocal).toISOString()

    setIsPending(true)
    try {
      const response = await fetch('/api/v1/canvas/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasDomain, token, expiresAt }),
      })

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : `连接失败（HTTP ${response.status}）`)
        return
      }

      // 清掉表单里的明文 token，别让它继续留在 DOM。
      form.reset()
      onConnected()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>打开 bCourses → Account → Settings</li>
        <li>在 Access Tokens 一栏点「+ New Access Token」，过期时间必填（上限 90 天）</li>
        <li>生成后立刻复制 token 粘到下面 —— 关掉页面就再也看不到了</li>
      </ol>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="canvasDomain" className={LABEL_CLASS}>
            Canvas 域名 <span className="text-destructive">*</span>
          </label>
          <input
            id="canvasDomain"
            name="canvasDomain"
            required
            defaultValue="bcourses.berkeley.edu"
            placeholder="bcourses.berkeley.edu"
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="expiresAt" className={LABEL_CLASS}>
            token 过期时间 <span className="text-destructive">*</span>
          </label>
          <input
            id="expiresAt"
            name="expiresAt"
            type="datetime-local"
            required
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="token" className={LABEL_CLASS}>
          token <span className="text-destructive">*</span>
        </label>
        <input
          id="token"
          name="token"
          type="password"
          required
          autoComplete="off"
          placeholder="粘贴在 bCourses 生成的 token"
          className={INPUT_CLASS}
        />
        <p className="text-xs text-muted-foreground">
          token 只发给我们自己的服务端并加密存储，不会出现在任何响应里。
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {isPending ? '连接中…' : '连接 Canvas'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="h-9 rounded-md px-3 text-sm text-muted-foreground"
        >
          取消
        </button>
      </div>
    </form>
  )
}
