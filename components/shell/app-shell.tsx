import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { CONTENT_ML } from "./shell-widths"
import { Sidebar } from "./sidebar"
import { Topbar } from "./topbar"
import { CourseUpdateFab } from "@/components/course-update-fab"
import { ConfettiLayer } from "@/components/notes/confetti"
import { NoteFlyLayer } from "@/components/notes/note-fly"

export function AppShell({
  children,
  title,
  className,
}: {
  children: ReactNode
  title?: string
  className?: string
}) {
  return (
    <div className="min-h-screen bg-background text-ink">
      <Sidebar />
      <div className={cn(CONTENT_ML)}>
        <Topbar title={title} />
        <main
          className={cn(
            "mx-auto max-w-[1500px] px-9 pb-[70px] pt-10",
            className
          )}
        >
          {children}
        </main>
        <CourseUpdateFab />
        {/* 彩带层 + 飘行层（P0-5-4）：挂在壳上而不是挂在待办清单里 ——
            任何一处"标记完成"都能 dispatch 同一个事件触发它，
            不需要每个列表各挂一份（与 FAB 同一层，整层不拦点击）。
            飘行层 2026-09-24 加：音符从完成那一行飞向顶栏计数。 */}
        <ConfettiLayer />
        <NoteFlyLayer />
      </div>
    </div>
  )
}
