import { randomBytes } from 'node:crypto'

/**
 * 邮件入站密址 token（P0-3-11，ADR-019）。
 *
 * 每个用户一个专属入站地址 `inbound+<token>@<域>`：
 * - token 即身份，构造上不可伪造（行业标配），比"用注册邮箱 From 绑定"安全得多
 *   （From 头可伪造，需额外 SPF/DKIM/DMARC 校验才能勉强用）。
 * - 因此**只**依赖 token 绑定用户，不依赖发件人地址。
 *
 * 本文件只放纯函数（生成 + 从收件地址反解），可被回归脚本直接 import、零 IO。
 */

/** token 最小长度：短于它的 local part 视为不是合法入站地址，避免误命中。 */
export const MIN_TOKEN_LENGTH = 12

/**
 * 生成一个不可预测的入站 token。
 *
 * 18 字节随机 → hex（36 字符，**全小写**，字符集 `[0-9a-f]`）。
 *
 * 🔴 必须全小写：邮件地址经过若干跳转发后常被整体小写的，若 token 含大写，
 * 则 DB 存的混合大小写 token 与入站解析出的小写 token 永远对不上 → 密址绑定静默失败。
 * 用全小写字符集，toLowerCase() 即 no-op，入库与解析始终一致。
 */
export function generateInboundToken(): string {
  return randomBytes(18).toString('hex')
}

/**
 * 从收件地址里解出 token。
 *
 * 仅接受 `local+token@domain` 形态，且 token 长度达标。其余一律返回 null
 * （未知地址 / 普通收件人 → 不归属任何用户）。
 *
 * 纯函数、零副作用，喂给回归脚本断言。
 */
export function extractTokenFromAddress(address: string): string | null {
  if (typeof address !== 'string') return null
  const trimmed = address.trim().toLowerCase()
  const at = trimmed.indexOf('@')
  if (at < 0) return null
  const local = trimmed.slice(0, at)
  const plus = local.indexOf('+')
  if (plus < 0) return null
  const token = local.slice(plus + 1)
  return token.length >= MIN_TOKEN_LENGTH ? token : null
}
