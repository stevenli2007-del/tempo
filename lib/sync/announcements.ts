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
 *
 * ### 🔴 两条通道（C 口径，2026-09-18 Steven 拍板）
 * 第一版是"每条公告各建一条消息"。真账号实测一轮窗口内 **48 条**，其中 **40 条无落点**
 * —— 用户要点 40 次「知道了」才能把消息栏清干净，与 ADR-016「用户操作量趋零」直接冲突。
 *
 * 于是按落点分两条通道：
 * | 通道 | 谁走 | 消息条数 | 按钮 |
 * |---|---|---|---|
 * | 逐条 | **有落点**（能写出考试 / 成绩构成） | 每条 1 条 | 「确认」（真的会写） |
 * | 摘要 | **无落点**（通知类，不写任何字段） | 全部合并成 **1 条** | 「知道了」 |
 *
 * 实测 48 条 → **9 条消息**（8 逐条 + 1 摘要），而用户**一条都没漏**：
 * 摘要里逐条列着标题 + 课程名 + 原文链接。这是"操作量"和"不漏"之间刻意选的平衡点。
 *
 * ⚠️ **有落点的公告绝不折进摘要**：折进去用户就没法点「确认」了 ——
 * 那是把能力藏起来，比多点一次更糟（见 `lib/course-update/landing.ts` 的宽进原则）。
 *
 * ⚠️ 摘要**按轮**：一轮同步里新到的无落点公告合成一条。所以持续收到通知时，
 * 消息栏会积累多条摘要而不是无限增长的一条 —— 每一条代表"那一轮老师发了什么"，
 * 时间线语义（会话式版面要的正是这个）。
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

/** 本轮新到的一条公告 + 它属于哪门课（进入"两条通道"之前的中间形状）。 */
export type FreshAnnouncement = {
  announcement: CanvasAnnouncement
  courseId: string
  courseName: string
}

/**
 * 🔴 **分流是 C 口径的唯一判定点**（同步与在线探针共用）。
 *
 * 抽出来不只是为了少写一行 filter —— `scripts/probe-announcements.ts` 要数出
 * "用户到底要点几次"，而它必须数的是**线上真实会做的分流**。
 * 探针里自己重写一遍 `hasStructuredLanding(...) ? a : b`，就等于 P0-3-15 那种
 * 「两处各写一遍、都绿、肉眼才看得出」的分叉预备队。
 */
export function partitionByLanding(fresh: FreshAnnouncement[]): {
  /** 有落点：逐条进消息栏，按钮是「确认」。 */
  withLanding: FreshAnnouncement[]
  /** 无落点：合并成一条摘要，按钮是「知道了」。 */
  plain: FreshAnnouncement[]
} {
  const withLanding: FreshAnnouncement[] = []
  const plain: FreshAnnouncement[] = []
  for (const item of fresh) {
    if (hasStructuredLanding(item.announcement.bodyText)) withLanding.push(item)
    else plain.push(item)
  }
  return { withLanding, plain }
}

/**
 * 摘要里最多列多少条。
 *
 * 学期初或长时间没同步后，一轮可能涌进上百条。payload 是 jsonb，
 * 不设上限就是"某天消息栏里多了一张几十 KB 的卡片，浏览器渲染它要几秒"。
 * 超出的部分**明确计数**（`digestOverflow`），不假装全部可见。
 */
export const MAX_DIGEST_ITEMS = 50

/** 摘要预览行（`details`）显示几条标题 —— 气泡收起时用户先看到这几条。 */
const DIGEST_PREVIEW_LINES = 3

/** `posted_at` → 显示文案。抽出来是为了逐条通道和摘要通道**说的是同一句话**。 */
export function postedAtLabel(postedAt: string | null): string {
  return postedAt ? `发布于 ${postedAt.slice(0, 10)}` : '发布时间未知'
}

/**
 * 组装「通知类公告」的合并摘要载荷（C 口径）。
 *
 * ### 标题为什么带课程数
 * 「40 条通知类公告」和「6 门课的 40 条通知类公告」对用户是两种信息 ——
 * 后者一眼能看出"不是我那门课的老师话多，是全都在发"。单门课时就不写前缀（读起来更顺）。
 *
 * ### 排序按发布时间倒序
 * 摘要列表里最新的在最上面（用户关心的是"最近发生了什么"）。
 * 🔴 不能依赖 Canvas 的返回顺序 —— 那是接口实现细节，哪天变了就是静默错排。
 * `postedAt` 是 ISO 字符串，字典序即时间序；缺失的（`''`）在倒序里自然落到最后。
 */
export function buildAnnouncementDigestPayload(items: FreshAnnouncement[]): MessagePayload {
  const ordered = [...items].sort((a, b) =>
    (b.announcement.postedAt ?? '').localeCompare(a.announcement.postedAt ?? ''),
  )

  const shown = ordered.slice(0, MAX_DIGEST_ITEMS)
  const overflow = ordered.length - shown.length
  const courseCount = new Set(ordered.map((item) => item.courseName)).size

  const payload: MessagePayload = {
    title:
      courseCount > 1
        ? `${courseCount} 门课的 ${ordered.length} 条通知类公告`
        : `${ordered.length} 条通知类公告`,
    details: [
      // 第一行必须先说清"确认之后什么都不会变" —— 否则用户点「知道了」时是心里没底的。
      '这些公告里没有可写入的考试 / 成绩构成，确认只留一行回执',
      // 预览几行标题：气泡**收起时**用户就能知道"老师最近说了什么"，
      // 不必为了看个大概就展开整个列表。完整列表（带时间与原文链接）在 `digest` 里。
      ...shown
        .slice(0, DIGEST_PREVIEW_LINES)
        .map((item) => `[${item.courseName}] ${item.announcement.title}`),
    ],
    digest: shown.map((item) => ({
      title: item.announcement.title,
      courseName: item.courseName,
      postedAtLabel: postedAtLabel(item.announcement.postedAt),
      sourceUrl: item.announcement.htmlUrl,
    })),
    // 🔴 无落点 → applier 走「知道了」空写入分支。这个字段**必须**有：
    // 缺了它 `view.ts` 会把按钮画成「确认」，那就成了"点一下、什么都没发生"的静默失败。
    landing: false,
    // Canvas 是权威源、正文是老师亲手写的 —— 不标低置信度（低置信度会禁掉按钮）。
    confidence: 'high',
  }

  if (overflow > 0) payload.digestOverflow = overflow
  return payload
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
    digested: 0,
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

  // ---------- 6) 分流（C 口径的唯一判定点，见 `partitionByLanding`） ----------
  const { withLanding, plain } = partitionByLanding(fresh)

  // ---------- 7) 有落点 → 逐条进消息栏（按钮「确认」，applier 会真的写字段） ----------
  let created = 0
  for (const item of withLanding) {
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
      postedAtLabel: postedAtLabel(item.announcement.postedAt),
    })

    const messageId = await insertAnnouncementMessage(supabase, userId, payload)
    if (!messageId) continue

    await linkMessageToAnnouncements(supabase, [rowId], messageId)
    created += 1
  }

  // ---------- 8) 无落点 → 合并成**一条**摘要（C 口径的核心） ----------
  //
  // 🔴 这里刻意只建一条消息，不是循环。40 条通知类公告各建一条 = 用户要点 40 次
  // 「知道了」，与 ADR-016「用户操作量趋零」直接冲突（实测 48 条 / 40 条无落点）。
  // 合并**不丢信息**：摘要里逐条列着标题 + 课程名 + 原文链接。
  if (plain.length > 0) {
    const rowIds: string[] = []
    const missing: string[] = []
    for (const item of plain) {
      const rowId = rowIdByKey.get(`${item.courseId}|${item.announcement.externalId}`)
      if (rowId) rowIds.push(rowId)
      else missing.push(item.announcement.externalId)
    }
    if (missing.length > 0) {
      // 账已落但拿不到行 id：这些公告进不了摘要的 `message_id` 回填 —— 留日志，
      // 因为"摘要里少了一条"是**用户看不见**的（而账在，下一轮也不会重投）。
      console.warn('[sync] 公告已写入但未返回 id，摘要里无法回填:', missing.join(','))
    }

    const payload = buildAnnouncementDigestPayload(plain)
    const messageId = await insertAnnouncementMessage(supabase, userId, payload)
    if (messageId) {
      await linkMessageToAnnouncements(supabase, rowIds, messageId)
      created += 1
    }
    // 失败时 `created` 不加：这一批公告**一条都没进消息栏**（账已落、不会重投），
    // 如实反映在计数里，让 `sync_runs` 的账看得出来（见下面 insertAnnouncementMessage 的注释）。
  }

  return {
    status: 'success',
    scanned: fetched.items.length,
    created,
    digested: plain.length,
    seen: seenRowIds.length,
    incomplete: !fetched.complete,
    error: null,
  }
}

/**
 * 建一条公告消息。成功返回 id，失败返回 null（**并留日志**）。
 *
 * ### 🔴 失败为什么不回滚公告账
 * 账（`course_announcements`）是幂等的唯一锚点，消息是它的产物。回滚账 = 下一轮
 * 窗口再抓到同一条 → 重复投递；而重复进消息栏是最伤信任的一类 bug
 * （用户看到两条一样的公告，就会开始怀疑所有条目）。所以取舍是：
 * **宁可少投一次，也不重复投**，并把失败写进日志（不静默）。
 *
 * ⚠️ 代价要说清：这个失败**不会**进 `SyncAnnouncementSummary.error`
 * —— 公告整体是成功的（拿到了、也记账了），只有某几条没变成消息。
 * 表现是"消息栏少了几条"，日志里有。`created` 计数会如实偏低，可作对账依据。
 */
async function insertAnnouncementMessage(
  supabase: SupabaseClient,
  userId: string,
  payload: MessagePayload,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ user_id: userId, type: 'announcement', payload, status: 'pending' })
    .select('id')
    .single()

  if (error) {
    console.error('[sync] 公告消息创建失败（账已落，本条不再重投）:', error.message)
    return null
  }
  return (data as { id: string }).id
}

/**
 * 回填 `course_announcements.message_id`（溯源用：这条账变成了哪条消息）。
 *
 * 摘要通道下多个公告行会指向**同一条**消息 —— 这是对的，不是数据错误：
 * 字段语义是"它进消息栏时挂在哪条消息上"，而摘要本来就是多对一。
 * 回填失败**不影响消息本身**（用户已经能看到），所以只留日志、不抛。
 */
async function linkMessageToAnnouncements(
  supabase: SupabaseClient,
  rowIds: string[],
  messageId: string,
): Promise<void> {
  if (rowIds.length === 0) return
  const { error } = await supabase
    .from('course_announcements')
    .update({ message_id: messageId })
    .in('id', rowIds)
  if (error) {
    console.error('[sync] 回填公告 message_id 失败（不影响消息本身）:', error.message)
  }
}
