/**
 * 摘要缓存与公告正文的**数据访问层**（P0-3-25b）。
 *
 * 与 `lib/messages.ts` / `lib/tasks.ts` 同一条约定：**snake_case 只出现在这里**。
 * 上层（生成器 / 路由 / 页面）只认 camelCase 的 `MessageSummary`。
 *
 * ### 🔴 两条"失败不抛"的纪律（这里刻意与"不吞异常"的默认取向不同）
 * 1. **读取失败 → 空 Map + `console.warn`**：要点是**增强**，不是消息栏成立的前提。
 *    它读不出来（典型情况：迁移还没跑）时必须让消息栏照常打开 ——
 *    否则一次漏跑迁移会表现为"整个消息栏打不开"，而真正的原因是缺一张缓存表。
 *    但**必须留日志**：静默降级 + 没有痕迹 = 谁也不知道要点为什么一直不出现。
 * 2. **写入失败 → 由调用方决定**（本层把错误原样回给调用方，不吞）：
 *    写不进去意味着"这次生成的要点下次还要重算"，是有成本的，
 *    调用方要能据此打日志、也必须能如实回报。
 */

import { createClient } from '@/lib/supabase/server'
import { DEFAULT_SUMMARY_LOCALE, type SummaryLocale } from '@/lib/messages/summary/locale'
import type { MessageSummary } from '@/types/message'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 查询列（读写共用一份，避免两处漂移 —— 与 `MESSAGE_COLUMNS` 同一理由）。 */
const SUMMARY_COLUMNS = 'message_id, locale, status, points, items_used, items_total, created_at'

type SummaryRow = {
  message_id: string
  locale: string
  status: string
  points: unknown
  items_used: number | null
  items_total: number | null
  created_at: string
}

/** 非负整数守卫（jsonb / int 列都可能被手工改坏）。 */
function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * 行 → `MessageSummary`。不能识别的行返回 `null`（调用方跳过并留日志，
 * 与 `toMessage()` 同一取向：不认识的值**不猜**）。
 */
function toSummary(row: SummaryRow): MessageSummary | null {
  if (row.status !== 'ok' && row.status !== 'failed') return null
  const points = Array.isArray(row.points)
    ? row.points.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []

  return {
    // 失败行一律当"没有要点"：`points` 即便被手工塞过东西也不渲染 ——
    // 界面上出现半份来路不明的要点，比什么都不显示更糟。
    points: row.status === 'ok' ? points : [],
    itemsUsed: readCount(row.items_used),
    itemsTotal: readCount(row.items_total),
    status: row.status,
    createdAt: row.created_at,
  }
}

/**
 * 按消息 id 批量读要点（**只读当前语言**）。
 *
 * 一屏十几条消息 → 一次 `.in()` 查完，不做 N 次往返。
 */
export async function loadSummaries(
  supabase: ServerSupabase,
  messageIds: string[],
  locale: SummaryLocale = DEFAULT_SUMMARY_LOCALE,
): Promise<Map<string, MessageSummary>> {
  const result = new Map<string, MessageSummary>()
  if (messageIds.length === 0) return result

  const { data, error } = await supabase
    .from('message_summaries')
    .select(SUMMARY_COLUMNS)
    .in('message_id', messageIds)
    .eq('locale', locale)

  if (error) {
    // 见本文件头的纪律 1：降级 + 留痕，不抛。
    console.warn('[summary] 读取要点缓存失败（消息栏照常显示，仅无 AI 要点）:', error.message)
    return result
  }

  for (const row of (data ?? []) as SummaryRow[]) {
    const summary = toSummary(row)
    if (summary) {
      result.set(row.message_id, summary)
      continue
    }
    console.warn('[summary] 跳过无法识别的要点行:', row.message_id, row.status)
  }
  return result
}

/**
 * 写一条要点（`(message_id, locale)` 冲突则覆盖）。
 *
 * 用 upsert 而不是 insert：打开消息栏可能并发触发两次生成（两个标签页），
 * 主键挡下第二条是"报错"，而 upsert 是"两边都拿到一份可用的要点"——
 * 同一条公告同一门语言算两次的结果没有实质差别，覆盖掉比报错干净。
 */
export async function saveSummary(input: {
  supabase: ServerSupabase
  messageId: string
  locale: SummaryLocale
  status: 'ok' | 'failed'
  points: string[]
  itemsUsed: number
  itemsTotal: number
  model: string | null
  errorMessage: string | null
}): Promise<{ error: string | null }> {
  const { error } = await input.supabase.from('message_summaries').upsert(
    {
      message_id: input.messageId,
      locale: input.locale,
      status: input.status,
      points: input.points,
      items_used: input.itemsUsed,
      items_total: input.itemsTotal,
      model: input.model,
      error_message: input.errorMessage,
    },
    { onConflict: 'message_id,locale' },
  )

  return { error: error ? error.message : null }
}

/** 一条候选消息（有待生成资格：**公告类型 + 仍是 pending**）。 */
export type SummaryCandidate = {
  id: string
  /** 消息标题 —— 当上下文递给模型（"这条消息一共 40 条通知"这类信息在里面）。 */
  title: string
  createdAt: string
}

/**
 * 取出"可以生成要点"的消息。
 *
 * ### 为什么 filter 放在 SQL 里（而不是取回来再过滤）
 * 三个条件都是**不能靠客户端保证的**：
 * - `type = 'announcement'`：别的类型（大纲变更 / 自测卷）的要点没有意义，
 *   而且它们的 payload 里根本没有公告 —— 放进去就是让模型凭空编；
 * - `status = 'pending'`：已确认 / 已忽略的消息在界面上只剩一行回执，没有位置画要点，
 *   为它花钱生成纯属浪费（而且可能是几个月前的旧消息）；
 * - 归属：由 RLS（`messages.user_id = auth.uid()`）兜底 —— 别人的 id 查不出来，
 *   于是静默不在候选里。**不回 404**：那等于确认"这个 id 存在"。见 ADR-010。
 */
export async function loadSummaryCandidates(
  supabase: ServerSupabase,
  messageIds: string[],
): Promise<{ candidates: SummaryCandidate[]; error: string | null }> {
  if (messageIds.length === 0) return { candidates: [], error: null }

  const { data, error } = await supabase
    .from('messages')
    .select('id, payload, created_at')
    .in('id', messageIds)
    .eq('type', 'announcement')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) return { candidates: [], error: error.message }

  const candidates: SummaryCandidate[] = []
  for (const row of (data ?? []) as { id: string; payload: unknown; created_at: string }[]) {
    candidates.push({
      id: row.id,
      title: readMessageTitle(row.payload),
      createdAt: row.created_at,
    })
  }
  return { candidates, error: null }
}

/** `payload.title` 的守卫读取（jsonb 无 schema 约束，什么都可能出现）。 */
function readMessageTitle(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const title = (payload as Record<string, unknown>).title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  return '（无标题消息）'
}

/** 一条挂在消息上的公告（生成要点用的最小形状）。 */
export type LinkedAnnouncement = {
  messageId: string
  title: string
  courseName: string | null
  postedAt: string | null
  bodyText: string | null
}

/**
 * 按消息 id 批量取"挂在它上面的公告正文"。
 *
 * ### 为什么靠 `message_id` 反查，而不是把正文塞进 payload
 * 同步时已经把每条公告的 `message_id` 回填到 `course_announcements` 了
 * （`linkMessageToAnnouncements`，多对一：摘要消息对应几十条公告）。
 * 那里是**权威关系**，而 payload 里的 `digest[]` 只是给人看的展示副本
 * （还按上限截断过）。要点要覆盖"这条消息真正包含的公告"，
 * 所以走关系表；用 payload 派生的话，一改展示上限就会静默改变摘要的输入。
 *
 * ### 为什么不分页
 * 一条消息最多几十条公告，一次查完最简单。上限由 `buildSummaryInput()`
 * 的预算控制（它同时负责如实计数），不在这里切 —— 切在这里会让 `itemsTotal`
 * 变成"切完之后的数"，而覆盖率恰恰要报**总**数。
 */
export async function loadAnnouncementsForMessages(
  supabase: ServerSupabase,
  messageIds: string[],
): Promise<{ byMessage: Map<string, LinkedAnnouncement[]>; error: string | null }> {
  const byMessage = new Map<string, LinkedAnnouncement[]>()
  if (messageIds.length === 0) return { byMessage, error: null }

  const { data, error } = await supabase
    .from('course_announcements')
    .select('message_id, title, body_text, posted_at, course_id')
    .in('message_id', messageIds)
    .order('posted_at', { ascending: false })

  if (error) return { byMessage, error: error.message }

  const rows = (data ?? []) as {
    message_id: string
    title: string | null
    body_text: string | null
    posted_at: string | null
    course_id: string
  }[]

  // 课程名单独查一次（而不是 PostgREST 的嵌入语法）：嵌入依赖外键名解析，
  // 出错时的报错很难懂；这里多一次往返换来"错了看得懂"。
  const courseIds = [...new Set(rows.map((row) => row.course_id))]
  const courseNames = new Map<string, string>()
  if (courseIds.length > 0) {
    const { data: courses, error: courseError } = await supabase
      .from('courses')
      .select('id, course_name')
      .in('id', courseIds)
    if (courseError) {
      // 课程名缺失不影响要点质量（只是少了"哪门课"的上下文）→ 降级继续。
      console.warn('[summary] 读取课程名失败（要点仍会生成，只是少了课程上下文）:', courseError.message)
    }
    for (const course of (courses ?? []) as { id: string; course_name: string | null }[]) {
      if (course.course_name) courseNames.set(course.id, course.course_name)
    }
  }

  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? []
    list.push({
      messageId: row.message_id,
      title: row.title ?? '',
      courseName: courseNames.get(row.course_id) ?? null,
      postedAt: row.posted_at,
      bodyText: row.body_text,
    })
    byMessage.set(row.message_id, list)
  }

  return { byMessage, error: null }
}
