import { EXAM_DATE_COLUMNS, deriveStatus, toExamDate, type ExamDateRow } from '@/lib/exam-dates'
import { syncExamToTask } from '@/lib/sync/exam-tasks'
import type { MessageUndoer, UndoContext, UndoOutcome } from '@/lib/messages/undo'
import type { MessageApplied, MessageExamRestore } from '@/types/message'

/**
 * 大纲漂移的撤销器（P0-3-20，与 `appliers/syllabus-drift.ts` 对称）。
 *
 * ### 🔴 与公告的撤销器有一处**本质不同**
 * 公告确认写入的全是 **insert**，撤销就是把它们删掉（按 id）。
 * 大纲漂移里还有一类是 **update** ——「Unit 3 Exam 从 10/20 改到 10/27」。
 * 那类**绝不能按 id 删**（那会把一行用户本来就有的考试连根删掉），
 * 必须按确认时留下的**旧值快照**（`payload.applied.examRestores`）写回去。
 * 这也是为什么确认时要专门存一份结构化快照 —— 见 `MessageExamRestore` 的注释。
 *
 * ### 三件事，一个顺序
 * 1. 新增的考试 → 按 id 删；
 * 2. 被更正的考试 → 按快照还原旧值；
 * 3. **重跑 `syncExamToTask`**（ADR-004 唯一派生实现）——
 *    不重跑的话，日历上那道派生任务会停在改期后的日期上，
 *    而库里已经没有那行考试了（孤儿缓存）。
 * 4. 新增的成绩构成 → 按 id 删（没有派生任务）。
 *
 * ### 纪律
 * - 一律 `id + course_id` 双重定位，绝不 `delete().eq('course_id', …)` 整表清空；
 * - 目标是"回到用户确认前的状态"，所以**影响 0 行不算失败**（可能已被手动删/改过 ——
 *   那正是想要的状态），但一定留痕；
 * - 任一步失败 → 明确失败，**绝不假装撤销成功**（ADR-016 R3）。
 */

/** 一条旧值快照（形状不对就不撤它 —— 宁可不还原，也不拿半截值去写库）。 */
function toRestore(raw: unknown): MessageExamRestore | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  if (typeof record.examName !== 'string') return null
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    id: record.id,
    examName: record.examName,
    examDate: text(record.examDate),
    examTime: text(record.examTime),
    location: text(record.location),
    sourceExcerpt: text(record.sourceExcerpt),
  }
}

export const syllabusDriftUndoer: MessageUndoer = async (ctx: UndoContext): Promise<UndoOutcome> => {
  const { payload, supabase } = ctx
  const applied = (payload.applied ?? {}) as MessageApplied
  const createdExamIds = Array.isArray(applied.examDateIds) ? applied.examDateIds : []
  const createdComponentIds = Array.isArray(applied.gradeComponentIds)
    ? applied.gradeComponentIds
    : []
  const restores = (Array.isArray(applied.examRestores) ? applied.examRestores : [])
    .map(toRestore)
    .filter((item): item is MessageExamRestore => item !== null)

  if (createdExamIds.length === 0 && createdComponentIds.length === 0 && restores.length === 0) {
    // 没写任何业务数据（`clean` / 「知道了」那类）→ 撤销即空操作。
    return { ok: true }
  }

  const courseId = typeof payload.courseId === 'string' ? payload.courseId : ''
  if (courseId === '') {
    return { ok: false, code: 'missing_course', message: '找不到课程，无法撤销' }
  }

  // ---------- 1) 新增的考试：按 id 删 ----------
  if (createdExamIds.length > 0) {
    const { data, error } = await supabase
      .from('exam_dates')
      .delete()
      .select('id')
      .eq('course_id', courseId)
      .in('id', createdExamIds)
    if (error) {
      return { ok: false, code: 'exam_delete_failed', message: `撤销新增的考试失败：${error.message}` }
    }
    const deleted = (data ?? []).length
    if (deleted < createdExamIds.length) {
      // 部分行已不在（可能被手动删过）—— 不视为失败，但留痕，便于对账。
      console.warn('[messages] 撤销漂移时部分新增考试已不存在:', createdExamIds.length - deleted)
    }
  }

  // ---------- 2) 被更正的考试：按旧值快照还原（**不是删**） ----------
  for (const restore of restores) {
    const { data, error } = await supabase
      .from('exam_dates')
      .update({
        exam_name: restore.examName,
        exam_date: restore.examDate,
        exam_time: restore.examTime,
        location: restore.location,
        status: deriveStatus(restore.examDate),
        source_excerpt: restore.sourceExcerpt,
        // ⚠️ 同样不碰 `is_confirmed` / `source`：撤销是"把值放回去"，
        // 不是"改变这一行的来源属性"。写入器也没动过这两列，对称。
      })
      .eq('id', restore.id)
      .eq('course_id', courseId)
      .select('id')
    if (error) {
      return {
        ok: false,
        code: 'exam_restore_failed',
        message: `还原被更正的考试失败：${error.message}`,
      }
    }
    if ((data ?? []).length === 0) {
      // 行没了（用户在这期间手动删过）→ 目标状态本来就是"这条不在了"，不算失败。
      console.warn('[messages] 撤销漂移时被更正的考试已不存在，跳过还原:', restore.id)
    }
  }

  // ---------- 3) 重跑派生链 ----------
  //
  // 删了行、也还原了日期，两者都要反映到派生任务上。重拉全量再交给它 ——
  // 它的契约是"该课程当前全部考试行"（只传动过的几条会被理解成"别的都删了"）。
  if (createdExamIds.length > 0 || restores.length > 0) {
    const { data: all, error: loadError } = await supabase
      .from('exam_dates')
      .select(EXAM_DATE_COLUMNS)
      .eq('course_id', courseId)
    if (loadError) {
      return {
        ok: false,
        code: 'exam_reload_failed',
        message: `撤销后重算任务失败：${loadError.message}`,
      }
    }
    const stored = ((all ?? []) as ExamDateRow[]).map(toExamDate)
    try {
      await syncExamToTask({ supabase, courseId, exams: stored })
    } catch (error) {
      return {
        ok: false,
        code: 'task_resync_failed',
        message: `撤销后任务重算失败：${(error as Error).message ?? '未知错误'}`,
      }
    }
  }

  // ---------- 4) 新增的成绩构成：按 id 删（无派生任务） ----------
  if (createdComponentIds.length > 0) {
    const { error } = await supabase
      .from('grade_components')
      .delete()
      .eq('course_id', courseId)
      .in('id', createdComponentIds)
    if (error) {
      return {
        ok: false,
        code: 'component_delete_failed',
        message: `撤销新增的成绩构成失败：${error.message}`,
      }
    }
  }

  return { ok: true }
}
