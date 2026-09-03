import type { StoredExamDate } from '@/types/sections'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * `exam_dates → tasks` 的单向派生（ADR-004，`Database.md` 第 5 节）。
 *
 * **全项目唯一允许写 `tasks` 里考试派生行的地方**：
 * `Database.md` 5.3 明令"同步逻辑写在一处，禁止在各业务分支里零散 insert into tasks"。
 * 目前调用方有两处 —— 五板块保存端点（P0-1-5b）和解析落库（`persist.ts`）。
 *
 * ### 规则
 *
 * - 权威源是 `exam_dates`：保存后的最终状态整表对齐到 `tasks`；
 * - 派生 task 的 `source = 'syllabus'`、`task_type = 'exam'`、
 *   `source_id = exam_dates.id`、`is_derived = true`；
 * - `exam_date` 为 null 或 status = tbd → `due_date = null`，**禁止编造日期**；
 * - **用户改过的 `status`（pending/done）不动** —— 更新只碰 title / due_date，
 *   否则用户刚勾掉的"已完成"会被一次保存打回 pending（Database.md 4.1 的反面）；
 * - exam 行被删 → 对应派生 task **物理删除**。它是缓存不是用户数据；
 *   软删除的 is_deleted 语义是给 Canvas 任务的（外部误删可恢复），
 *   考试行没了，缓存就该跟着消失，保留反而会在下次同步时撞
 *   `(course_id, source, source_id)` 唯一索引。
 *
 * ### `due_date` 的时间取值（Phase 0 约定）
 *
 * `exam_time` 是自由文本（如 `7-9pm`），解析成时间戳不可靠 —— Phase 0 **不解析**，
 * 有日期就统一派生为当日 `23:59:59`（无时区，由 Postgres 按 UTC 解释）。
 * 所有考试任务同一规则，总览页排序不受影响；时间细节在课程页看
 * `exam_dates.exam_time` 原文。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** 派生 task 的固定形状。 */
const EXAM_TASK_SOURCE = 'syllabus'
const EXAM_TASK_TYPE = 'exam'

export async function syncExamToTask({
  supabase,
  courseId,
  exams,
}: {
  supabase: SupabaseClient
  courseId: string
  /** 该课程当前全部考试行（保存 / 解析后的最终状态）。 */
  exams: StoredExamDate[]
}): Promise<void> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, source_id, title, due_date, status')
    .eq('course_id', courseId)
    .eq('source', EXAM_TASK_SOURCE)
    .eq('task_type', EXAM_TASK_TYPE)

  if (error) {
    throw error
  }

  const existingTasks = (data ?? []) as Array<{
    id: string
    source_id: string | null
    title: string
    due_date: string | null
    status: string
  }>

  const byExamId = new Map(
    existingTasks.filter((task) => task.source_id !== null).map((task) => [task.source_id as string, task]),
  )
  const currentExamIds = new Set(exams.map((exam) => exam.id))

  // 1) 考试行已删 → 派生 task 物理删除（理由见文件头）。
  const orphanedIds = existingTasks
    .filter((task) => task.source_id === null || !currentExamIds.has(task.source_id))
    .map((task) => task.id)
  if (orphanedIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('tasks')
      .delete()
      .in('id', orphanedIds)
      .eq('course_id', courseId)
      .eq('source', EXAM_TASK_SOURCE)
      .eq('is_derived', true)
    if (deleteError) {
      throw deleteError
    }
  }

  // 2) 每个考试行 → 插入或更新派生 task。串行：行数是个位数，
  //    失败时「断在哪一行」是确定的（与 persist.ts 同一取舍）。
  for (const exam of exams) {
    // tbd / 日期为空 → null，禁止编造（ADR-004 的硬规则）。
    const dueDate = exam.examDate !== null ? `${exam.examDate}T23:59:59` : null
    const existing = byExamId.get(exam.id)

    if (!existing) {
      const { error: insertError } = await supabase.from('tasks').insert({
        course_id: courseId,
        title: exam.examName,
        due_date: dueDate,
        task_type: EXAM_TASK_TYPE,
        source: EXAM_TASK_SOURCE,
        source_id: exam.id,
        status: 'pending',
        is_derived: true,
      })
      if (insertError) {
        throw insertError
      }
      continue
    }

    // due_date 从 Postgres 回来是带时区的 ISO 串，与本地拼的串不能直接 ===，
    // 按时间值比较；没变化就不发更新（updated_at 只反映真实变化，4.2 的精神）。
    const changed =
      existing.title !== exam.examName ||
      new Date(existing.due_date ?? '').getTime() !== new Date(dueDate ?? '').getTime()
    if (changed) {
      const { error: updateError } = await supabase
        .from('tasks')
        .update({ title: exam.examName, due_date: dueDate })
        .eq('id', existing.id)
      if (updateError) {
        throw updateError
      }
    }
  }
}
