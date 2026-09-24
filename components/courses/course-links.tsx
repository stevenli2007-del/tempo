'use client'

/**
 * 外部课程链接监控（P0-5-3 客户端 UI）。
 *
 * 贴链接 → 调 `POST /api/v1/courses/:id/links`；列表 / 删除走 GET / DELETE。
 * 只展示 URL + 备注 + 可见检查状态（R3：失败也要看得见）；原文既不下载也不展示。
 *
 * 🔴 本组件**不 import 服务端抓取模块**：指纹比对在服务端 Cron 跑，
 * 这里只渲染用户态 API 返回的结果，避免把 `node:dns` 一类服务端依赖拖进客户端包。
 */

import { useState } from 'react'

import { SCHOOL_TIME_ZONE } from '@/lib/time'
import { isHttpUrl } from '@/lib/course-links/url'
import type { CourseLinkView, LinkCheckStatus } from '@/lib/course-links/store'
import { t, type MessageKey } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'

/** 状态 → i18n key（ok 需在渲染处补 `when` 变量，单独处理）。 */
const STATUS_KEY: Record<LinkCheckStatus, MessageKey> = {
  pending: 'links.statusPending',
  ok: 'links.statusOk',
  unreachable: 'links.statusUnreachable',
  blocked: 'links.statusBlocked',
  unsupported: 'links.statusUnsupported',
}

/** 绝对时间戳展示（给定 iso，不含"现在"，服务端/客户端算同一串 → 无 hydration 错位）。 */
function formatCheckTime(iso: string, lang: Lang): string {
  const fmt = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: SCHOOL_TIME_ZONE,
  })
  return fmt.format(new Date(iso))
}

type CourseLinksProps = {
  courseId: string
  lang: Lang
  links: CourseLinkView[]
  error: string | null
}

export function CourseLinks({ courseId, lang, links: initialLinks, error: initialError }: CourseLinksProps) {
  const [links, setLinks] = useState<CourseLinkView[]>(initialLinks)
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(initialError)

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    const raw = url.trim()
    // 轻量预检（真正的 SSRF/协议校验在服务端，那里是权威）。
    // ⚠️ 判据与浮窗共用 `isHttpUrl()` —— 别在这里另写一份正则。
    if (!isHttpUrl(raw)) {
      setFormError(t(lang, 'links.invalidUrl'))
      return
    }
    setAdding(true)
    try {
      const res = await fetch(`/api/v1/courses/${courseId}/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: raw, label: label.trim() || null }),
      })
      const data = (await res.json().catch(() => null)) as { link?: CourseLinkView } | null
      if (!res.ok) {
        if (res.status === 409) {
          setFormError(t(lang, 'links.duplicate'))
        } else {
          const msg = (data as { error?: { message?: string } } | null)?.error?.message
          setFormError(msg ?? t(lang, 'links.addFailed', { status: res.status }))
        }
        return
      }
      if (data?.link) setLinks((prev) => [data.link as CourseLinkView, ...prev])
      setUrl('')
      setLabel('')
    } catch {
      setFormError(t(lang, 'links.addFailed', { status: 0 }))
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/v1/courses/${courseId}/links/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setLinks((prev) => prev.filter((item) => item.id !== id))
      } else {
        setLoadError(t(lang, 'common.actionFailed', { status: res.status }))
      }
    } catch {
      setLoadError(t(lang, 'common.networkError'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-medium text-foreground">{t(lang, 'links.title')}</h2>
      {links.length > 0 && (
        <p className="mb-3 text-xs text-ink-muted">{t(lang, 'links.count', { n: links.length })}</p>
      )}

      <form onSubmit={handleAdd} className="mb-4 space-y-2">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t(lang, 'links.urlPlaceholder')}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t(lang, 'links.labelPlaceholder')}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={adding || url.trim() === ''}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50"
          >
            {adding ? t(lang, 'links.adding') : t(lang, 'links.add')}
          </button>
        </div>
        {formError && (
          <p role="alert" className="text-xs text-destructive">
            {formError}
          </p>
        )}
      </form>

      {loadError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {loadError}
        </p>
      )}

      {links.length === 0 ? (
        <div className="text-sm text-ink-muted">
          <p>{t(lang, 'links.empty')}</p>
          <p className="mt-1">{t(lang, 'links.emptyNote')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {links.map((link) => {
            const display = link.label ?? link.url
            const statusLabel =
              link.lastStatus === 'ok' && link.lastCheckedAt
                ? t(lang, 'links.statusOk', { when: formatCheckTime(link.lastCheckedAt, lang) })
                : t(lang, STATUS_KEY[link.lastStatus])
            return (
              <li
                key={link.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block truncate text-sm font-medium text-foreground hover:underline"
                  >
                    {display}
                  </a>
                  <p className="truncate text-xs text-ink-muted">{link.url}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {statusLabel}
                    {link.lastStatus !== 'ok' && link.lastError
                      ? ` · ${t(lang, 'links.lastError', { msg: link.lastError })}`
                      : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(link.id)}
                  disabled={deletingId === link.id}
                  className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-ink-muted hover:border-destructive hover:text-destructive disabled:opacity-50"
                >
                  {deletingId === link.id ? t(lang, 'links.deleting') : t(lang, 'links.delete')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
