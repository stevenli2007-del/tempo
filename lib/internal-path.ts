/**
 * **站内路径**的守卫与拼装（P0-3-30 抽出，原实现在 `lib/messages/view.ts`）。
 *
 * ### 为什么要单独一个文件
 * 站内路径会被**写进 jsonb**（`messages.payload.paperPath`、`syllabi.file_url`）。
 * jsonb 是用户可控形状的数据，一个"路径"字段就能塞进 `//evil.com/x`：
 * 浏览器会把它当 `https://evil.com/x` 处理，而它与 `/courses/…` **只差一个字符**，
 * 评审时几乎看不出来。所以读出来渲染之前必须过一次守卫 —— 而且守卫只能有一份，
 * 两处各写一遍就会有其中一处忘了 `//` 这一种形态。
 *
 * ### 判据
 * 允许：**以单个 `/` 开头**、且不含协议相对前缀（`//`）、不含反斜杠转义（`/\`）。
 * 其余（`http(s)://`、`//host`、`javascript:`、裸域名、空串）一律判 `null`。
 */

/**
 * 读出一条站内路径；不是合法站内路径返回 `null`（调用方据此不渲染链接）。
 *
 * ⚠️ **判 null 的语义是"这条路径不可信"**，不是"这条路径为空"。
 * 空路径与危险路径在调用方的处理是一样的（不画链接），所以合并成一个返回值。
 */
export function readInternalPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // 必须以单个 `/` 开头：`//host` 是协议相对 URL（外链），`/\host` 在部分浏览器里同样被当斜杠。
  if (!trimmed.startsWith('/')) return null
  if (trimmed.startsWith('//')) return null
  if (trimmed.startsWith('/\\')) return null
  if (/^\/[^/]*\/\//.test(trimmed)) return null
  // 控制字符（含换行）：`/a\nb` 进 href 会被浏览器做各种归一化，不如直接拒。
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/** 一段路径是否"干净"（不含分隔符与空白，也不是 `.` / `..`）。 */
function isSafeSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false
  if (/[\s/\\?#]/.test(segment)) return false
  return true
}

/**
 * 拼一条站内路径；任一段不干净就返回 `null`（**绝不返回一个可能有害的字符串**）。
 *
 * 调用方拿它写库 / 写 payload 之前应当判 null —— `null` 表示"这条路径我不敢用"，
 * 而不是"没有路径"。
 */
export function buildInternalPath(segments: string[]): string | null {
  if (segments.length === 0) return null
  if (!segments.every(isSafeSegment)) return null
  return `/${segments.join('/')}`
}
