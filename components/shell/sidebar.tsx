"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, GraduationCap, LayoutDashboard, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import { SIDEBAR_W } from "./shell-widths"

/**
 * 导航项。`match` 决定高亮范围 —— **必须覆盖该栏目的全部子路由**，
 * 否则用户点进详情页时侧栏一片灰，看起来像"迷路了"。
 *
 * P0-3-7b 拆出「我的课程」：`/courses` 与 `/courses/[id]` 是两个层级，
 * 但都属于同一个栏目，所以用前缀匹配而不是等值匹配。
 */
const NAV = [
  { href: "/dashboard", label: "课程面板", icon: LayoutDashboard, match: (p: string) => p === "/dashboard" || p.startsWith("/dashboard") },
  { href: "/courses", label: "我的课程", icon: BookOpen, match: (p: string) => p.startsWith("/courses") },
  { href: "/settings", label: "设置与隐私", icon: Settings, match: (p: string) => p.startsWith("/settings") },
] as const

export function Sidebar() {
  const pathname = usePathname()

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
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname)
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
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-5 py-4 text-xs text-ink-muted">Course OS · v0.1</div>
    </aside>
  )
}
