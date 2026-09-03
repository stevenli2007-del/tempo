import { redirect } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { CourseCard } from '@/components/courses/course-card'
import type { UpcomingTaskView } from '@/components/courses/course-card'
import { CourseCreatePanel } from '@/components/courses/course-create-panel'
import { TaskList } from '@/components/tasks/task-list'
import type { TaskListItem } from '@/components/tasks/task-list'
import { signOut } from '@/lib/auth/actions'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { SYLLABUS_COLUMNS, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import { loadTasks, loadUpcomingTasks } from '@/lib/tasks'
import { createClient } from '@/lib/supabase/server'
import type { Course } from '@/types/course'
import type { Syllabus } from '@/types/syllabus'
import type { Task, UpcomingTask } from '@/types/task'

export const metadata = {
  title: '我的课程 · Tempo',
}

/** 总览页任务窗口（天）。与 `GET /api/v1/tasks` 的默认 range 一致。 */
const OVERVIEW_RANGE_DAYS = 7
/** 一次最多展示多少条。Phase 0 任务量在几十条以内，不做分页 UI。 */
const OVERVIEW_LIMIT = 50

/**
 * 日期标签用固定时区（UTC）在**服务端**算好。
 *
 * 若把 ISO 串交给客户端组件用 `toLocaleDateString()` 渲染，服务端（UTC）与浏览器
 * （用户本地时区）会得出不同结果 → hydration mismatch。
 * 代价：处在 UTC-7 的用户看到的日期边界会与本地时间差至多几小时。
 * Phase 0 接受 —— 考试派生时间统一是当日 23:59:59 UTC，按 UTC 取日期不会出现"差一天"。
 */
const DUE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  timeZone: 'UTC',
})

function formatDue(
  iso: string | null,
  now: Date,
): { label: string | null; isOverdue: boolean } {
  if (iso === null) {
    // null = 未知日期（考试 TBD）。返回 null 让展示层渲染成「日期待定」，
    // 不编一个假日期出来（Database.md 3.9）。
    return { label: null, isOverdue: false }
  }
  const due = new Date(iso)
  if (Number.isNaN(due.getTime())) {
    return { label: null, isOverdue: false }
  }
  return { label: DUE_FORMATTER.format(due), isOverdue: due.getTime() < now.getTime() }
}

/** 卡片近期任务 → 视图模型。`undefined`（没查到）与 `[]`（确实没有）要保持区分。 */
function toUpcomingViews(
  tasks: UpcomingTask[] | undefined,
  now: Date,
): UpcomingTaskView[] | null {
  if (!tasks) {
    return null
  }
  return tasks.map((task) => {
    const { label, isOverdue } = formatDue(task.dueDate, now)
    return { id: task.id, title: task.title, dueLabel: label, isOverdue }
  })
}

function toListItems(tasks: Task[], now: Date): TaskListItem[] {
  return tasks.map((task) => {
    const { label, isOverdue } = formatDue(task.dueDate, now)
    return {
      id: task.id,
      courseId: task.courseId,
      courseName: task.courseName,
      title: task.title,
      dueLabel: label,
      // 已完成的不标逾期：它已经是历史，不需要"催"。
      isOverdue: isOverdue && task.status === 'pending',
      status: task.status,
      isDerived: task.isDerived,
    }
  })
}

// 依赖用户 session，绝不能被静态预渲染。
// 虽然 createClient() 里的 cookies() 已能让 Next 识别为动态路由，
// 但这里显式声明，避免将来有人调整调用顺序时又退化成静态页。
export const dynamic = 'force-dynamic'

/**
 * 按学期分组。Map 保持插入顺序，配合 SQL 的 created_at 升序，分组顺序稳定可预期。
 */
function groupBySemester(courses: Course[]): { semester: string; courses: Course[] }[] {
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
 * 取每门课**最新一份** syllabus。
 *
 * 只查一次（`in` + 按时间倒序）而不是每门课查一次，避免 N+1。
 * 一门课允许有多份（重新上传会新增一行），展示时取最新的那份。
 *
 * 返回的错误单独带出来：syllabus 是次要数据，它查失败不该让整个课程列表白屏，
 * 但也不能静默显示成"还没有 syllabus"（CodingRules 7）—— 所以降级成一条可见的提示。
 */
async function loadLatestSyllabi(
  supabase: Awaited<ReturnType<typeof createClient>>,
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

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware，Next 16 更名）已经拦过一道，这里再兜一次底：
  // 既防 proxy 被人绕过，也让 TS 知道 user 一定存在。
  if (!user) {
    redirect('/login')
  }

  const { data, error } = await supabase
    .from('courses')
    .select(COURSE_COLUMNS)
    .eq('is_archived', false)
    .order('created_at', { ascending: true })

  // 查询失败必须让用户看见，不能因为 error 分支返回空数组就渲染成"还没有课程"。
  // 静默的旧数据/空数据比明确的错误更危险（CodingRules 7、PRD F4 失败可见性）。
  const courses = data ? (data as CourseRow[]).map(toCourse) : []
  const groups = groupBySemester(courses)
  const email = user.email ?? '（未设置邮箱）'

  const { byCourse: syllabiByCourse, error: syllabusError } = await loadLatestSyllabi(
    supabase,
    courses.map((course) => course.id),
  )

  // 任务数据：总览列表 + 卡片近期任务。两者互不依赖，并行发。
  // 课程 id 沿用上面已查到的未归档课程，不再单独查一次。
  const now = new Date()
  const courseIds = courses.map((course) => course.id)
  const [{ byCourse: upcomingByCourse, error: upcomingError }, overview] = await Promise.all([
    loadUpcomingTasks(supabase, courseIds),
    loadTasks(supabase, {
      courseIds,
      until: new Date(now.getTime() + OVERVIEW_RANGE_DAYS * 86_400_000).toISOString(),
      limit: OVERVIEW_LIMIT,
      offset: 0,
    }),
  ])
  const tasksError = upcomingError ?? overview.error

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold">Tempo</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{email}</span>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                登出
              </Button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">我的课程</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              先建课程，再上传 syllabus —— Tempo 会帮你把里面的考试、评分和日程抽出来。
            </p>
          </div>
          <CourseCreatePanel />
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">课程列表加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
          </div>
        ) : null}

        {syllabusError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">Syllabus 信息加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              课程列表不受影响，但上传状态可能显示不准。{syllabusError}
            </p>
          </div>
        ) : null}

        {tasksError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">任务列表加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              课程与 syllabus 不受影响，但下面的近期任务可能不完整。{tasksError}
            </p>
          </div>
        ) : null}

        {!error && courses.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">最近要做的事</h2>
              <p className="text-xs text-muted-foreground">
                {OVERVIEW_RANGE_DAYS} 天内到期 · 已逾期的也会留在这里
              </p>
            </div>
            <TaskList items={toListItems(overview.tasks, now)} />
            {overview.total > overview.tasks.length ? (
              <p className="text-xs text-muted-foreground">
                还有 {overview.total - overview.tasks.length} 条没显示（一次最多 {OVERVIEW_LIMIT} 条）
              </p>
            ) : null}
          </section>
        ) : null}

        {!error && courses.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="text-sm text-muted-foreground">
              还没有课程。点右上角「新建课程」，从一门课开始。
            </p>
          </div>
        ) : null}

        {groups.map((group) => (
          <section key={group.semester} className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">{group.semester}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.courses.map((course) => (
                <CourseCard
                  key={course.id}
                  course={course}
                  syllabus={syllabiByCourse.get(course.id) ?? null}
                  upcomingTasks={toUpcomingViews(
                    // 任务查询失败时 byCourse 是空 Map，get 出来是 undefined → 传 null
                    // → 卡片显示「加载失败」而不是「近期没有待办」。
                    tasksError ? undefined : upcomingByCourse.get(course.id),
                    now,
                  )}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}
