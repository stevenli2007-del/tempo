import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { CONTENT_ML } from "./shell-widths"
import { Sidebar } from "./sidebar"
import { Topbar } from "./topbar"

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
      </div>
    </div>
  )
}
