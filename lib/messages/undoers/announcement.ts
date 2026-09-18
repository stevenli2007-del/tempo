import { syncExamToTask } from '@/lib/sync/exam-tasks'
import { EXAM_DATE_COLUMNS, toExamDate, type ExamDateRow } from '@/lib/exam-dates'
import type { MessageApplied } from '@/types/message'
import type { MessageUndoer, UndoContext, UndoOutcome } from '@/lib/messages/undo'

/**
 * 公告的撤销器（P0-3-26，与 `appliers/announcement.ts` 对称）。
 *
 * 确认那一刻写入的是 `exam_dates` / `grade_components`，撤销就按当时记下的行 id 精准回滚：
 * - 考试行删除后**必须重跑 `syncExamToTask`**（ADR-004 唯一派生实现），
 *   否则对应的派生任务会变成孤儿滞留；
 * - 成绩构成没有派生任务，直接删即可；
 * - 按 `id + course_id` 双重定位，绝不 `delete().eq('course_id', …)` 整表清空；
 * - 删 0 行不报失败（可能已被手动删过 —— 那正是撤销想要的目标状态），但留痕；
 * - 任一步失败 → 明确失败，**绝不假装撤销成功**（ADR-016 R3）。
 *
 * ⚠️ 只有确认时**真正写入了数据**的消息才有 `payload.applied`；无落点公告（"知道了"）
 * 那类 `applied` 为空 → 这里直接当空操作返回 ok（撤销对它们本就无业务效果）。
 */
export const announcementUndoer: MessageUndoer = async (ctx: UndoContext): Promise<UndoOutcome> => {
  const { payload, supabase } = ctx
  const applied = (payload.applied ?? {}) as MessageApplied
  const examIds = applied.examDateIds ?? []
  const componentIds = applied.gradeComponentIds ?? []

  if (examIds.length === 0 && componentIds.length === 0) {
    // 没写任何业务数据，撤销即空操作。
    return { ok: true }
  }

  const courseId = typeof payload.courseId === 'string' ? payload.courseId : ''
  if (courseId === '') {
    return { ok: false, code: 'missing_course', message: '找不到课程，无法撤销' }
  }

  // ---------- 1) 考试行：按 id 删 + 重跑派生链 ----------
  if (examIds.length > 0) {
    const { data, error } = await supabase
      .from('exam_dates')
      .delete()
      .select('id')
      .eq('course_id', courseId)
      .in('id', examIds)
    if (error) {
      return { ok: false, code: 'exam_delete_failed', message: `撤销考试失败：${error.message}` }
    }
    const deleted = (data ?? []).length
    if (deleted < examIds.length) {
      // 部分行已不在（可能被手动删过）—— 不视为失败，但留痕，便于对账。
      console.warn('[messages] 撤销时部分考试行已不存在:', examIds.length - deleted)
    }

    // 重算派生任务：把被删考试对应的派生任务一并移除。
    const { data: all, error: loadError } = await supabase
      .from('exam_dates')
      .select(EXAM_DATE_COLUMNS)
      .eq('course_id', courseId)
    if (loadError) {
      return { ok: false, code: 'exam_reload_failed', message: `撤销后重算任务失败：${loadError.message}` }
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

  // ---------- 2) 成绩构成行：直接删（无派生任务） ----------
  if (componentIds.length > 0) {
    const { error } = await supabase
      .from('grade_components')
      .delete()
      .eq('course_id', courseId)
      .in('id', componentIds)
    if (error) {
      return { ok: false, code: 'component_delete_failed', message: `撤销成绩构成失败：${error.message}` }
    }
  }

  return { ok: true }
}
