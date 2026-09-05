'use client'

import { useState } from 'react'

import Link from 'next/link'

import type { CredentialExpiryView } from '@/lib/sync/expiry'

/**
 * Canvas token 过期提醒横幅（P0-2-8，Sync-Strategy §10「可关闭」）。
 *
 * 客户端组件 —— 唯一需要客户端状态的是「关闭」（per-session：本次会话内不再出现，
 * 刷新或下次打开重新出现）。提醒文案与级别由服务端算好传进来（`toCredentialExpiryView`），
 * 不在这里现算（防 hydration mismatch，沿用 P0-2-7 约定）。
 *
 * ### 为什么是客户端而不是服务端
 * 纯展示 + 一个关闭按钮本可服务端渲染，但关闭状态要活在客户端（`useState`）。
 * 整块做成客户端组件最简单；它不查库、不发请求，只是一块带关闭按钮的提示。
 *
 * ### 分级与 P0-2-7 失败横幅对齐
 * - `expired`（已过期）→ destructive 卡，语气"该续期了"，引导去重连。
 * - `warning`（T-14~T-0 内）→ 中性卡，给确切日期，不制造焦虑。
 * - `ok` → 调用方传 null 进来，这里直接不渲染。
 *
 * 引导动作复用 P0-2-7 的路径：链到第一门关联课的详情页
 * （那里有「Canvas 关联」区块，点「更改」→ 内嵌连接表单）。无关联课则链到第一门课详情页
 * （任意课详情页都有连接入口）；连课都没有就不给按钮，只提示。
 */
export function TokenExpiryBanner({
  view,
  reconnectHref,
}: {
  view: CredentialExpiryView | null
  reconnectHref: string | null
}) {
  const [dismissed, setDismissed] = useState(false)

  if (view === null || view.level === 'ok' || dismissed) {
    return null
  }

  const isExpired = view.level === 'expired'

  return (
    <div
      role="alert"
      className={
        isExpired
          ? 'relative rounded-lg border border-destructive/40 bg-card p-4'
          : 'relative rounded-lg border border-border bg-muted/40 p-4'
      }
      data-expiry-level={view.level}
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="关闭提醒"
        className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        ✕
      </button>

      <p className={isExpired ? 'text-sm font-medium text-destructive' : 'text-sm font-medium text-foreground'}>
        {view.message}
      </p>

      {reconnectHref ? (
        <div className="mt-3">
          <Link
            href={reconnectHref}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            去重新连接 Canvas
          </Link>
          <p className="mt-1 text-xs text-muted-foreground">
            在课程详情页点「更改」即可重新生成并粘贴新的访问令牌。
          </p>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          在任意课程详情页的「Canvas 关联」区块重新生成并粘贴新的访问令牌。
        </p>
      )}
    </div>
  )
}
