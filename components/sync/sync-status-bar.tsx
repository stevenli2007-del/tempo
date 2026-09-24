import Link from 'next/link'

import { SyncRetryButton } from '@/components/sync/sync-retry-button'
import type { Lang } from '@/lib/i18n/types'
import { t } from '@/lib/i18n/translate'
import {
  formatFailedCourseNames,
  formatSyncTime,
  type SyncOverview,
} from '@/lib/sync/status'

/**
 * 总览页顶部的 Canvas 同步状态条（P0-2-7，Sync-Strategy §9「失败可见性」）。
 *
 * 服务端组件 —— 它的数据已经在 `dashboard` 里查好了，不需要客户端状态。
 * 只有「重试」按钮是客户端组件（要发请求）。
 *
 * ### 分级的意义（Steven 2026-09-05 拍板）
 * 同样是"同步失败"，用户能做的动作完全不同：
 * - **连接坏了**（token 过期 / 被撤销）→ 给「去重新连接 Canvas」，**不给重试按钮** ——
 *   对一个注定失败的 token 重试，只会让用户多点几次然后更困惑。
 * - **暂时性故障**（网络 / Canvas 5xx / 限流 / 熔断）→ 给重试按钮，并说明系统会自动重试 ——
 *   连接本身没问题，让用户去"重新连接"是误导。
 *
 * ### 与 §9 的一处偏离
 * §9 写「凭证失效 → 全局横幅 + 直达设置页」。设置页是 P0-3-2 才有，
 * 现在重新连接 Canvas 的唯一入口在**课程详情页**的「Canvas 关联」区块
 * （`canvas-link.tsx`：点「更改」→ Canvas 拒 token → 内嵌连接表单）。
 * 所以这里链到第一门失败课程的详情页，文案写明「去重新连接 Canvas」。
 */
export function SyncStatusBar({
  overview,
  now,
  lang,
}: {
  overview: SyncOverview
  now: Date
  lang: Lang
}) {
  if (overview.level === 'not_linked') {
    return null
  }

  // 全绿：一行静默的确认就够了。做成卡片会让人以为出了什么事。
  if (overview.level === 'ok') {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          lang,
          'syncStatusBar.ok',
          {
            when: overview.lastSuccessAt
              ? formatSyncTime(overview.lastSuccessAt, now, lang)
              : '—',
          },
        )}
        {overview.total > 1
          ? t(lang, 'syncStatusBar.okCourses', { n: overview.syncedCount })
          : null}
      </p>
    )
  }

  const lastSuccessLine =
    overview.lastSuccessAt === null
      ? t(lang, 'syncStatusBar.neverSyncedLine')
      : t(lang, 'syncStatusBar.staleLine', {
          when: formatSyncTime(overview.lastSuccessAt, now, lang),
        })

  // ---------- 失败 ----------
  if (overview.level === 'failed') {
    const first = overview.failedCourses[0]
    const isFixable = overview.failureKind === 'fixable'

    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-card p-4"
        data-sync-level="failed"
        data-sync-failure-kind={overview.failureKind ?? 'unknown'}
      >
        <p className="text-sm font-medium text-destructive">
          {isFixable
            ? t(lang, 'syncStatusBar.fixableTitle')
            : t(lang, 'syncStatusBar.failedTitle', {
                n: overview.failedCount,
                m: overview.total,
              })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatFailedCourseNames(overview.failedCourses, 3, lang)}
          {overview.syncedCount > 0
            ? t(lang, 'syncStatusBar.othersSynced', { n: overview.syncedCount })
            : null}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{lastSuccessLine}</p>
        {first?.errorMessage ? (
          <p className="mt-1 break-all text-xs text-muted-foreground/80">{first.errorMessage}</p>
        ) : null}

        <div className="mt-3">
          {isFixable ? (
            <Link
              href={`/courses/${first?.courseId ?? ''}`}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              {t(lang, 'syncStatusBar.goReconnect')}
            </Link>
          ) : (
            <>
              <SyncRetryButton lang={lang} />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(lang, 'syncStatusBar.retryNote')}
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  // ---------- 从未同步过 ----------
  if (overview.level === 'never') {
    return (
      <div
        className="rounded-lg border border-border bg-muted/40 p-4"
        data-sync-level="never"
      >
        <p className="text-sm font-medium text-foreground">{t(lang, 'syncStatusBar.neverTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(lang, 'syncStatusBar.neverBody', { n: overview.total })}
        </p>
        <div className="mt-3">
          <SyncRetryButton label={t(lang, 'syncStatusBar.retryNow')} lang={lang} />
        </div>
      </div>
    )
  }

  // ---------- 陈旧（>24h 或有课从未成功过） ----------
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4" data-sync-level="stale">
      <p className="text-sm font-medium text-foreground">
        {overview.staleReason === 'never_synced'
          ? t(lang, 'syncStatusBar.staleNeverTitle', { n: overview.neverCount })
          : t(lang, 'syncStatusBar.staleTitle')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {overview.staleReason === 'never_synced'
          ? t(lang, 'syncStatusBar.staleNeverBody')
          : t(lang, 'syncStatusBar.staleBody')}
        {overview.lastSuccessAt === null
          ? null
          : t(lang, 'syncStatusBar.lastSuccess', {
              when: formatSyncTime(overview.lastSuccessAt, now, lang),
            })}
      </p>
      <div className="mt-3">
        <SyncRetryButton label={t(lang, 'syncStatusBar.retryNow')} lang={lang} />
      </div>
    </div>
  )
}
