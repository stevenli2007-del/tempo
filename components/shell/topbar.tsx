import { LanguageToggle } from "@/components/i18n/language-toggle"
import { ThemeToggle } from "./theme-toggle"

export function Topbar({ title }: { title?: string }) {
  return (
    <header className="sticky top-0 z-[15] flex h-[76px] items-center justify-between border-b border-line bg-background/85 px-9 backdrop-blur">
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">
        {title ?? "Tempo"}
      </h1>
      <div className="flex items-center gap-3">
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  )
}
