"use client"

/**
 * 语言切换按钮（P0-5-1）。右上角挂载：topbar（dashboard / courses / 课程详情）
 * 与 login / signup 页各自右上角。
 *
 * 切换语义（与卡面一致）：
 * 1. 写 `tempo-lang` cookie —— 服务端渲染的唯一真相（layout / 页面按它出文案）；
 * 2. 写 localStorage —— 同域偏好备份（card 明确「偏好存 localStorage」，cookie 被清时可恢复）；
 * 3. `setLang` —— Provider 状态更新，客户端组件立即重渲；
 * 4. `router.refresh()` —— 服务端组件按新 cookie 重算文案。
 *
 * 服务端真相在 cookie、客户端状态由 Provider 持有，二者总是同写同值，不会分叉。
 */

import { useRouter } from "next/navigation"

import { COOKIE_NAME, type Lang } from "@/lib/i18n/types"
import { useI18n } from "@/lib/i18n/use-i18n"
import { cn } from "@/lib/utils"

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang } = useI18n()
  const router = useRouter()

  function toggle() {
    const next: Lang = lang === "zh" ? "en" : "zh"
    document.cookie = `${COOKIE_NAME}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
    try {
      localStorage.setItem(COOKIE_NAME, next)
    } catch {
      /* ignore：隐私模式等场景下 localStorage 不可写，cookie 仍生效 */
    }
    setLang(next)
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="切换语言 / Switch language"
      title="中文 / English"
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-button border border-line bg-background text-xs font-semibold text-ink-muted transition-colors hover:bg-surface2 hover:text-ink",
        className
      )}
    >
      {/* 展示「可切换到的目标语言」：中文界面显示 EN，英文界面显示 中 */}
      {lang === "zh" ? "EN" : "中"}
    </button>
  )
}
