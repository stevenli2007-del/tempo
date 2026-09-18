/**
 * URL → 合并纯文本（P0-3-27）。**服务端专用**（`node:dns` / `node:net`）。
 *
 * ### 它只做一件事：把"一个课程网页链接"变成"一段可解析的文本"
 * 拿到的文本交给 **3-24 现有的解析通道**（`POST /api/v1/tasks/parse`）——
 * 本模块**不碰 LLM、不落库、不认识 exams / gradeComponents**。
 * 这样"网页文本"与"用户手打的文本"走**同一条**解析 → 预览 → 确认 → 写入的路，
 * 不产生第二条会漂移的解析路径（ADR-015 / 3-24 的边界）。
 *
 * ### 🔴 SSRF 是本卡的安全底线（这不是"最好有"，是"必须有"）
 * 用户能让服务端去请求任意 URL —— 不设防就是一个"内网端口扫描器 / 云元数据读取器"。
 * 四道一起才成立：
 * 1. **只许 http(s)**（挡 `file:` / `gopher:` / `data:` 等）；
 * 2. **挡本机 / 内网 / 链路本地**（`127/10/172.16-31/192.168/169.254` + IPv6 的
 *    `::1 / fc00::/7 / fe80::/10`）——含 IPv4-mapped IPv6（`::ffff:127.0.0.1`）；
 * 3. **DNS 解析后再查一次**：`http://2130706433/`（十进制 IP）这类花招绕过字面量检查，
 *    只有查完 DNS 拿到的真实 IP 才拦得住；
 * 4. **手动跟 3xx，每一跳都重跑 1–3**：只在入口查一次的话，
 *    `https://public.example/ → 302 http://169.254.169.254/` 就绕过了。
 *
 * ### 其余护栏（卡面写死）
 * 只跟**同源**子页、≤5 个子页、超时 5s、单页 ≤1MB、最多跳转 3 次。
 * 抽出来的纯函数（`isPrivateIp` / `isBlockedHostname` / `extractLinks` / `pickSubpages` /
 * `mergeTexts`）有**离线回归** `npm run regress:url-ingest`，不依赖网络。
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { stripHtml } from '@/lib/canvas/announcements'

import { normalizeUrlInput } from './detect'

/** 抓取超时（覆盖首页 + 所有子页 + 重定向，一次总预算）。 */
export const URL_FETCH_TIMEOUT_MS = 5_000
/** 单页最大字节数（>1MB 只读前 1MB 并标记截断）。 */
export const URL_FETCH_MAX_BYTES = 1_000_000
/** 最多跟几个子页（不含首页）。 */
export const URL_FETCH_MAX_SUBPAGES = 5
/** 最多跟几次 3xx 跳转。 */
export const URL_FETCH_MAX_REDIRECTS = 3
/** 合并后文本的总长度上限（对齐 `lib/parse` 的 30k 量级，给多页留点余量）。 */
export const URL_FETCH_MAX_TOTAL_CHARS = 40_000
/** 合并后少于这么多字符就判"没抓到内容"（宁明确失败，不喂垃圾给模型）。 */
export const URL_FETCH_MIN_CHARS = 50

/** 只跟这些 content-type（缺 header 时按 HTML 放行，兼容个别不规范的站点）。 */
const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml|text\/plain/i

/** 子页选取关键词：命中路径 / 锚文本里任意一个才跟（本地确定性匹配，不用 LLM）。 */
const SUBPAGE_KEYWORDS = [
  'syllabus',
  'schedule',
  'calendar',
  'grading',
  'grade',
  'grades',
  'exam',
  'exams',
  'midterm',
  'final',
  'homework',
  'assignment',
  'assignments',
  'lecture',
  'outline',
  'policy',
  'policies',
  'reading',
  'readings',
]

const BROWSER_UA =
  'Mozilla/5.0 (compatible; TempoBot/0.1; +https://tempo-six-neon.vercel.app) AppleWebKit/537.36'

export type UrlIngestMeta = {
  /** 成功合并的页面数（含首页）。 */
  pages: number
  /** 实际抓到的页面 URL（按抓取顺序）。 */
  urls: string[]
  /** 跟子页时失败的个数（如实记录，不假装全成功）。 */
  skipped: number
  /** 是否因总量超限而截断。 */
  truncated: boolean
}

export type UrlIngestResult =
  | { ok: true; text: string; meta: UrlIngestMeta }
  | { ok: false; status: number; code: string; message: string }

function fail(status: number, code: string, message: string): UrlIngestResult {
  return { ok: false, status, code, message }
}

// ---------------------------------------------------------------
// 纯判定层（离线回归覆盖）
// ---------------------------------------------------------------

/** IP 是不是本机 / 内网 / 链路本地 / 保留段。字面量与 DNS 解析结果都要过这一关。 */
export function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const version = isIP(value)

  if (version === 4) {
    const parts = value.split('.').map(Number)
    const [a, b] = parts
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true // 解析不出就当不安全
    }
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // 10/8
    if (a === 127) return true // 回环
    if (a === 169 && b === 254) return true // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true // 运营商级 NAT 100.64/10
    if (a >= 224) return true // 组播 / 保留
    return false
  }

  if (version === 6) {
    if (value === '::' || value === '::1') return true
    if (value.startsWith('fe80')) return true // 链路本地 fe80::/10
    if (value.startsWith('fc') || value.startsWith('fd')) return true // 唯一本地 fc00::/7
    if (value.startsWith('::ffff:')) return isPrivateIp(value.slice('::ffff:'.length)) // v4-mapped
    return false
  }

  return true // 既不是 v4 也不是 v6 → 判不安全
}

/** 主机名字面量层面的拦截（DNS 尚未参与）。 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '') return true
  if (host === 'localhost') return true
  if (host.endsWith('.localhost')) return true
  if (host.endsWith('.local')) return true
  if (host.endsWith('.internal')) return true
  if (host.endsWith('.home.arpa')) return true
  if (isIP(host)) return isPrivateIp(host)
  return false
}

/** 从 HTML 里抽出链接：绝对化 + 剥掉锚文本标签。首层解析，不判同源（交给 `pickSubpages`）。 */
export function extractLinks(html: string, baseUrl: string): { href: string; text: string }[] {
  const links: { href: string; text: string }[] = []
  const anchor = /<a\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchor.exec(html)) !== null) {
    const rawHref = match[1] ?? match[2] ?? match[3] ?? ''
    if (rawHref === '') continue
    let absolute: string
    try {
      absolute = new URL(rawHref, baseUrl).toString()
    } catch {
      continue
    }
    const text = stripTags(match[4] ?? '')
    links.push({ href: absolute, text })
  }
  return links
}

/** 剥掉一小段 HTML 里的标签（锚文本用；不做实体解码——关键词匹配不需要）。 */
function stripTags(snippet: string): string {
  return snippet.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 从首页的链接里挑要跟的同源子页（≤`max`）。
 *
 * 判定顺序（全部本地、确定性）：
 * 1. 只留与 `baseUrl` **同源**（协议 + 主机 + 端口都一致）的链接 —— 跟出去就跨站了；
 * 2. 去掉自身、纯片段（`#…`）、非 http(s)（`mailto:` / `javascript:` / `tel:`）；
 * 3. 按 `SUBPAGE_KEYWORDS` 命中数打分，**命中 0 个的不要** ——
 *    宁可不跟，也别把登录页 / 导航页拉进来污染解析（噪声会把模型带偏）；
 * 4. 去重后按分数降序、同分按原顺序，取前 `max` 个。
 */
export function pickSubpages(
  links: { href: string; text: string }[],
  baseUrl: string,
  max: number = URL_FETCH_MAX_SUBPAGES,
): string[] {
  const base = new URL(baseUrl)
  const seen = new Set<string>()
  const scored: { href: string; score: number; order: number }[] = []

  links.forEach((link, order) => {
    let url: URL
    try {
      url = new URL(link.href)
    } catch {
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (url.origin !== base.origin) return
    if (url.href.split('#')[0] === base.href.split('#')[0]) return // 自身
    const key = url.href.split('#')[0]
    if (seen.has(key)) return
    seen.add(key)

    const haystack = `${url.pathname}${url.search} ${link.text}`.toLowerCase()
    const score = SUBPAGE_KEYWORDS.reduce((n, kw) => (haystack.includes(kw) ? n + 1 : n), 0)
    if (score === 0) return
    scored.push({ href: key, score, order })
  })

  return scored
    .sort((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score))
    .slice(0, max)
    .map((item) => item.href)
}

/** 合并多页文本为一段，带来源标注；超总量则截断并如实标记。 */
export function mergeTexts(
  pages: { url: string; text: string }[],
  maxChars: number = URL_FETCH_MAX_TOTAL_CHARS,
): { text: string; truncated: boolean } {
  const blocks: string[] = []
  let total = 0
  let truncated = false

  for (const page of pages) {
    const block = `── 来源：${page.url} ──\n${page.text.trim()}`
    if (total + block.length > maxChars) {
      blocks.push(block.slice(0, Math.max(0, maxChars - total)))
      truncated = true
      break
    }
    blocks.push(block)
    total += block.length + 2
  }

  return { text: blocks.join('\n\n').trim(), truncated }
}

// ---------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------

type DestinationCheck = { ok: true } | { ok: false; status: number; code: string; message: string }

/** 四道护栏里的 1–3：协议 + 字面量主机 + DNS 解析后的真实 IP。 */
export async function checkDestination(url: URL): Promise<DestinationCheck> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, status: 400, code: 'bad_request', message: '只支持 http / https 链接' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, status: 400, code: 'bad_request', message: '链接里不能带账号密码' }
  }
  if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      status: 400,
      code: 'blocked_url',
      message: '出于安全考虑，不能抓取本机 / 内网地址',
    }
  }

  let addresses: string[]
  try {
    const resolved = await lookup(url.hostname, { all: true })
    addresses = resolved.map((entry) => entry.address)
  } catch {
    return { ok: false, status: 502, code: 'upstream_error', message: '这个域名解析不了，检查一下链接？' }
  }
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    return {
      ok: false,
      status: 400,
      code: 'blocked_url',
      message: '出于安全考虑，不能抓取本机 / 内网地址',
    }
  }
  return { ok: true }
}

type DocumentResult =
  | { ok: true; html: string; finalUrl: URL; truncated: boolean }
  | { ok: false; status: number; code: string; message: string }

/** 抓一个文档，手动跟 3xx（每一跳都重跑 `checkDestination`）。 */
async function fetchDocument(start: URL, signal: AbortSignal): Promise<DocumentResult> {
  let current = start
  for (let hop = 0; hop <= URL_FETCH_MAX_REDIRECTS; hop += 1) {
    const guard = await checkDestination(current)
    if (!guard.ok) return guard

    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      })
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        status: aborted ? 504 : 502,
        code: aborted ? 'timeout' : 'upstream_error',
        message: aborted ? '抓取超时了，这个站点可能太慢' : '打不开这个链接（网络或对方站点的问题）',
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        return { ok: false, status: 502, code: 'upstream_error', message: '对方站点返回了一个空的跳转' }
      }
      try {
        current = new URL(location, current)
      } catch {
        return { ok: false, status: 502, code: 'upstream_error', message: '对方站点的跳转地址不正常' }
      }
      continue
    }

    if (!response.ok) {
      return { ok: false, status: 502, code: 'upstream_error', message: `对方站点返回了 ${response.status}` }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType !== '' && !HTML_CONTENT_TYPE.test(contentType)) {
      return {
        ok: false,
        status: 415,
        code: 'unsupported_file_type',
        message: '这个链接不是网页（可能是 PDF / 图片），下载后上传吧',
      }
    }

    const capped = await readCapped(response, URL_FETCH_MAX_BYTES)
    if (capped === null) {
      return { ok: false, status: 502, code: 'upstream_error', message: '读取页面内容失败' }
    }
    return { ok: true, html: capped.text, finalUrl: current, truncated: capped.truncated }
  }
  return { ok: false, status: 502, code: 'upstream_error', message: '这个链接跳转太多次了' }
}

/** 流式读取响应体，超过 `max` 字节就停下并标记截断（不把整个大文件读进内存）。 */
async function readCapped(
  response: Response,
  max: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (total + value.length >= max) {
      chunks.push(value.subarray(0, max - total))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.length
  }
  const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return { text: merged.toString('utf8'), truncated }
}

/**
 * 入口：把用户粘贴的链接抓成一段合并文本。
 *
 * **不抛异常**：所有失败都收敛到 `{ ok: false, status, code, message }`，
 * 由路由翻成统一的错误响应。子页抓取失败**不拖垮本次结果**（只取到首页也照常返回），
 * 但会把失败个数记进 `meta.skipped` —— 如实记录，不假装全成功（ADR-016 R3）。
 */
export async function fetchUrlText(rawUrl: string): Promise<UrlIngestResult> {
  let start: URL
  try {
    start = new URL(normalizeUrlInput(rawUrl))
  } catch {
    return fail(400, 'bad_request', '链接格式不正确')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS)
  try {
    const home = await fetchDocument(start, controller.signal)
    if (!home.ok) return home
    const homeUrl = home.finalUrl.toString()

    const pages: { url: string; text: string }[] = [{ url: homeUrl, text: stripHtml(home.html) }]

    const candidates = pickSubpages(extractLinks(home.html, homeUrl), homeUrl, URL_FETCH_MAX_SUBPAGES)
    let skipped = 0
    for (const candidate of candidates) {
      const sub = await fetchDocument(new URL(candidate), controller.signal)
      if (sub.ok) {
        pages.push({ url: sub.finalUrl.toString(), text: stripHtml(sub.html) })
      } else {
        skipped += 1
      }
    }

    const merged = mergeTexts(pages)
    if (merged.text.length < URL_FETCH_MIN_CHARS) {
      return fail(422, 'no_content', '这个链接里没抓到可读内容，换个页面试试？')
    }

    return {
      ok: true,
      text: merged.text,
      meta: {
        pages: pages.length,
        urls: pages.map((page) => page.url),
        skipped,
        truncated: merged.truncated || home.truncated,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}
