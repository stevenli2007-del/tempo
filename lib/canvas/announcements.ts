import { addDays, schoolDayKey } from '@/lib/time'
import type { CanvasAnnouncement } from '@/types/canvas'

/**
 * Canvas 公告的端点与映射（P0-3-25，Sync-Strategy.md 第 14 节）。
 *
 * ### 与 `lib/canvas/assignments.ts` 同一分工
 * 这里只知道"公告端点长什么样"和"原始对象怎么映射"；
 * 发请求归 `lib/canvas/client.ts`，翻页 / 预算 / 去重落库归 `lib/sync/announcements.ts`。
 *
 * ### 1) 为什么走**批量**端点而不是逐课
 * `GET /api/v1/announcements?context_codes[]=…` 一次能拿多门课的公告，
 * 而逐课端点要 N 个请求。Sync-Strategy §5 的单次同步预算只有 20 个请求，
 * 公告作为**附加**能力不该挤掉作业同步的额度。
 *
 * ### 2) 🔴 必须两端日期都显式传（实测踩坑，`end_date` 陷阱）
 * Canvas 这个端点的默认值非常反直觉：
 * - `start_date` 默认 = 14 天前；
 * - **`end_date` 默认 = `start_date + 28 天`** —— 注意它跟着 `start_date` 走。
 *
 * 于是"我想拿 7/20 之后的所有公告"写成 `?start_date=2026-07-20`，
 * 实际窗口是 `[7/20, 8/17]`：**最近一个月的公告全部落空**，而且响应是 200、
 * 结构完全合法 —— 静默漏数据。2026-09-17 实测：同一个人同一时间，
 * 只传 start_date 拿到 2 条，逐课端点拿到 71 条。
 *
 * 所以 `announcementsPath()` **强制**两个日期都进查询串（函数签名就不给你只传一个的机会）。
 *
 * ### 3) 🔴 HTML 清洗（stored XSS）
 * Canvas 的 `message` 是**富文本 HTML**，老师可以贴任意内容。本模块只产出**纯文本**
 * （`bodyText`），数据库里不落 HTML；渲染层另有一道「禁 `dangerouslySetInnerHTML`」。
 * **两道一起**才有意义：只做一道，另一道迟早被"顺手优化"掉。
 */

/** 一个公告页面的条数上限（Canvas 默认 10，对 14 天窗口偏小）。 */
export const ANNOUNCEMENTS_PER_PAGE = 50

/** 单次同步最多翻几页公告（与作业的 `MAX_PAGES_PER_COURSE` 同一纪律：宁可少拿，不硬撑）。 */
export const MAX_ANNOUNCEMENT_PAGES = 3

/**
 * 滚动窗口长度（天）。
 *
 * 为什么是"滚动窗口"而不是"上次同步到现在"：
 * - **幂等**：窗口必然反复覆盖同一批公告，重复靠 `course_announcements` 的唯一键挡；
 * - **漏跑自愈**：连续十几天没同步（用户没打开、cron 挂了），窗口仍能补回来，
 *   而"从上次同步到现在"一旦有一轮记错了时间戳，那段区间就**永久丢失**。
 */
export const ANNOUNCEMENT_WINDOW_DAYS = 14

export type AnnouncementWindow = {
  /** `YYYY-MM-DD`（Canvas 接受的日期格式，同时给日志用）。 */
  startDate: string
  endDate: string
}

/**
 * 计算查询窗口。
 *
 * ⚠️ 两端**各往外让一天**（起点再早一天、终点到明天）：
 * `start_date` / `end_date` 的边界是包含还是排除，Canvas 没有明确文档，
 * 而多让一天的成本是**零**（重复会被唯一键挡掉），漏掉一条却是真的丢公告。
 */
export function announcementWindow(now: Date, days: number = ANNOUNCEMENT_WINDOW_DAYS): AnnouncementWindow {
  const today = schoolDayKey(now)
  return {
    startDate: addDays(today, -days),
    endDate: addDays(today, 1),
  }
}

/**
 * 公告列表的第一页路径。翻页由 `canvasGet` 返回的 `nextPath`（Link 头）驱动，
 * 不在客户端手工拼 `page=2` —— 与作业端点同一条纪律。
 *
 * @param externalCourseIds Canvas 课程 id（**不是**本地 uuid）
 */
export function announcementsPath(
  externalCourseIds: string[],
  window: AnnouncementWindow,
): string {
  const params = new URLSearchParams()
  for (const id of externalCourseIds) {
    params.append('context_codes[]', `course_${id}`)
  }
  // 🔴 两个日期都必须显式传 —— 见文件头第 2 段。
  params.set('start_date', window.startDate)
  params.set('end_date', window.endDate)
  params.set('per_page', String(ANNOUNCEMENTS_PER_PAGE))
  params.set('latest_only', 'false')
  return `/api/v1/announcements?${params.toString()}`
}

/** Canvas `/announcements` 返回对象里我们用到的字段，其余一律忽略。 */
type CanvasApiAnnouncement = {
  id?: number | string
  title?: string | null
  /** 富文本 HTML。**只读不存**：映射成 `bodyText` 纯文本后才离开本模块。 */
  message?: string | null
  html_url?: string | null
  posted_at?: string | null
  /** 形如 `course_1234`。批量端点靠它把公告归回某门课。 */
  context_code?: string | null
  published?: boolean
  workflow_state?: string | null
}

/** `course_1234` → `1234`；不是课程上下文（如 `group_5`）返回 null。 */
export function announcementCourseExternalId(contextCode: string | null | undefined): string | null {
  if (typeof contextCode !== 'string') return null
  const match = /^course_(.+)$/.exec(contextCode.trim())
  return match ? match[1] : null
}

/**
 * 原始响应 → `CanvasAnnouncement[]`。
 *
 * 跳过三类：学生端看不见的（unpublished / deleted）、没有 id 的（去重的唯一依据）、
 * **无法归属到课程的**（没有 `context_code` 就不知道算谁的课 —— 硬写只能随便挑一门）。
 * 第三类是异常而非常态，所以它**留日志**：静默丢弃会让"公告少了几条"永远查不出来。
 */
export function toCanvasAnnouncements(raw: unknown): CanvasAnnouncement[] {
  if (!Array.isArray(raw)) return []

  const result: CanvasAnnouncement[] = []
  const seen = new Set<string>()

  for (const item of raw as CanvasApiAnnouncement[]) {
    if (!item || typeof item !== 'object') continue
    if (item.published === false) continue
    if (item.workflow_state === 'unpublished' || item.workflow_state === 'deleted') continue

    if (item.id === undefined || item.id === null) continue
    const externalId = String(item.id)
    if (externalId === '' || seen.has(externalId)) continue

    const courseExternalId = announcementCourseExternalId(item.context_code)
    if (courseExternalId === null) {
      console.warn('[canvas] 公告缺少 context_code，无法归属课程，已跳过:', externalId)
      continue
    }

    seen.add(externalId)

    const message = typeof item.message === 'string' ? item.message : ''
    result.push({
      externalId,
      courseExternalId,
      title:
        typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : '（无标题公告）',
      // 🔴 落库的永远是这一份：**剥完标签、解完实体**的纯文本。
      bodyText: stripHtml(message),
      htmlUrl:
        typeof item.html_url === 'string' && item.html_url.trim() !== '' ? item.html_url : null,
      postedAt: typeof item.posted_at === 'string' ? item.posted_at : null,
    })
  }

  return result
}

/** 具名实体表。只收 HTML 里常见的那些 —— 认不出的原样保留（宁可显示 `&foo;` 也不猜）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  laquo: '«',
  raquo: '»',
}

/** 码点 → 字符；越界等异常时原样返回 `&…;`，绝不抛。 */
function fromCodePointOrFallback(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** 解码 HTML 实体（含 `&#39;` / `&#x27;` 这类数字实体）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10)
      return fromCodePointOrFallback(code, match)
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/**
 * HTML → 纯文本。
 *
 * ### 四步，顺序不能换
 * 1. **`<script>` / `<style>` 连内容一起丢** —— 只剥标签会把脚本源码当正文留在公告里；
 * 2. 块级标签换成换行（`<br>`、`</p>`、`</li>`…）—— 否则 `<p>a</p><p>b</p>` 会粘成 `ab`；
 * 3. 其余标签一律剥掉；
 * 4. 🔴 **最后才解码实体**。反过来的话，`&lt;img src=x onerror=alert(1)&gt;`
 *    会先变成真标签再被当成"已是纯文本、安全"放过 —— 等于先开门再上锁。
 *    先剥再解，`<` 永远只是个字符。
 *
 * 输出被压缩过空白（HTML 里的缩进换行不是内容），但**保留段落换行**。
 */
export function stripHtml(html: string): string {
  let text = html

  // 1) 连内容一起丢。
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')

  // 2) 块级边界 → 换行（先于第 3 步，否则边界信息已经没了）。
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|ul|ol|tr|td|th|h[1-6]|blockquote|section|article|pre)\s*>/gi, '\n')

  // 3) 其余标签剥掉。
  text = text.replace(/<[^>]*>/g, '')

  // 4) 解码实体（必须在 3 之后）。
  text = decodeHtmlEntities(text)

  // 5) 压缩空白：制表符→空格、连续空行→一个空行、行首尾去空白。
  return text
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
