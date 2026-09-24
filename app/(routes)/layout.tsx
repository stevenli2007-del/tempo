import type { ReactNode } from "react"

import { I18nProvider } from "@/lib/i18n/provider"
import { getLang } from "@/lib/i18n/server"

/**
 * i18n 挂载层（P0-5-1）。
 *
 * 服务端读 `tempo-lang` cookie → 把 `lang` 注入 I18nProvider。login / signup /
 * dashboard / courses / 课程详情全部在这个 route group 下，共享同一份语言状态。
 * 只包状态、不包视觉；切换由 LanguageToggle 完成（写 cookie + router.refresh()），
 * 服务端在这里重读 cookie，注入值随之更新。
 */
export default async function RoutesLayout({ children }: { children: ReactNode }) {
  const lang = await getLang()

  return <I18nProvider lang={lang}>{children}</I18nProvider>
}
