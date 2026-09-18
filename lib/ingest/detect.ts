/**
 * 「粘贴的内容是不是一个可抓取的链接」——**纯判定，零依赖**（P0-3-27）。
 *
 * ### 为什么单独成模块（不塞进 url-fetch.ts）
 * 判定要跑在**客户端**（输入框里判断"这次是链接还是文本"），而抓取只能跑在**服务端**
 * （`node:dns` + SSRF 护栏）。同文件会让客户端 bundle 拖进服务端依赖 ——
 * Turbopack 的模块图分析**不看动态 `import()`**（见 CodingRules §10 / MEMORY），
 * 这正是 `lib/messages/registry.ts` 与 `apply.ts` 分离的同一条教训：
 * **客户端要读的"纯判定"必须住在零依赖模块里。**
 *
 * ### 判定口径（宁窄勿宽）
 * - **含空白字符 → 不是链接**：一句话里夹个域名不该触发抓取；
 * - `http(s)://…` → 是；
 * - 裸域名（`math.berkeley.edu/…`）→ 是（会自动补 `https://`），
 *   但**末段必须是字母 TLD**，否则 `3.14` / `9.20` 这类小数会被误判成域名。
 */

/** 带 scheme 的链接：非空白即可（具体合法性交给服务端把关）。 */
const SCHEMED_URL = /^https?:\/\/\S+$/i

/**
 * 裸域名：至少两段、末段是 ≥2 位纯字母的 TLD，可选端口 / 路径 / 查询 / 片段。
 * 刻意不接受 IP 字面量（`127.0.0.1`）—— 那种输入要么是内网地址（服务端会拒），
 * 要么是用户手滑，不该在客户端就当成"普通课程网页链接"。
 */
const BARE_DOMAIN =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?(\/[^\s]*)?(\?[^\s]*)?(#[^\s]*)?$/i

/** 这段粘贴内容看起来是不是一个链接？ */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return false
  if (SCHEMED_URL.test(trimmed)) return true
  return BARE_DOMAIN.test(trimmed)
}

/**
 * 规整成带 scheme 的绝对链接。
 *
 * 只补 `https://`（不试 `http://`）—— 现代站点几乎都是 https，先试 http 会多一跳
 * 明文请求，得不偿失。服务端会跟 3xx 跳转，http-only 的站点靠跳转照样能到。
 */
export function normalizeUrlInput(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
