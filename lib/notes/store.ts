import { createClient } from '@/lib/supabase/server'
import { earnsNote, planAwards, type NoteCandidate } from './awards'

/**
 * 音符的**读写层**（P0-5-4）。规则在 `awards.ts`（纯函数），这里只管落库。
 *
 * 🔴 **两个记入点共用这一个函数**（别在别处另写一遍 insert）：
 *   ① `PATCH /api/v1/tasks/:id` —— 用户手勾完成，当场记一枚；
 *   ② 总览页服务端渲染 —— 懒补 Canvas 代判完成的那部分（Steven 2026-09-24 拍板：给）。
 *   两处都调 `awardNotesForDone()`，"哪些算完成"就只有一个说法。
 */

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

const TABLE = 'note_awards'

export interface NoteAwardResult {
  /** 本次新记入的音符数（已挣到的不重复记）。 */
  awarded: number
  /** 记入之后的总数。`error !== null` 时这个数不可信。 */
  total: number
  /** 人话错误原因；成功为 null。**交给调用方决定怎么显示**，这里不吞。 */
  error: string | null
}

/** 只回计数不拉行（`head: true`），与侧栏待处理徽标同一写法。 */
export async function loadNoteCount(
  supabase: ServerSupabase,
  userId: string,
): Promise<{ total: number; error: string | null }> {
  const { count, error } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  if (error) return { total: 0, error: error.message }
  return { total: count ?? 0, error: null }
}

/**
 * 给这一批任务里**已完成且还没记过**的补上音符。
 *
 * ### 为什么先查后插，而不是直接 `upsert`
 * `upsert` 会把已存在行的 `awarded_at` **刷新成现在**（`on conflict do update` 的语义），
 * 于是"第一次完成于"这个信息被下一次刷新抹掉。而这一列的语义正是"第一次"——
 * 总览页每渲染一次都会跑一遍懒补，用 upsert 的话它天天在变。
 * 先查已有哪些 id、只 insert 缺的那几条，已挣到的行**一个字节都不动**。
 *
 * ### 幂等的最后一关在数据库
 * 主键 `(user_id, task_id)` 让重复插入根本写不进去（见迁移注释）——
 * 这里的"先查"只是为了少发无谓的写入，不是幂等的唯一保障。
 */
export async function awardNotesForDone(
  supabase: ServerSupabase,
  userId: string,
  candidates: readonly NoteCandidate[],
): Promise<NoteAwardResult> {
  const eligible = candidates.filter(earnsNote)
  if (eligible.length === 0) {
    const { total, error } = await loadNoteCount(supabase, userId)
    return { awarded: 0, total, error }
  }

  const ids = [...new Set(eligible.map((task) => task.id))]
  const { data, error: readError } = await supabase
    .from(TABLE)
    .select('task_id')
    .eq('user_id', userId)
    .in('task_id', ids)

  if (readError) return { awarded: 0, total: 0, error: readError.message }

  const held = (data ?? [])
    .map((row) => (row as { task_id?: unknown }).task_id)
    .filter((value): value is string => typeof value === 'string')

  const plan = planAwards(eligible, held)
  if (plan.toAward.length > 0) {
    const { error: insertError } = await supabase
      .from(TABLE)
      .insert(plan.toAward.map((taskId) => ({ user_id: userId, task_id: taskId })))

    // 并发下撞主键不算错：那一枚已经被另一个请求记走了，正好是我们想要的结果。
    // 其它错误（RLS / 表不存在）必须往上交，不能当成"记成功"。
    if (insertError && insertError.code !== '23505') {
      return { awarded: 0, total: 0, error: insertError.message }
    }
  }

  const { total, error: countError } = await loadNoteCount(supabase, userId)
  return { awarded: plan.delta, total, error: countError }
}
