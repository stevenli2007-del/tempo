"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, ExternalLink, GraduationCap, LayoutDashboard, MessageSquare, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import { FEEDBACK_URL } from "@/lib/constants"
import type { MessageKey } from "@/lib/i18n/translate"
import { useT } from "@/lib/i18n/use-i18n"
import { readSafeUrl } from "@/lib/safe-url"
import { MESSAGES_UPDATED_EVENT } from "@/lib/messages/event"
import { SIDEBAR_W } from "./shell-widths"

/**
 * 导航项。`match` 决定高亮范围 —— **必须覆盖该栏目的全部子路由**，
 * 否则用户点进详情页时侧栏一片灰，看起来像"迷路了"。
 *
 * P0-3-7b 拆出「我的课程」：`/courses` 与 `/courses/[id]` 是两个层级，
 * 但都属于同一个栏目，所以用前缀匹配而不是等值匹配。
 *
 * P0-5-1：`label` 改存文案 key，渲染时经 `t()` 出字 —— NAV 本身仍是常量。
 */
const NAV = [
  { href: "/dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard, match: (p: string) => p === "/dashboard" || p.startsWith("/dashboard") },
  { href: "/courses", labelKey: "nav.courses", icon: BookOpen, match: (p: string) => p.startsWith("/courses") },
  { href: "/messages", labelKey: "nav.messages", icon: MessageSquare, match: (p: string) => p.startsWith("/messages") },
  { href: "/settings", labelKey: "nav.settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
] as const satisfies readonly { href: string; labelKey: MessageKey; icon: typeof LayoutDashboard; match: (p: string) => boolean }[]

/**
 * 侧栏「消息栏」项的待处理徽标。
 *
 * ### 为什么在侧栏里自己 fetch，而不是从页面把 count 传下来
 * `Sidebar` 在 `AppShell` 里全局渲染，页面（含 `/messages`）并不 owning 它，
 * 没法通过 props 把"处理完一条"后的新 count 推回来。这里用最轻的耦合：
 * 挂载 / 路由切换时拉一次 `GET /api/v1/messages?status=pending` 取 `meta.pending`，
 * 并监听 `tempo-messages-updated` 事件（消息页处理提案后 dispatch）即时刷新。
 *
 * ### 纪律
 * - 只在 `pending > 0` 时显示，处理完即消失（非常驻计数）—— 与 ADR-016「催你来点」
 *   的张力里取「可见但不常驻」的中间态。
 * - 查不动不报错、不显示（徽标是"有更好没有也不坏"的信息，见 `lib/messages.ts`）。
 * - 只发 `status=pending` 的查询，DB 用 `head:true,count` 只回计数不拉行。
 */

export function Sidebar() {
  const pathname = usePathname()
  const t = useT()
  const [pending, setPending] = useState(0)
  /** 反馈链接（P0-3-32）：常量 → 守卫 → 渲染，判定只在这里做一次。 */
  const feedbackHref = readSafeUrl(FEEDBACK_URL)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const res = await fetch("/api/v1/messages?status=pending")
        const data = await res.json()
        if (cancelled || !res.ok) return
        const next = data?.meta?.pending
        if (typeof next === "number") setPending(next)
      } catch {
        // 网络抖动不影响导航，徽标只是辅助信息。
      }
    }
    void refresh()
    const onUpdated = () => void refresh()
    window.addEventListener(MESSAGES_UPDATED_EVENT, onUpdated)
    return () => {
      cancelled = true
      window.removeEventListener(MESSAGES_UPDATED_EVENT, onUpdated)
    }
  }, [pathname])

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-20 flex h-screen flex-col border-r border-line bg-nav",
        SIDEBAR_W
      )}
    >
      <div className="flex items-center gap-2.5 px-5 py-5">
        {/* lime 底上必须用恒定的深字 --on-lime：暗色下 lime 仍是亮色，
            若配 --lime-dark（暗色下会被调亮）就成了浅绿压浅绿，看不见。 */}
        <span className="flex size-9 items-center justify-center rounded-button bg-lime text-on-lime">
          <GraduationCap className="size-5" />
        </span>
        <span className="text-[17px] font-semibold tracking-tight text-ink">
          Tempo
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV.map(({ href, labelKey, icon: Icon, match }) => {
          const active = match(pathname)
          const showBadge = href === "/messages" && pending > 0
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-button px-3 py-2.5 text-[15px] font-medium transition-colors",
                active
                  ? "bg-nav-active text-ink"
                  : "text-ink-muted hover:bg-nav-active/60 hover:text-ink"
              )}
            >
              <Icon className="size-[18px]" />
              {t(labelKey)}
              {showBadge && (
                <span className="ml-auto rounded-full bg-lime px-1.5 py-0.5 text-xs font-semibold leading-none text-on-lime">
                  {pending > 99 ? "99+" : pending}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="space-y-1.5 px-5 py-4 text-xs text-ink-muted">
        {/* 音符计数 2026-09-24 起搬到顶栏（`components/shell/topbar.tsx`）——
            Steven 验收反馈：侧栏底部看不见，且飘行动画需要一个常驻落点。 */}
        <p>Course OS · v0.1</p>
        {/* 「重看教程」放在导航之外的底部角落：它是一次性的辅助入口，
            不该占一个导航位（P0-3-32 约束 ③）。 */}
        <Link
          href="/dashboard?tutorial=1"
          className="block w-fit rounded-button transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {t("nav.rewatchTutorial")}
        </Link>
        {/* 反馈入口（P0-3-32 ②）。URL 住 `lib/constants.ts` 的 FEEDBACK_URL —— 换一个常量即全站生效。
            ⚠️ 仍然过一遍 `readSafeUrl()`：常量写坏（漏协议等）时**宁可不画**，也不画一个点不动的链接。 */}
        {feedbackHref ? (
          <a
            href={feedbackHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1 rounded-button transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {t("nav.feedback")}
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">{t("nav.feedbackSr")}</span>
          </a>
        ) : null}
      </div>
    </aside>
  )
}
