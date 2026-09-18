import {
  MAX_ANNOUNCEMENT_PAGES,
  announcementWindow,
  announcementsPath,
  toCanvasAnnouncements,
} from '@/lib/canvas/announcements'
import { hasStructuredLanding } from '@/lib/course-update/landing'
import { fetchCanvasPages, type CanvasBudget } from '@/lib/sync/canvas-request'
import type { CanvasAnnouncement } from '@/types/canvas'
import type { MessagePayload } from '@/types/message'
import type { SyncAnnouncementSummary } from '@/types/sync'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * 公告同步（P0-3-25，Sync-Strategy.md 第 14 节）。
 *
 * ### 这一步在同步流水线里的位置
 * 作业循环**之后**、收尾之前。刻意不塞进 per-course 循环：
 * `GET /api/v1/announcements` 是**批量**端点，一次拿所有已关联课程的公告，
 * 逐课调它等于把 1 个请求变 N 个，还会白白吃掉 §5 的 20 请求预算。
 *
 * ### 🔴 幂等靠唯一键，不靠"记不记得"
 * 窗口是**滚动**的：每一轮都会重新读到同一批公告（这是刻意的 —— 漏跑要能自愈）。
 * 于是"不重复进消息栏"必须由数据保证：
 * `course_announcements` 的 `(course_id, canvas_announcement_id)` 唯一键。
 *
 * 为什么键是 **Canvas 公告 id** 而不是标题 / 时间：
 * 标题会被老师改（改完就成了"新公告"？），时间是 `posted_at` 带时区与精度差异，
 * 用它们去重会在某次编辑之后**重复投递**。重复进消息栏是最伤信任的一类 bug：
 * 用户看到两条一模一样的公告，就会开始怀疑所有条目。
 *
 * ### 🔴 没有落点 ≠ 不写字段就算了
 * 无落点的公告照样进消息栏（否则用户根本不知道老师发了通知），
 * 只是确认时走「知道了」回执（见 `lib/messages/apply.ts` 的 announcement applier）。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** 一门口已关联的 Canvas 课程（与 `canvas-sync.ts` 的 `CourseTarget` 同形）。 */
export type AnnouncementTarget = {
  id: string
  courseName: string
  canvasCourseId: string
}

/** 正文在消息栏里最多展示几行。全文请点「原文」回跳 Canvas。 */
const BODY_LINES_IN_MESSAGE = 3
/** 每行最多多少字符（超出截断并加省略号 —— 气泡不是阅读器）。 */
const BODY_LINE_MAX = 200

/** 数据库行的形状（snake_case 只在本文件出现）。 */
type AnnouncementRow = {
  id: string
  course_id: string
  canvas_announcement_id: string
}

/** 把纯文本正文切成消息栏能用的几行：按段落切、每行截断、最多 N 行。 */
export function bodyLines(bodyText: string): string[] {
  const paragraphs = bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (lines.length >= BODY_LINES_IN_MESSAGE) break
    lines.push(paragraph.length > BODY_LINE_MAX ? `${paragraph.slice(0, BODY_LINE_MAX)}…` : paragraph)
  }
  return lines
}

/**
 * 组装一条公告消息的载荷。
 *
 * `sourceUrl` / `announcementId` / `landing` 是 3-25 新增的三个字段：
 * - `sourceUrl`：渲染层画「原文」链接（回跳 Canvas 原页）。**必留** ——
 *   公告的正文被我们剥成了纯文本，用户要看原貌（表格、图片、附件）只有这条路；
 * - `announcementId`：指向 `course_announcements.id`，applier 靠它回查正文去做解析；
 * - `landing`：`true` = 按钮叫「确认」（applier 会尝试写字段），
 *   `false` = 按钮叫「知道了」（applier 只留回执）。判定在 `hasStructuredLanding()`。
 */
export function buildAnnouncementPayload(input: {
  announcement: CanvasAnnouncement
  courseId: string
  courseName: string
  announcementRowId: string
  postedAtLabel: string
}): MessagePayload {
  const { announcement, courseId, courseName, announcementRowId, postedAtLabel } = input
  const landing = hasStructuredLanding(announcement.bodyText)

  const details = bodyLines(announcement.bodyText)
  details.push(
    landing
      ? `${postedAtLabel} · 里面可能有可写入的考试 / 成绩构成`
      : `${postedAtLabel} · 通知类公告，确认只留回执，不改任何字段`,
  )

  return {
    title: announcement.title,
    details,
    courseId,
    courseName,
    announcementId: announcementRowId,
    sourceUrl: announcement.htmlUrl,
    landing,
    // Canvas 是权威源、正文是老师亲手写的：不标低置信度（低置信度会禁掉「确认」）。
    confidence: 'high',
  }
}

/**
 * 拉一轮公告并投进消息栏。
 *
 * **不抛异常**：任何失败都回到 `error` 字段。公告是附加能力 ——
 * 它失败不该让一次作业同步整体失败（用户会以为"任务都没同步上"，而其实同步好了）。
 * 但失败也**不被吞掉**：结果会进 `sync_runs` 与日志。
 */
export async function syncCourseAnnouncements(input: {
  supabase: SupabaseClient
  userId: string
  domain: string
  token: string
  targets: AnnouncementTarget[]
  budget: CanvasBudget
  startedAtMs: number
  /** 本轮同步的统一时间戳（ISO），与作业同步用同一个，便于对账。 */
  now: string
}): Promise<SyncAnnouncementSummary> {
  const { supabase, userId, domain, token, targets, budget, startedAtMs, now } = input

  const empty: SyncAnnouncementSummary = {
    status: 'success',
    scanned: 0,
    created: 0,
    seen: 0,
    incomplete: false,
    error: null,
  }
  if (targets.length === 0) return empty

  // ---------- 1) 拉（批量端点 + 显式两端日期，见 lib/canvas/announcements.ts 文件头） ----------
  const window = announcementWindow(new Date(now))
  const fetched = await fetchCanvasPages<CanvasAnnouncement>({
    domain,
    token,
    path: announcementsPath(
      targets.map((t) => t.canvasCourseId),
      window,
    ),
    budget,
    startedAtMs,
    maxPages: MAX_ANNOUNCEMENT_PAGES,
    map: toCanvasAnnouncements,
  })

  if (!fetched.ok) {
    return { ...empty, status: 'failed', error: fetched.message }
  }

  if (fetched.items.length === 0) {
    return { ...empty, incomplete: !fetched.complete }
  }

  // ---------- 2) 源侧课程 id → 本地课程（只认本轮同步的这几门） ----------
  const courseByExternalId = new Map(targets.map((t) => [t.canvasCourseId, t]))

  // ---------- 3) 已有公告账（一次性拉本轮的课，内存里算差集；省请求也省往返） ----------
  //
  // 🔴 `.eq('user_id', userId)` 不用写：course_announcements **没有** user_id 列，
  // 归属由 `course_id → courses.user_id` 决定，而 `targets` 本身就是按 userId 查出来的。
  // 但**必须** `.in('course_id', …)` 收口 —— 定时同步用的是 service role 客户端，
  // RLS 不生效，少了这一行会读到（并在下一步写回）别人的公告账。
  const localCourseIds = targets.map((t) => t.id)
  const { data: existingRows, error: existingError } = await supabase
    .from('course_announcements')
    .select('id, course_id, canvas_announcement_id')
    .in('course_id', localCourseIds)

  if (existingError) {
    return { ...empty, status: 'failed', error: `读取公告账失败：${existingError.message}` }
  }

  const existingByKey = new Map<string, AnnouncementRow>()
  for (const row of (existingRows ?? []) as AnnouncementRow[]) {
    existingByKey.set(`${row.course_id}|${row.canvas_announcement_id}`, row)
  }

  // ---------- 4) 分流：已在账上的只更新 last_seen_at，新的才建消息 ----------
  const fresh: Array<{ announcement: CanvasAnnouncement; courseId: string; courseName: string }> = []
  const seenRowIds: string[] = []

  for (const announcement of fetched.items) {
    const target = courseByExternalId.get(announcement.courseExternalId)
    // 归属不到的课（理论上不会 —— 我们只请求了已关联课程）：跳过并留日志。
    if (!target) {
      console.warn(
        '[sync] 公告的课程不在本轮同步范围内，已跳过:',
        announcement.externalId,
        announcement.courseExternalId,
      )
      continue
    }

    const key = `${target.id}|${announcement.externalId}`
    const existing = existingByKey.get(key)
    if (existing) {
      seenRowIds.push(existing.id)
      continue
    }
    fresh.push({ announcement, courseId: target.id, courseName: target.courseName })
  }

  if (seenRowIds.length > 0) {
    // `last_seen_at` 只更新、不新建 —— 它是"这条公告还在窗口里"的证据。
    const { error: touchError } = await supabase
      .from('course_announcements')
      .update({ last_seen_at: now })
      .in('id', seenRowIds)
    if (touchError) {
      // 记账失败不该让已经抓到的公告白跑一轮：留日志继续。
      console.error('[sync] 更新公告 last_seen_at 失败:', touchError.message)
    }
  }

  if (fresh.length === 0) {
    return {
      ...empty,
      scanned: fetched.items.length,
      seen: seenRowIds.length,
      incomplete: !fetched.complete,
    }
  }

  // ---------- 5) 落公告账（先账后消息：账是幂等的锚，消息是它的产物） ----------
  const insertRows = fresh.map((item) => ({
    course_id: item.courseId,
    canvas_announcement_id: item.announcement.externalId,
    title: item.announcement.title,
    // 🔴 只落**剥完标签**的纯文本。数据库里永远没有 HTML（见 lib/canvas/announcements.ts）。
    body_text: item.announcement.bodyText,
    html_url: item.announcement.htmlUrl,
    posted_at: item.announcement.postedAt,
    first_seen_at: now,
    last_seen_at: now,
  }))

  const { data: inserted, error: insertError } = await supabase
    .from('course_announcements')
    .insert(insertRows)
    .select('id, course_id, canvas_announcement_id')

  if (insertError) {
    return {
      ...empty,
      status: 'failed',
      scanned: fetched.items.length,
      seen: seenRowIds.length,
      error: `写入公告账失败：${insertError.message}`,
    }
  }

  const insertedRows = (inserted ?? []) as AnnouncementRow[]
  // 插入返回的行顺序不保证 —— 按唯一键回配，绝不按下标取（那是"某天开始公告串课"的经典成因）。
  const rowIdByKey = new Map(
    insertedRows.map((row) => [`${row.course_id}|${row.canvas_announcement_id}`, row.id]),
  )

  // ---------- 6) 每条新公告 → 一条消息（进消息栏，复用 3-18 的接缝） ----------
  let created = 0
  for (const item of fresh) {
    const rowId = rowIdByKey.get(`${item.courseId}|${item.announcement.externalId}`)
    if (!rowId) {
      console.warn(
        '[sync] 公告已写入但未返回 id，跳过建消息:',
        item.announcement.externalId,
      )
      continue
    }

    const payload = buildAnnouncementPayload({
      announcement: item.announcement,
      courseId: item.courseId,
      courseName: item.courseName,
      announcementRowId: rowId,
      postedAtLabel: item.announcement.postedAt
        ? `发布于 ${item.announcement.postedAt.slice(0, 10)}`
        : '发布时间未知',
    })

    const { data: messageRow, error: messageError } = await supabase
      .from('messages')
      .insert({ user_id: userId, type: 'announcement', payload, status: 'pending' })
      .select('id')
      .single()

    if (messageError) {
      // 账已经落了，但消息没建成 —— 这一条用户**看不到**，必须留日志。
      // 不回滚账目：账在，下一轮会当成"已见过"，于是这条公告再也不进消息栏。
      // 这是刻意的取舍：宁可少投一次（因为账是唯一锚点），也不重复投递。
      console.error('[sync] 公告消息创建失败（账已落，本条不再重投）:', messageError.message)
      continue
    }

    const messageId = (messageRow as { id: string }).id
    const { error: linkError } = await supabase
      .from('course_announcements')
      .update({ message_id: messageId })
      .eq('id', rowId)
    if (linkError) {
      console.error('[sync] 回填公告 message_id 失败（不影响消息本身）:', linkError.message)
    }

    created += 1
  }

  return {
    status: 'success',
    scanned: fetched.items.length,
    created,
    seen: seenRowIds.length,
    incomplete: !fetched.complete,
    error: null,
  }
}
