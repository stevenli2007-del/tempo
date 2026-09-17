"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

import { cn } from "@/lib/utils"

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // 首屏后从 DOM 读真实主题：dark 初值固定 false 保证 SSR/CSR 首帧一致，mounted 避免图标 hydration 不一致。
    // 规则只报 effect 内「首个同步 setState」，故 disable 放在 setDark 前即可覆盖；setMounted 是第二个不被报。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains("dark"))
    setMounted(true)
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle("dark", next)
    try {
      localStorage.setItem("tempo-theme", next ? "dark" : "light")
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="切换深色 / 浅色主题"
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-button border border-line bg-background text-ink-muted transition-colors hover:bg-surface2 hover:text-ink",
        className
      )}
    >
      {/* mounted 前不渲染图标，避免 SSR/CSR 不一致 */}
      {mounted ? (
        dark ? <Sun className="size-4" /> : <Moon className="size-4" />
      ) : (
        <span className="size-4" />
      )}
    </button>
  )
}
