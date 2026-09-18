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
 * 常态窗口往回看几天。
 *
 * **1 天，即"当天 + 昨天"** —— 为什么不干脆只有当天：窗口边界与客户端的
 * "今天"不是同一件事。Canvas 侧的日期过滤用的是**课程时区 / UTC**，
 * 我们的 `schoolDayKey()` 用的是学校本地时区，两者在零点前后会错开一格；
 * 再叠上 cron 恰好跑在 23:5x 的可能，"当天"会稳定漏掉跨零点那一两条。
 * 多带一天的成本是**零**（重复被唯一键挡掉），漏一条是真的丢。
 */
const WINDOW_BASE_DAYS = 1

/**
 * 窗口最多能往回看多少天（**兜底上限**，不是常态值）。
 *
 * 起点由「上次成功同步那天」决定，正常情况下就是 1 天前；只有在
 * 长时间没同步（用户没打开 + cron 也挂了）时才会一路往回长到这个上限。
 * 设上限是为了不让一个几个月没登录的账号在恢复时一次拉回上千条公告
 * （单次同步只有 3 页 / 20 请求的预算，拉爆了反而整轮失败）。
 */
export const ANNOUNCEMENT_WINDOW_MAX_DAYS = 14

export type AnnouncementWindow = {
  /** `YYYY-MM-DD`（Canvas 接受的日期格式，同时给日志用）。 */
  startDate: string
  /** 固定为"明天"，见下方注释。 */
  endDate: string
}

/**
 * 计算查询窗口。
 *
 * ### 🔴 起点 = 「上次成功同步那天」，不是固定的 14 天
 * 第一版写死往回 14 天。实测（2026-09-18）真账号一轮窗口内 **48 条公告**，
 * 用户一打开消息栏就被灌一屏历史存量 —— Steven 的原话是"抓的有点太多了"。
 *
 * 但直接改成"只抓当天"会**静默漏数据**：
 * cron 在 UTC 10:00 / 22:00（PDT 03:00 / 15:00）各跑一轮。15:00 那轮抓到的
 * 是"当天截至 15:00"；老师 17:00 又发了一条，用户不再登录 →
 * 次日 03:00 那轮的"当天"已经是次日 → **昨天 17:00 那条永久丢失**。
 *
 * 所以起点跟着**锚点**（`courses.last_synced_at` 里最早的那个，见
 * `pickWindowAnchor`）走，效果是：
 * | 情形 | 窗口 |
 * |---|---|
 * | 今天已经同步过（绝大多数轮次） | 昨天 → 明天（**2 天**） |
 * | 上次同步是 3 天前（断更） | 3 天前 → 明天，自动补回来 |
 * | 从没同步过（刚关联 Canvas） | 昨天 → 明天（**刻意不拉历史存量**） |
 * | 断更超过 14 天 | 夹到 14 天 |
 *
 * 于是：**常态只抓当天（+1 天冗余），断更自动回补，长期离线封顶，永不静默漏**。
 * 幂等性不受影响 —— 靠的始终是 `course_announcements` 的唯一键。
 *
 * ⚠️ **首次同步也走常态窗口**（不看历史）：存量导入是 Steven 明确不想要的
 * （那正是"抓太多"的来源）。历史公告要看，每条的「原文 ↗」回跳 Canvas 就是路。
 *
 * ⚠️ 终点固定到**明天**：`end_date` 的边界包含还是排除 Canvas 没有明确文档，
 * 多让一天成本为零，漏掉今天的公告却是灾难。
 *
 * @param anchorIso 上次成功同步的时间（ISO）。null / 空 / 不可解析 → 都留在常态窗口。
 */
export function announcementWindow(now: Date, anchorIso?: string | null): AnnouncementWindow {
  const today = schoolDayKey(now)

  let start = addDays(today, -WINDOW_BASE_DAYS)

  if (typeof anchorIso === 'string' && anchorIso !== '') {
    const anchorMs = Date.parse(anchorIso)
    // 锚点不可解析时**留在常态窗口**而不是退回上限：一个坏时间戳不该让下一次同步
    // 突然拉回 14 天。真断更了，下一轮锚点会是好的（last_synced_at 只在成功时写）。
    if (Number.isFinite(anchorMs)) {
      const anchorDay = schoolDayKey(new Date(anchorMs))
      // `YYYY-MM-DD` 定长，字典序即时间序。
      // 未来日期（时钟漂移）不会命中这个分支 → 窗口保持常态，不产生"起点 > 终点"。
      if (anchorDay < start) start = anchorDay
    }
  }

  const floor = addDays(today, -ANNOUNCEMENT_WINDOW_MAX_DAYS)
  if (start < floor) start = floor

  return { startDate: start, endDate: addDays(today, 1) }
}

/**
 * 从各门课的 `last_synced_at` 里挑出公告窗口的锚点 = **最早**的那个。
 *
 * 放在这里而不是 `lib/sync/canvas-sync.ts`：那是个重量级模块（拉起凭证 / LLM /
 * `next/headers` 的模块图），而本函数是**纯函数**，回归脚本要直接断言它。
 *
 * ### 为什么是 min
 * 锚点是"批量拉取的下界"。取 min 是保守方向：只要有一门课三天没同步成功，
 * 窗口就往外长三天 —— 代价只是多扫几条已被唯一键挡住的公告；
 * 取 max 会**静默漏掉**那门课的公告，那是真的丢数据。
 *
 * ### 三种输入都要有确定行为
 * - 全部为 null（从没成功同步过）→ `null`，调用方回退到上限窗口（首次安装的存量导入）；
 * - 部分为 null（有课刚关联、还没同步过）→ 忽略 null 只算非 null 的：那门新课
 *   本来就没有历史公告要补，不该让所有人的窗口都退回 14 天；
 * - 有坏值（不可解析 / 空串）→ 跳过。坏时间戳不该让窗口凭空变化。
 *
 * @param values 各门课的 `last_synced_at`（未清洗）
 */
export function pickWindowAnchor(values: (string | null)[]): string | null {
  const valid = values.filter((value): value is string => {
    if (typeof value !== 'string' || value === '') return false
    return Number.isFinite(Date.parse(value))
  })
  if (valid.length === 0) return null
  // 按 `Date.parse` 比较而不是字典序：ISO 8601 带不同时区偏移时
  // （`2026-09-16T20:00:00-07:00` vs `2026-09-17T00:00:00Z`）字典序会给出错误答案。
  return valid.reduce((earliest, current) =>
    Date.parse(current) < Date.parse(earliest) ? current : earliest,
  )
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
