/**
 * **外链**（`http(s)`）的守卫 —— 全仓唯一实现。
 *
 * ### 为什么单独一个零依赖文件
 * 两个消费方都要用它，而两者的**运行环境不同**：
 * - `lib/messages/view.ts`（P0-3-25 公告的「原文 ↗」）—— 会被客户端组件链带进浏览器；
 * - `components/onboarding/onboarding-cards.tsx`（P0-3-32 教程卡的跳转链接）—— 本身就是客户端组件。
 *
 * 所以本文件**不能 import 任何东西**：一旦沾上 `next/headers` / `lib/supabase/*`，
 * 这些模块就会被拖进客户端图，整个 build 直接失败（与 `lib/messages/registry.ts`、
 * `lib/internal-path.ts` 同一条纪律）。
 *
 * 抽出来的第二层理由（CodingRules §10.1 第 20 条）：白名单的收口只会被改一次。
 * 两处各写一份时，早晚有一处漏掉 `javascript:` 之外的新形态
 * （`data:` / `blob:` / `vbscript:` 在部分浏览器同样可执行）。
 *
 * ### 判据
 * 放行：**协议是 `https:` 或 `http:`** 的绝对 URL。
 * 拒绝（返回 `null`）：非字符串 / 空白串 / 解析失败 / 其他任何协议。
 *
 * ⚠️ **判 `null` 的语义是「这个链接不可信」**，不是「没有链接」——
 * 调用方两者都按"不画链接"处理，故合并成一个返回值。
 *
 * ⚠️ 站内相对路径**不要**喂给这里（`/courses/...` 会被判 null → 链接凭空消失、
 * 零报错）。站内路径走 `lib/internal-path.ts` 的 `readInternalPath()`，
 * 两个守卫刻意分开、**绝不合并**。
 */
export function readSafeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}
