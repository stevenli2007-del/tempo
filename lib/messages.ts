import { MESSAGE_STATUSES, MESSAGE_TYPES } from '@/lib/messages/registry'
import { DEFAULT_SUMMARY_LOCALE } from '@/lib/messages/summary/locale'
import { loadSummaries } from '@/lib/messages/summary/store'
import { createClient } from '@/lib/supabase/server'
import type {
  Message,
  MessagePayload,
  MessageRow,
  MessageStatus,
  MessageSummary,
  MessageType,
} from '@/types/message'

/**
 * `messages` 表的读写（P0-3-18 消息栏的数据源）。
 *
 * ### 只在这里知道数据库列名
 * 与 `lib/tasks.ts` / `lib/courses.ts` 同一条约定：snake_case ↔ camelCase 的映射只有这一处。
 *
 * ### 归属怎么判定
 * 与 `tasks` 不同，`messages` **有自己的 `user_id` 列**，RLS 策略是
 * `auth.uid() = user_id`（迁移 `20260917200000`）。因此这里**不需要**像 tasks 那样
 * 先取课程 id 集合再 `.in('course_id', …)` 收口 —— 但前提是**必须用带会话的用户级客户端**
 * （`createClient()`），绝不能改用 service role：那会绕过 RLS，隐式隔离变成"读别人的消息"。
 */

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 查询列（列表与单条共用，避免两处 list 漂移 —— 与 `TASK_COLUMNS` 同一理由）。 */
export const MESSAGE_COLUMNS = 'id, user_id, type, payload, status, created_at, decided_at'

// 枚举白名单在 `lib/messages/registry.ts`（纯模块，回归脚本可断言）——
// 放在这里的话，测试 import 本文件就会拖进 `next/headers`，第 ② 处漏改永远测不出来。

/**
 * 把 DB 行映射成 `Message`。
 *
 * 🔴 **不认识的值一律不猜**：类型 / 状态越界时，这里不做"尽力而为"的降级
 * （把未知类型塞给 UI 只会让渲染层被迫瞎猜），而是由调用方处理未知行 ——
 * `toMessage()` 返回 `null`，`loadMessages` 会把它过滤掉并 `console.warn`。
 * 新增枚举取值时，这个函数与迁移的 CHECK 约束必须同时改（CodingRules §10.1 第 16 条）。
 *
 * @param summary AI 要点（P0-3-25b）。默认 null：要点存在**另一张表**里，
 *   只有列表读取会顺带查出来（`loadMessage` / `updateMessageStatus` 不带 ——
 *   已处理的提案只画一行回执，要点在那儿没有位置）。见 `types/message.ts`。
 */
export function toMessage(row: MessageRow, summary: MessageSummary | null = null): Message | null {
  if (!MESSAGE_TYPES.includes(row.type as MessageType)) return null
  if (!MESSAGE_STATUSES.includes(row.status as MessageStatus)) return null

  const payload = (row.payload ?? {}) as MessagePayload
  return {
    id: row.id,
    type: row.type as MessageType,
    payload,
    status: row.status as MessageStatus,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    summary,
  }
}

/** 取当前用户的消息列表（默认全部状态、按时间倒序）。 */
export async function loadMessages(
  supabase: ServerSupabase,
  options: { status?: MessageStatus; limit?: number } = {},
): Promise<{ messages: Message[]; error: string | null }> {
  let query = supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 100)

  if (options.status) {
    query = query.eq('status', options.status)
  }

  const { data, error } = await query
  if (error) return { messages: [], error: error.message }

  const messages: Message[] = []
  for (const row of (data ?? []) as MessageRow[]) {
    const mapped = toMessage(row)
    if (mapped) {
      messages.push(mapped)
    } else {
      // 不静默吞：未知 type / status 说明迁移与代码不同步，日志里必须看得见。
      console.warn('[messages] 跳过无法识别的行:', row.id, row.type, row.status)
    }
  }

  /**
   * 顺带查要点缓存（P0-3-25b）。
   *
   * ### 为什么在服务端一次查完，而不是让客户端逐条补
   * 首屏要直接画出**已有的**要点。留给客户端补的话，缓存命中的那些也会先渲染成空白、
   * 再被替换 —— 每次打开都闪一下，而它们明明早就算好了。
   * 客户端那一趟（`POST /api/v1/messages/summaries`）只负责**补缺**。
   *
   * `loadSummaries` 失败时返回空 Map 并留日志（见 `summary/store.ts` 文件头）：
   * 要点读不出来不该让整个消息栏打不开。
   */
  const summaries = await loadSummaries(
    supabase,
    messages.map((message) => message.id),
    DEFAULT_SUMMARY_LOCALE,
  )
  for (const message of messages) {
    message.summary = summaries.get(message.id) ?? null
  }

  return { messages, error: null }
}

/**
 * 单条读取（用户级客户端 + RLS：别人的 id 查不到，等同不存在 → 路由层回 404）。
 */
export async function loadMessage(
  supabase: ServerSupabase,
  id: string,
): Promise<{ message: Message | null; error: string | null }> {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) return { message: null, error: error.message }
  if (!data) return { message: null, error: null }
  return { message: toMessage(data as MessageRow), error: null }
}

/**
 * `pending` 计数 —— 侧栏徽标用。
 *
 * 用 `head: true` + `count: 'exact'`：只回计数，不把行拉回来
 * （这个查询在**每个页面**渲染时都会跑一次，见 `AppShell`）。
 */
export async function countPendingMessages(supabase: ServerSupabase): Promise<number> {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  if (error) {
    // 徽标是"有更好、没有也不算坏"的信息：查不动就不显示，
    // 但**必须留日志**（CodingRules §7 不吞异常），否则提案没人看见也查不出原因。
    console.warn('[messages] pending 计数失败:', error.message)
    return 0
  }
  return count ?? 0
}

/** 改状态（确认 / 忽略的唯一写点）。 */
export async function updateMessageStatus(
  supabase: ServerSupabase,
  id: string,
  status: MessageStatus,
): Promise<{ message: Message | null; error: string | null }> {
  const { data, error } = await supabase
    .from('messages')
    .update({ status })
    .eq('id', id)
    .select(MESSAGE_COLUMNS)
    .maybeSingle()

  if (error) return { message: null, error: error.message }
  if (!data) return { message: null, error: null }
  return { message: toMessage(data as MessageRow), error: null }
}

/**
 * 确认成功后落库回执（P0-3-26）。
 *
 * applier 跑完、确认这一步才把「写了什么」写进消息本身，刷新后仍在：
 * - `decided_at`：确认时刻（24h 撤销窗口的基准）；
 * - `payload.applied`：本次新写入的业务数据行 id（撤销按它精准回滚）；
 * - `payload.receipt`：人话回执文案（如「已写入 2 条考试，该课现在共 7 条」）。
 *
 * 与 `updateMessageStatus` 分开：前者先改状态、后者在 applier 成功后才补这两列，
 * 避免"状态已改、回执却没写进去"的半截状态。
 */
export async function finalizeConfirmation(
  supabase: ServerSupabase,
  id: string,
  payload: MessagePayload,
  decidedAt: string,
): Promise<{ message: Message | null; error: string | null }> {
  const { data, error } = await supabase
    .from('messages')
    .update({ decided_at: decidedAt, payload })
    .eq('id', id)
    .select(MESSAGE_COLUMNS)
    .maybeSingle()

  if (error) return { message: null, error: error.message }
  if (!data) return { message: null, error: null }
  return { message: toMessage(data as MessageRow), error: null }
}
