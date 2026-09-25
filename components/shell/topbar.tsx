import { LanguageToggle } from "@/components/i18n/language-toggle"
import { NoteCounter } from "@/components/notes/note-counter"
import { ThemeToggle } from "./theme-toggle"

export function Topbar({ title }: { title?: string }) {
  return (
    <header className="sticky top-0 z-[15] flex h-[76px] items-center justify-between border-b border-line bg-background/85 px-9 backdrop-blur">
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">
        {title ?? "Tempo"}
      </h1>
      <div className="flex items-center gap-3">
        {/* 音符计数（P0-5-4）：放在语言 / 主题切换左边 —— 2026-09-24 Steven 验收反馈，
            从侧栏底部挪到这里：它是"页面上正在发生的完成"的落点（飘行动画飞向它），
            必须常驻视线；侧栏底部那个角落看不见。 */}
        <NoteCounter />
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  )
}
