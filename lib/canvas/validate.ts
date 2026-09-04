/**
 * Canvas 凭据保存的入参校验（P0-2-2，API-Contract.md 第 6 节）。
 *
 * 三条校验都不只是为了"格式对不对"，各自防一类真实事故：
 *
 * 1. **域名校验防 SSRF。** 服务端会拿着用户填的域名去发 HTTP 请求，
 *    如果域名不校验，用户就能让服务器去请求内网地址（169.254.169.254 元数据、
 *    10.0.0.0/8 内网服务……），这是服务端代理类接口最常见的漏洞。
 *    所以只接受形如 `bcourses.berkeley.edu` 的主机名：不要协议、路径、端口、
 *    不要 IP、不要 localhost、不要内网段。
 * 2. **过期时间必填。** 2026-09-04 P0-2-1b 实测：bCourses 的 token 过期时间是
 *    强制必填项（弹窗两个字段都带 `*`），用户手上必然有一个过期时间。
 *    契约原文"未填则存 null"是被这次实测推翻的旧描述。
 * 3. **过期时间上限 90 天。** 同上实测（弹窗原文 "Maximum expiration is 90 days."）。
 *    用户填不出超过 90 天的值 —— 真出现就是填错了，退回去重填比静默接受好。
 */

/** 单个主机名标签：字母数字与连字符，不以连字符开头或结尾。 */
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME_PATTERN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`, 'i')

/** Canvas PAT 的长度区间。bCourses 实测 70 字符左右，放宽到 20–512 防误填与超长。 */
const TOKEN_MIN_LENGTH = 20
const TOKEN_MAX_LENGTH = 512

/** 实测上限 90 天（P0-2-1b）。留 1 天余量容忍时区与填写时刻的误差。 */
const MAX_EXPIRY_DAYS = 91

const DAY_MS = 24 * 60 * 60 * 1000

/** 明确拒绝的主机名：本地回环、常见内网/云元数据地址。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
])

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * 校验 Canvas 域名。
 *
 * 只接受纯主机名（`bcourses.berkeley.edu`），不接受
 * `https://...`、`.../api`、`...:443`、IP 地址、localhost、内网地址。
 */
export function validateCanvasDomain(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'canvasDomain 必填' }
  }

  const domain = value.trim()
  const hostname = domain.toLowerCase()

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, message: `canvasDomain 不允许使用 ${domain}` }
  }
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return {
      ok: false,
      message: 'canvasDomain 必须是合法主机名（如 bcourses.berkeley.edu），不含协议、端口或路径'
    }
  }
  // 纯数字标签结尾（如 *.0.1）通常是 IP 的变体写法，一并拒绝。
  if (/(^|\.)\d+$/.test(hostname)) {
    return { ok: false, message: 'canvasDomain 不接受 IP 地址' }
  }

  return { ok: true, value: hostname }
}

/** 校验 token：必填、非空、长度在区间内。不校验字符集（各校格式不同，别自作聪明）。 */
export function validateCanvasToken(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'token 必填' }
  }

  const token = value.trim()
  if (token.length < TOKEN_MIN_LENGTH) {
    return { ok: false, message: `token 长度不足 ${TOKEN_MIN_LENGTH} 个字符，请确认完整复制` }
  }
  if (token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, message: `token 长度不能超过 ${TOKEN_MAX_LENGTH} 个字符` }
  }

  return { ok: true, value: token }
}

/**
 * 校验过期时间：必填、合法 ISO 8601、必须是未来时刻、距现在不超过 90 天。
 *
 * @param now 注入当前时间，便于测试（生产调用方不传即用 `new Date()`）。
 */
export function validateExpiresAt(value: unknown, now: Date = new Date()): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'expiresAt 必填（Canvas token 的过期时间，在生成 token 时可以看到）' }
  }

  const expiresAt = new Date(value.trim())
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, message: 'expiresAt 不是有效的日期时间（应为 ISO 8601 格式）' }
  }

  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, message: 'expiresAt 必须晚于当前时间，请确认没有填错或该 token 已过期' }
  }

  const daysAhead = (expiresAt.getTime() - now.getTime()) / DAY_MS
  if (daysAhead > MAX_EXPIRY_DAYS) {
    return {
      ok: false,
      message: `expiresAt 距今超过 ${MAX_EXPIRY_DAYS} 天。Canvas token 上限为 90 天，请确认填写的值`
    }
  }

  return { ok: true, value: expiresAt.toISOString() }
}
