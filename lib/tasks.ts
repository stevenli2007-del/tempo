import { createClient } from '@/lib/supabase/server'
import type {
  Task,
  TaskCandidate,
  TaskSource,
  TaskStatus,
  TaskSubmissionState,
  TaskType,
  UpcomingTask,
} from '@/types/task'

/**
 * tasks 表的读取（P0-1-9，总览页数据源）。
 *
 * ### 只在这里知道数据库列名
 * 与 `lib/courses.ts` / `lib/sections.ts` 同一条约定：snake_case ↔ camelCase 的映射
 * 只有这一处，其余代码一律用 camelCase 的 `Task`。
 *
 * ### 任务归属怎么判定（重要）
 * `tasks` 表**没有 `user_id` 列**，RLS 策略 `tasks_via_course_all` 是经 `courses.user_id`
 * 判定的（迁移 `20260902100000`）。因此所有 tasks 查询都必须先拿到「当前用户的课程 id 集合」，
 * 再用 `.in('course_id', …)` 收口 —— 光靠 `.eq('id', …)` 查单条是**不够**的：
 * 归档课程的行 RLS 仍会放行（策略不看 `is_archived`），
 * 而契约 §2 的 DELETE 语义是「归档后该课程任务从总览页隐藏」。
 *
 * ### 归档过滤
 * 统一走 `loadActiveCourseIds()`（只取 `is_archived = false`），
 * 保证总览页、卡片近期任务、PATCH 三条路径的可见性规则一致。
 */

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** tasks 表在数据库中的行（snake_case，与 Database.md §3.9 一致）。 */
export type TaskRow = {
  id: string
  course_id: string
  title: string
  due_date: string | null
  task_type: string
  source: string
  status: string
  is_derived: boolean
  submission_state: string | null
  submitted_at: string | null
}

/** 列表与单条查询统一用这份 select，避免各处字段不齐导致形状漂移。 */
export const TASK_COLUMNS =
  'id, course_id, title, due_date, task_type, source, status, is_derived, submission_state, submitted_at'

const TASK_TYPES = new Set<string>(['assignment', 'exam', 'reading', 'other'])
const TASK_SOURCES = new Set<string>(['canvas', 'syllabus', 'manual'])
const TASK_STATUSES = new Set<string>(['pending', 'done'])
const TASK_SUBMISSION_STATES = new Set<string>([
  'unsubmitted',
  'submitted',
  'pending_review',
  'graded',
  'missing',
  'external_unconfirmed',
])

/**
 * 收窄枚举列。
 *
 * 数据库有 CHECK 约束保证取值闭合，正常永远走不到 throw。这里选择抛错而不是给个
 * 兜底值 —— 编一个 task_type / status 出来就是静默的错误数据（CodingRules 7），
 * 而 status 会直接决定"这条任务算不算做完了"。
 */
function toEnum<T extends string>(value: string, allowed: Set<string>, column: string): T {
  if (!allowed.has(value)) {
    throw new Error(`tasks.${column} 出现约束外的取值: ${value}`)
  }
  return value as T
}

/** `courseName` 来自 courses 表，不是 tasks 自己的列，所以由调用方传入。 */
export function toTask(row: TaskRow, courseName: string): Task {
  return {
    id: row.id,
    courseId: row.course_id,
    courseName,
    title: row.title,
    dueDate: row.due_date,
    taskType: toEnum<TaskType>(row.task_type, TASK_TYPES, 'task_type'),
    source: toEnum<TaskSource>(row.source, TASK_SOURCES, 'source'),
    status: toEnum<TaskStatus>(row.status, TASK_STATUSES, 'status'),
    isDerived: row.is_derived,
    submissionState: row.submission_state === null ? null : toEnum<TaskSubmissionState>(row.submission_state, TASK_SUBMISSION_STATES, 'submission_state'),
    submittedAt: row.submitted_at,
  }
}

// ---------- 基础查询 ----------

/** 当前用户**未归档**的课程 id。tasks 的可见性全部收口在这里。 */
export async function loadActiveCourseIds(
  supabase: ServerSupabase,
): Promise<{ ids: string[]; error: string | null }> {
  const { data, error } = await supabase.from('courses').select('id').eq('is_archived', false)
  if (error) {
    return { ids: [], error: error.message }
  }
  return { ids: ((data ?? []) as { id: string }[]).map((row) => row.id), error: null }
}

/** 课程 id → 课程名。tasks 表没有课程名，展示层又必须显示它。 */
async function loadCourseNames(
  supabase: ServerSupabase,
  courseIds: string[],
): Promise<{ names: Map<string, string>; error: string | null }> {
  const names = new Map<string, string>()
  if (courseIds.length === 0) {
    return { names, error: null }
  }
  const { data, error } = await supabase
    .from('courses')
    .select('id, course_name')
    .in('id', courseIds)
  if (error) {
    return { names, error: error.message }
  }
  for (const row of (data ?? []) as { id: string; course_name: string }[]) {
    names.set(row.id, row.course_name)
  }
  return { names, error: null }
}

// ---------- 总览任务列表 ----------

/**
 * `GET /api/v1/tasks` 的读逻辑。
 *
 * ### 时间范围只设上界，不设下界（这是个产品判断）
 * `range=7d` 的含义是「7 天内到期的 + **所有逾期未完成的**」。
 * 逾期未完成任务是总览页最重要的信号，按字面理解成"未来 7 天"会把它们藏起来，
 * 等于帮用户逃避 —— 与 Tempo「不隐藏问题」的原则冲突。
 * `until = null`（range=all）时不加任何时间过滤。
 *
 * ### `dueDate` 为 null 的行必须保留
 * 光写 `.lte('due_date', until)` 在 SQL 里对 NULL 求值结果是 NULL（不成立），
 * null 行会被整批排除掉。必须显式 `or` 一个 `due_date.is.null`。
 */
export async function loadTasks(
  supabase: ServerSupabase,
  options: {
    courseIds: string[]
    /** 时间上界（ISO 串）；null = 不限。 */
    until: string | null
    limit: number
    offset: number
  },
): Promise<{ tasks: Task[]; total: number; error: string | null }> {
  const { courseIds, until, limit, offset } = options
  if (courseIds.length === 0) {
    return { tasks: [], total: 0, error: null }
  }

  const { names, error: nameError } = await loadCourseNames(supabase, courseIds)
  if (nameError) {
    return { tasks: [], total: 0, error: nameError }
  }

  let query = supabase
    .from('tasks')
    .select(TASK_COLUMNS, { count: 'exact' })
    .in('course_id', courseIds)
    .eq('is_deleted', false)

  if (until !== null) {
    // 值含 `:` 与 `+`，用双引号包住，避免被 PostgREST 的 or 语法吃掉。
    query = query.or(`due_date.lte."${until}",due_date.is.null`)
  }

  // 排序（契约 §5）：dueDate 升序、**null 排最后**；二级用 created_at 稳定同日顺序，
  // 否则翻页时行序会漂。这两行在两个查询里各写一份 —— 抽成公共函数会让
  // PostgrestFilterBuilder 的泛型推导炸掉（TS2589）。
  const { data, error, count } = await query
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) {
    return { tasks: [], total: 0, error: error.message }
  }

  // 换行失败整体降级（CodingRules 7）：坏一行的 shape 会让前端拿到的列表少一项，
  // 用户无从判断"是本来就没有，还是加载失败"。
  try {
    const tasks = ((data ?? []) as TaskRow[]).map((row) => toTask(row, names.get(row.course_id) ?? ''))
    return { tasks, total: count ?? 0, error: null }
  } catch (error) {
    return { tasks: [], total: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------- 债务条取数（P0-3-7a） ----------

/**
 * `summarizeDebt()`（`lib/tasks/progress.ts`）的取数：**只取 `source = 'canvas'` 且已过期的任务**。
 *
 * ### 为什么不复用 `loadTasks()`
 * 债务条口径是「近 30 天已到期」，需要**下界**；而 `loadTasks` 刻意只有上界。
 * 给它加参数会牵动公开契约 `GET /api/v1/tasks`（`range` 的语义就是"只设上界"，契约 §5），
 * 而且它用 `or(due_date.lte.X, due_date.is.null)` 保住 TBD 行 —— 再叠一个 `.gte('due_date')`
 * 会让 NULL 行**整批消失**（`CodingRules.md` §10.2「`.lte()` 吃掉 NULL 行」的同类坑，
 * 换成 `.gte` 一样踩）。所以另开一个只服务总览页的聚合读取，两边互不牵制。
 *
 * ### 🔴 `.eq('source', 'canvas')` 必须写在这里，不能交给调用方
 * 同一页面上两个消费者对「考试任务」态度**相反**：周历要显示考试，债务条必须排除考试。
 * 过滤写在 SQL 里，就不会出现"下一个人重构取数时顺手统一了，考试被算进欠账"。
 */
export async function loadDebtTasks(
  supabase: ServerSupabase,
  options: {
    courseIds: string[]
    /** 时间下界（ISO 串）—— 债务条窗口的左沿。 */
    since: string
    /** 时间上界（ISO 串）—— 通常是 now，只取已到期的。 */
    until: string
  },
): Promise<{ tasks: Task[]; error: string | null }> {
  const { courseIds, since, until } = options
  if (courseIds.length === 0) {
    return { tasks: [], error: null }
  }

  const { names, error: nameError } = await loadCourseNames(supabase, courseIds)
  if (nameError) {
    return { tasks: [], error: nameError }
  }

  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_COLUMNS)
    .in('course_id', courseIds)
    .eq('is_deleted', false)
    .eq('source', 'canvas')
    .not('due_date', 'is', null)
    .gte('due_date', since)
    .lte('due_date', until)

  if (error) {
    return { tasks: [], error: error.message }
  }

  try {
    const tasks = ((data ?? []) as TaskRow[]).map((row) => toTask(row, names.get(row.course_id) ?? ''))
    return { tasks, error: null }
  } catch (error) {
    return { tasks: [], error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------- 最近的考试（P0-3-7b 补） ----------

/**
 * 「最近的考试」条的取数：**已到期的排除、已完成的不排**（后者在纯函数里筛）。
 *
 * ### 为什么单独一条查询，而不是从 `overview.tasks` 里挑
 * `overview.tasks` 的窗口是 `now + 7d`，而 7 天滚动窗口对考试**完全不够** ——
 * 2026-09-13 实测：Steven 的 4 场考试全在 7 天之外（最近的 9/22）。只看周历的话，
 * 日历里一场考试都看不到。
 *
 * ### 为什么 SQL 里先取一批、再在纯函数里切前 3
 * 想把"已完成"过滤掉才能知道真正要显示哪几条。若 SQL 直接 `.limit(3)`，
 * 取回的三条可能恰好都被用户勾完了 → 条上显示为空，而其实后面还有未完成的考试。
 */
export async function loadUpcomingExams(
  supabase: ServerSupabase,
  options: { courseIds: string[]; since: string; pool: number },
): Promise<{ tasks: Task[]; error: string | null }> {
  const { courseIds, since, pool } = options
  if (courseIds.length === 0) {
    return { tasks: [], error: null }
  }

  const { names, error: nameError } = await loadCourseNames(supabase, courseIds)
  if (nameError) {
    return { tasks: [], error: nameError }
  }

  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_COLUMNS)
    .in('course_id', courseIds)
    .eq('is_deleted', false)
    .eq('task_type', 'exam')
    // `gte` 顺带排掉 due_date 为 NULL 的 TBD 考试 —— 它们该出现在周历底部的
    // 「日期待定」行，而不是这里（那里按课程分组，一眼能看出是哪门课还没定日子）。
    .gte('due_date', since)
    .order('due_date', { ascending: true })
    .limit(pool)

  if (error) {
    return { tasks: [], error: error.message }
  }

  try {
    const tasks = ((data ?? []) as TaskRow[]).map((row) => toTask(row, names.get(row.course_id) ?? ''))
    return { tasks, error: null }
  } catch (error) {
    return { tasks: [], error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------- 卡片近期任务 ----------

/**
 * 每门课最多 `perCourse` 条**未完成**任务（契约 §2 的 `upcomingTasks`）。
 *
 * 一次查全部（课程数是几个到十几个，任务量在几百以内），再在内存里按课程取前 N 条 ——
 * 比每门课查一次少 N 次往返。
 *
 * 不设时间上界：一门课只有一两个考试任务时，卡片显示"近期 1-2 个"就该把它显示出来，
 * 哪怕在 7 天窗口之外 —— 硬卡窗口会让"这门课明明有考试，卡片却空着"。
 */
export async function loadUpcomingTasks(
  supabase: ServerSupabase,
  courseIds: string[],
  perCourse = 2,
): Promise<{ byCourse: Map<string, UpcomingTask[]>; error: string | null }> {
  const byCourse = new Map<string, UpcomingTask[]>()
  if (courseIds.length === 0) {
    return { byCourse, error: null }
  }

  const { data, error } = await supabase
    .from('tasks')
    .select('id, course_id, title, due_date, submission_state')
    .in('course_id', courseIds)
    .eq('is_deleted', false)
    .eq('status', 'pending')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) {
    return { byCourse, error: error.message }
  }

  // 已按 due_date 升序（null 最后），顺序追加即为「最近的在前」。
  for (const row of (data ?? []) as {
    id: string
    course_id: string
    title: string
    due_date: string | null
    submission_state: string | null
  }[]) {
    const list = byCourse.get(row.course_id)
    if (list) {
      if (list.length >= perCourse) continue
      list.push({ id: row.id, title: row.title, dueDate: row.due_date, submissionState: row.submission_state as TaskSubmissionState | null })
    } else {
      byCourse.set(row.course_id, [{ id: row.id, title: row.title, dueDate: row.due_date, submissionState: row.submission_state as TaskSubmissionState | null }])
    }
  }

  return { byCourse, error: null }
}

// ---------- 单条（PATCH 用） ----------

/**
 * 按 id 取一条任务，**并确认它所在的课程未归档**。
 *
 * 返回 `null` 表示：不存在 / 不属于当前用户 / 课程已归档 —— 三种情况对外都是 404
 * （ADR-010：统一 404，不区分存在性与越权，避免为区分而用 service role 探测）。
 */
export async function loadTaskById(
  supabase: ServerSupabase,
  taskId: string,
): Promise<{ task: Task | null; error: string | null }> {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('id', taskId)
    .eq('is_deleted', false)
    .maybeSingle()

  if (error) {
    return { task: null, error: error.message }
  }
  if (!data) {
    return { task: null, error: null }
  }

  const row = data as TaskRow
  const course = await supabase
    .from('courses')
    .select('course_name')
    .eq('id', row.course_id)
    .eq('is_archived', false)
    .maybeSingle()

  if (course.error) {
    return { task: null, error: course.error.message }
  }
  // 查不到课程 = 别人的课（RLS 过滤）或已归档，两种都当不存在。
  if (!course.data) {
    return { task: null, error: null }
  }

  try {
    const courseName = (course.data as { course_name: string }).course_name
    return { task: toTask(row, courseName), error: null }
  } catch (error) {
    return { task: null, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------- 单课候选（P0-3-8b 检索） ----------

/**
 * 某门课的候选任务（P0-3-8b「用户输入 → 先检索现有任务」的数据源）。
 *
 * ### 为什么不复用 `loadTasks()`
 * `GET /api/v1/tasks` 是**总览页口径**：跨课程合并、只设时间上界、分页。
 * 而检索要回答的是「**这门课**里有没有叫 HW7 的任务」—— 需要**该课全部的未删任务**，
 * 不分时间窗（一场考试/作业可能在一年后），且只要轻量字段（不要 status 等展示态）。
 * 给 `loadTasks` 加参数会牵动公开契约 `range` 的语义，所以另开一条。
 *
 * ### 🔴 调用方必须先做课程归属校验
 * 这里只 `.eq('course_id', …)`。`tasks` 的 RLS 经 `courses.user_id` 判定、
 * **不看 `is_archived`**，所以归档课程的行仍会被放行 —— 调用方（`/tasks/search`）
 * 必须先 `loadActiveCourseIds()` 确认该 courseId 属于当前用户的未归档课程。
 */
export async function loadTasksByCourse(
  supabase: ServerSupabase,
  courseId: string,
): Promise<{ candidates: TaskCandidate[]; error: string | null }> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, due_date, task_type, source, is_derived')
    .eq('course_id', courseId)
    .eq('is_deleted', false)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) {
    return { candidates: [], error: error.message }
  }

  try {
    const candidates = (
      (data ?? []) as {
        id: string
        title: string
        due_date: string | null
        task_type: string
        source: string
        is_derived: boolean
      }[]
    ).map((row) => ({
      id: row.id,
      title: row.title,
      dueDate: row.due_date,
      taskType: toEnum<TaskType>(row.task_type, TASK_TYPES, 'task_type'),
      source: toEnum<TaskSource>(row.source, TASK_SOURCES, 'source'),
      isDerived: row.is_derived,
    }))
    return { candidates, error: null }
  } catch (error) {
    return { candidates: [], error: error instanceof Error ? error.message : String(error) }
  }
}
