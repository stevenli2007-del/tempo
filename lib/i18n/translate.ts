/**
 * 纯函数翻译层（P0-5-1）。
 *
 * 🔴 **只动文案，绝不碰判定 / 状态模型**。`t()` 是纯函数：给定语言 + key + 变量，
 * 返回对应字符串。它不知道 `isEffectivelyDone` / `CANVAS_DONE_STATES` / `exam_key`
 * 归一这一套东西，也不会改它们。
 *
 * 服务端组件与客户端组件都用这一个 `t()`：服务端传 `getLang()` 算出的 lang，
 * 客户端用 `<I18nProvider>` 注入的 `useT()`（最终也调这里）。
 */

import { messages } from './messages'
import { DEFAULT_LANG, type Lang } from './types'

/** 字典 key = `messages.zh` 的所有键（en 被 `Record<MessageKey,string>` 强制对齐）。 */
export type MessageKey = keyof (typeof messages)['zh']

/** 把任意原始串解析成合法 Lang（非法 → 默认）。 */
export function resolveLang(raw: string | null | undefined): Lang {
  return raw === 'en' ? 'en' : DEFAULT_LANG
}

/**
 * 翻译一个 key。
 *
 * - `vars` 里的 `{name}` 占位符会被替换；缺省保留 `{name}` 不报错（不会把模板漏给用户）。
 * - en 缺某 key 时回退 zh（防御性，正常 en 必全）；都缺则回退 key 本身（绝不抛）。
 */
export function t(
  lang: Lang,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const dict = messages[lang] ?? messages.zh
  const template = dict[key] ?? messages.zh[key] ?? (key as string)
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  )
}
