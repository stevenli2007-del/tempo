import { toRestore } from '@/lib/messages/undoers/syllabus-drift'
import { syncExamToTask } from '@/lib/sync/exam-tasks'
import { EXAM_DATE_COLUMNS, deriveStatus, toExamDate, type ExamDateRow } from '@/lib/exam-dates'
import type { MessageApplied, MessageExamRestore } from '@/types/message'
import type { MessageUndoer, UndoContext, UndoOutcome } from '@/lib/messages/undo'

/**
 * 公告的撤销器（P0-3-26，与 `appliers/announcement.ts` 对称）。
 *
 * 确认那一刻写入的是 `exam_dates` / `grade_components`，撤销就按当时记下的精准回滚：
 * - **新增**的考试行 → 按 id 删；
 * - 🔴 **被更正**的考试行（P0-3-29 的改期）→ 按 `applied.examRestores` 的旧值**写回**。
 *   绝不能按 id 删 —— 那会把一行用户本来就有的考试连根删掉，
 *   表现是"撤销一次改期，结果这场考试整条消失了"。"恢复旧值"≠"删掉"。
 * - 成绩构成没有派生任务，直接删；
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
  // 被更正（改期）的行：按旧值快照还原，不按 id 删 —— 见文件头。
  const restores = (Array.isArray(applied.examRestores) ? applied.examRestores : [])
    .map(toRestore)
    .filter((item): item is MessageExamRestore => item !== null)

  if (examIds.length === 0 && componentIds.length === 0 && restores.length === 0) {
    // 没写任何业务数据，撤销即空操作。
    return { ok: true }
  }

  const courseId = typeof payload.courseId === 'string' ? payload.courseId : ''
  if (courseId === '') {
    return { ok: false, code: 'missing_course', message: '找不到课程，无法撤销' }
  }

  // ---------- 1) 被更正的考试：按旧值快照写回（**不是删**）----------
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
      console.warn('[messages] 撤销公告时被更正的考试已不存在，跳过还原:', restore.id)
    }
  }

  // ---------- 2) 新增的考试行：按 id 删 + 重跑派生链 ----------
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
  }

  // ---------- 3) 重跑派生链 ----------
  //
  // 删了行、也还原了旧日期，两者都要反映到派生任务上。重拉全量再交给它 ——
  // 它的契约是"该课程当前全部考试行"（只传动过的几条会被理解成"别的都删了"）。
  if (examIds.length > 0 || restores.length > 0) {
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

  // ---------- 4) 成绩构成行：直接删（无派生任务） ----------
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
