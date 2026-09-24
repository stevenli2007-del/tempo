/**
 * i18n 客户端钩子（P0-5-1）。
 *
 * 统一导出 `useI18n`（拿 lang / setLang / t）与 `useT`（只拿翻译函数，少写一层）。
 */

'use client'

export { useI18n } from './provider'

import { useI18n as useI18nInternal } from './provider'
import type { MessageKey } from './translate'

/**
 * 只取翻译函数：`const t = useT()`，然后 `t('nav.courses')`。
 * 占位符：`t('today.load', { n: 3 })`。
 */
export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  const { t } = useI18nInternal()
  return t
}
