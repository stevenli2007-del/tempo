import { createClient } from '@/lib/supabase/server'
import type { Message, MessagePayload, MessageRow, MessageStatus, MessageType } from '@/types/message'

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
export const MESSAGE_COLUMNS = 'id, user_id, type, payload, status, created_at'

const MESSAGE_TYPES: readonly MessageType[] = [
  'syllabus_drift',
  'practice_test',
  'routine',
  'material',
]
const MESSAGE_STATUSES: readonly MessageStatus[] = ['pending', 'accepted', 'dismissed']

/**
 * 把 DB 行映射成 `Message`。
 *
 * 🔴 **不认识的值一律不猜**：类型 / 状态越界时，这里不做"尽力而为"的降级
 * （把未知类型塞给 UI 只会让渲染层被迫瞎猜），而是由调用方处理未知行 ——
 * `toMessage()` 返回 `null`，`loadMessages` 会把它过滤掉并 `console.warn`。
 * 新增枚举取值时，这个函数与迁移的 CHECK 约束必须同时改（CodingRules §10.1 第 16 条）。
 */
export function toMessage(row: MessageRow): Message | null {
  if (!MESSAGE_TYPES.includes(row.type as MessageType)) return null
  if (!MESSAGE_STATUSES.includes(row.status as MessageStatus)) return null

  const payload = (row.payload ?? {}) as MessagePayload
  return {
    id: row.id,
    type: row.type as MessageType,
    payload,
    status: row.status as MessageStatus,
    createdAt: row.created_at,
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
