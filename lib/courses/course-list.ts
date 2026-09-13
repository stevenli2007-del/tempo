import type { UpcomingTaskView } from '@/components/courses/course-card'
import { SYLLABUS_COLUMNS, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import { createClient } from '@/lib/supabase/server'
import { formatDue } from '@/lib/tasks/format'
import type { Course } from '@/types/course'
import type { Syllabus } from '@/types/syllabus'
import type { UpcomingTask } from '@/types/task'

/**
 * 课程列表（`/courses` 页）的数据构造 —— P0-3-7b 从 dashboard 抽出。
 *
 * 抽出来的理由不是"文件太长"，是**这两个页面必须口径一致**：
 * 课程卡在两处渲染的是同一批数据，`formatDue` / 提交态判定若各写一份，
 * 迟早出现"同一门课在两个页面显示不同日期"。**改这里 = 两个页面同时改。**
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * 按学期分组。Map 保持插入顺序，配合 SQL 的 created_at 升序，分组顺序稳定可预期。
 */
export function groupBySemester(courses: Course[]): { semester: string; courses: Course[] }[] {
  const groups = new Map<string, Course[]>()
  for (const course of courses) {
    const list = groups.get(course.semester)
    if (list) {
      list.push(course)
    } else {
      groups.set(course.semester, [course])
    }
  }
  return Array.from(groups, ([semester, list]) => ({ semester, courses: list }))
}

/**
 * 卡片近期任务 → 视图模型。
 *
 * `undefined` 表示**没查到这门课的任何任务**（"近期没有待办"语义，不当错误渲染）。
 * `[]` 也表示"没查到任务"（显式空数组）。
 *
 * 把这两种合并到 `[]` —— 旧版本用 `null` 表示"加载失败"、与 undefined 区分，
 * 但实际上：
 *   ① "加载失败"应**由调用方**显式判断 `tasksError` 后决定渲染分支，而不是依赖
 *      `undefined` 这个隐式信号（Map.get 不存在与查询失败在 JS 里**长得一样**）；
 *   ② 卡片只展示"这门课没有未完成的任务"，与"加载失败"是两种不同的状态，分开用 prop 传。
 */
export function toUpcomingViews(
  tasks: UpcomingTask[] | undefined,
  now: Date,
): UpcomingTaskView[] {
  const list = tasks ?? []
  return list.map((task) => {
    const { label, isOverdue } = formatDue(task.dueDate, now)
    // 卡片只显示"接下来要做的事"：Canvas 已判定完成（submitted/graded/pending_review）的不算逾期待催；
    // external_unconfirmed（外部平台提交，Canvas 无记录）也不该标红"已逾期"（我们不知道真没交）。
    const canvasCompleted =
      task.submissionState === 'submitted' ||
      task.submissionState === 'graded' ||
      task.submissionState === 'pending_review'
    const knownIncomplete = !canvasCompleted && task.submissionState !== 'external_unconfirmed'
    return {
      id: task.id,
      title: task.title,
      dueLabel: label,
      isOverdue: isOverdue && knownIncomplete,
      submissionState: task.submissionState,
    }
  })
}

/**
 * 取每门课**最新一份** syllabus。
 *
 * 只查一次（`in` + 按时间倒序）而不是每门课查一次，避免 N+1。
 * 一门课允许有多份（重新上传会新增一行），展示时取最新的那份。
 *
 * 返回的错误单独带出来：syllabus 是次要数据，它查失败不该让整个课程列表白屏，
 * 但也不能静默显示成"还没有 syllabus"（CodingRules 7）—— 所以降级成一条可见的提示。
 */
export async function loadLatestSyllabi(
  supabase: SupabaseServerClient,
  courseIds: string[],
): Promise<{ byCourse: Map<string, Syllabus>; error: string | null }> {
  const byCourse = new Map<string, Syllabus>()
  if (courseIds.length === 0) {
    return { byCourse, error: null }
  }

  const { data, error } = await supabase
    .from('syllabi')
    .select(SYLLABUS_COLUMNS)
    .in('course_id', courseIds)
    .order('uploaded_at', { ascending: false })

  if (error) {
    return { byCourse, error: error.message }
  }

  for (const row of (data ?? []) as SyllabusRow[]) {
    // 已按 uploaded_at 倒序，第一次出现的就是该课程最新一份。
    if (!byCourse.has(row.course_id)) {
      byCourse.set(row.course_id, toSyllabus(row))
    }
  }

  return { byCourse, error: null }
}
