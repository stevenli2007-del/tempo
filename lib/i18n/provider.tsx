'use client'

/**
 * 客户端 i18n Provider（P0-5-1）。
 *
 * 挂在 `app/(routes)/layout.tsx`：服务端算出当前 `lang` 通过 prop 注入，初始值与
 * 服务端渲染一致，避免 hydration 错配。客户端组件用 `useT()` / `useI18n()` 拿翻译
 * 与切换能力。
 *
 * 切换语言由 `LanguageToggle` 完成：写 cookie + localStorage → `setLang`（客户端立即重渲）
 * → `router.refresh()`（服务端组件按新 cookie 重渲）。本 Provider 只持有状态，不碰路由。
 */

import { createContext, useContext, useState, type ReactNode } from 'react'
import { DEFAULT_LANG, type Lang } from './types'
import { t as translate, type MessageKey } from './translate'

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  lang: initialLang,
  children,
}: {
  lang: Lang
  children: ReactNode
}) {
  const [lang, setLangState] = useState<Lang>(initialLang ?? DEFAULT_LANG)
  const value: I18nContextValue = {
    lang,
    setLang: setLangState,
    t: (key, vars) => translate(lang, key, vars),
  }
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useI18n must be used within <I18nProvider>')
  }
  return ctx
}
