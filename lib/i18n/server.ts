/**
 * 服务端语言读取（P0-5-1）。
 *
 * 🔴 **server-only**：只在 Server Component / Route Handler 里 import，绝不进客户端包。
 * 读 `tempo-lang` cookie，解析成合法 `Lang`。读不到 / 非法 → 回退 `DEFAULT_LANG`(zh)。
 */

import 'server-only'

import { cookies } from 'next/headers'
import { COOKIE_NAME } from './types'
import { resolveLang } from './translate'
import type { Lang } from './types'

/** 服务端当前语言：从 cookie 读，失败回退 zh。 */
export async function getLang(): Promise<Lang> {
  const store = await cookies()
  const raw = store.get(COOKIE_NAME)?.value
  return resolveLang(raw)
}
