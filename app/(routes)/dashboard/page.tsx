import { redirect } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { CourseCard } from '@/components/courses/course-card'
import type { UpcomingTaskView } from '@/components/courses/course-card'
import { DemoControls } from '@/components/courses/demo-controls'
import { CourseCreatePanel } from '@/components/courses/course-create-panel'
import { DebtBar } from '@/components/overview/debt-bar'
import { WeekCalendar } from '@/components/overview/week-calendar'
import { SyncControls } from '@/components/sync/sync-controls'
import { SyncStatusBar } from '@/components/sync/sync-status-bar'
import { TokenExpiryBanner } from '@/components/sync/token-expiry-banner'
import { toCredentialExpiryView } from '@/lib/sync/expiry'
import { TaskList } from '@/components/tasks/task-list'
import type { TaskListItem } from '@/components/tasks/task-list'
import { AppShell } from '@/components/shell/app-shell'
import { signOut } from '@/lib/auth/actions'
import { loadCredentialMeta } from '@/lib/canvas/credentials'
import type { CanvasCredentialMeta } from '@/types/canvas'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { SYLLABUS_COLUMNS, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import { loadDebtTasks, loadTasks, loadUpcomingExams, loadUpcomingTasks } from '@/lib/tasks'
import {
  buildUpcomingExams,
  buildWeekCalendar,
  debtWindow,
  summarizeDebt,
} from '@/lib/tasks/progress'
import { SCHOOL_TIME_ZONE } from '@/lib/time'
import { createClient } from '@/lib/supabase/server'
import {
  recordUsageEvent,
  recordUsageEventOncePerUtcDay,
} from '@/lib/usage-events'
import {
  summarizeSyncStatus,
  toCourseSyncLine,
  toCourseSyncView,
} from '@/lib/sync/status'
import type { Course } from '@/types/course'
import type { Syllabus } from '@/types/syllabus'
import type { Task, UpcomingTask } from '@/types/task'

export const metadata = {
  title: '我的课程 · Tempo',
}

/** 总览页任务窗口（天）。与 `GET /api/v1/tasks` 的默认 range 一致。 */
const OVERVIEW_RANGE_DAYS = 7
/**
 * 总览页任务查询的 DB 安全上限 —— 只是"最多取回多少条"，**不是展示条数**。
 * 展示层收敛（最近 10 条待办 + 溢出收进 BOX）在 `TaskList` 里做（P0-3-6 的 `OVERVIEW_VISIBLE`），
 * 这里必须取回足够数据，BOX 展开后才能看到全部，不会静默消失。
 * Phase 0 任务量在几十条以内，50 是宽裕上限；真超过时列表仍只显示 10 + 一个溢出盒。
 */
const OVERVIEW_LIMIT = 50

/**
 * 「最近的考试」从数据库最多取回几条**候选**（不是展示条数，展示只取 3 条）。
 *
 * 取一批再在纯函数里筛掉已完成的、切前 3 —— 若 SQL 直接 `.limit(3)`，
 * 取回的三条可能恰好都被用户勾完了，条上就白白显示为空（而后面还有没完成的考试）。
 * 考试数量天生很少（一门课一学期 3-5 场），50 是宽裕上限。
 */
const EXAM_POOL = 50

/**
 * 日期标签用**学校本地时区**在服务端算好，避免 hydration mismatch（见下方 formatDue）。
 *
 * 🔴 P0-3-10 修复：原先硬编码 `timeZone: 'UTC'`，导致**晚上截止的 Canvas 作业几乎全部显示晚一天**
 * —— Canvas 的 `due_at` 带真实时区（如 `2026-09-09T23:59 PDT` = `2026-09-10T06:59Z`），
 * 按 UTC 取日期就印成 9/10，而用户在伯克利看到的是 9/9。考试派生任务恰因代码硬塞 `T23:59:59 UTC`
 * 才侥幸不出错（ADR-004 要跟 Canvas 对齐的本意就是按学校本地时间）。
 *
 * P0-3-7 起这个常量搬到 `lib/time.ts` —— 周历也要按学校日历日分桶，
 * 两处必须是同一个值（否则"同一条任务在列表和日历上差一天"）。
 */
const DUE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  timeZone: SCHOOL_TIME_ZONE,
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
function toUpcomingViews(tasks: UpcomingTask[] | undefined, now: Date): UpcomingTaskView[] {
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

function toListItems(tasks: Task[], now: Date): TaskListItem[] {
  return tasks.map((task) => {
    const { label, isOverdue } = formatDue(task.dueDate, now)
    // Canvas 已判定完成（submitted/graded/pending_review）→ 不再当"逾期待催"；
    // external_unconfirmed（外部平台，Canvas 无可信记录）→ 我们不知道真没交，也不标红。
    // 这两类都不算"已知未完成"，只有 status=pending 且非以上两者才标红（P0-3-10 的 isOverdue 连带修）。
    const canvasCompleted =
      task.submissionState === 'submitted' ||
      task.submissionState === 'graded' ||
      task.submissionState === 'pending_review'
    const knownIncomplete = !canvasCompleted && task.submissionState !== 'external_unconfirmed'
    return {
      id: task.id,
      courseId: task.courseId,
      courseName: task.courseName,
      title: task.title,
      dueLabel: label,
      isOverdue: isOverdue && task.status === 'pending' && knownIncomplete,
      status: task.status,
      isDerived: task.isDerived,
      submissionState: task.submissionState,
      submittedAt: task.submittedAt,
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

  // 埋点：打开总览页（P0-3-1 —— 7 日回访次数的分子）。
  // 「打开」= 服务端渲染一次页面，包括同步成功后的 router.refresh()：刷一次算一次。
  // 写失败不影响页面（函数内部只告警），埋点是度量不是功能。
  await recordUsageEvent(supabase, user.id, 'dashboard_view')

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
  /** 是否已有示例课程（决定展示「先看看效果」入口还是「清空示例数据」）。 */
  const hasDemo = courses.some((course) => course.isDemo)
  /**
   * 是否至少关联了一门 Canvas 课程 —— 同步控件（T1 自动同步 / T2 手动按钮）的开关。
   * 没关联过的用户同步注定空跑，不渲染按钮也不发自动请求（P0-2-6）。
   */
  const hasCanvasLink = courses.some((course) => course.canvasCourseId !== null)

  const { byCourse: syllabiByCourse, error: syllabusError } = await loadLatestSyllabi(
    supabase,
    courses.map((course) => course.id),
  )

  /**
   * 凭据状态（P0-2-7 失败分级 + P0-2-8 过期提醒共用）。
   *
   * P0-2-7 原本只在「有关联课」时才查，避免给没连 Canvas 的用户付一次无用查询。
   * P0-2-8 的过期提醒需要在**有凭据但还没关联课**时也显示 —— 所以改成：登录用户
   * 一律查一次（单行 `eq('user_id')`，成本可忽略），凭据不存在就是 null。
   *
   * 三态：可用 / 不可用 / 未知（查询失败）。查询失败时**不当成"没有凭据"** ——
   * 那会把失败误判成「需要重新连接」，给连着好 token 的用户派错活；
   * "未知"按暂时性故障处理，并显式报错（见下方 credentialError 分支）。
   */
  let credential: CanvasCredentialMeta | null = null
  let credentialUsable: boolean | null = null
  let credentialError: string | null = null
  // `now` 先算好，下面过期提醒（P0-2-8）要注入，避免与客户端各算一遍导致 hydration mismatch。
  const now = new Date()
  try {
    credential = await loadCredentialMeta(supabase, user.id)
    credentialUsable = credential !== null && credential.status === 'active'
  } catch (cause) {
    credentialError = cause instanceof Error ? cause.message : String(cause)
  }

  /**
   * 过期提醒（P0-2-8）：服务端现算，不轮询、不建端点（沿用 P0-2-7 决策）。
   * 凭据不存在 → null（不渲染）；`status === 'error'` 时 `toCredentialExpiryView`
   * 内部返回 null，让 P0-2-7 的失败横幅独占"连接坏了"的提示。
   */
  const expiryView =
    credential === null
      ? null
      : toCredentialExpiryView(credential.expiresAt, credential.status, now)

  // 埋点：过期横幅**真的展示给了用户**（P0-3-1 —— token 续期完成率的分母）。
  // 条件是横幅会出现（`level !== 'ok'`），而不是"用户点进了重连页" ——
  // 我们要量的是"提醒这个摩擦有没有促成续期"，看见提醒就算被触达。
  // 同一 UTC 日只记一次：分母按人算，同一天记五次只会把表撑大。
  if (expiryView !== null && expiryView.level !== 'ok') {
    await recordUsageEventOncePerUtcDay(supabase, user.id, 'expiry_reminder_shown', now)
  }

  /**
   * 重连入口：链到第一门关联课的详情页（那里有「Canvas 关联」区块，点「更改」→
   * 内嵌连接表单）。没有关联课则退而求其次链到第一门课详情页（任意课详情页都有连接入口）；
   * 连课都没有 → null（横幅只提示、不给按钮）。
   */
  const firstLinkedCourse = courses.find((course) => course.canvasCourseId !== null)
  const reconnectCourse = firstLinkedCourse ?? courses[0]
  const reconnectHref = reconnectCourse ? `/courses/${reconnectCourse.id}` : null

  // 四份任务数据互不依赖，并行发。课程 id 沿用上面已查到的未归档课程，不重复查。
  //
  // ① 卡片近期任务 / ② 总览清单（`overview.tasks`，同时喂周历）/ ③ 债务条 / ④ 最近的考试。
  // ② 和 ③ **口径不同、刻意不复用**：
  //    清单（和周历）要考试（syllabus 派生），债务条**必须排除考试** ——
  //    同一个页面上两个消费者对考试任务的态度相反，见 `lib/tasks/progress.ts` 文件头。
  // ④ 单独取是因为考试常落在 7 天窗口之外，② 的窗口装不下。
  const courseIds = courses.map((course) => course.id)
  const [
    { byCourse: upcomingByCourse, error: upcomingError },
    overview,
    debt,
    examPool,
  ] = await Promise.all([
    loadUpcomingTasks(supabase, courseIds),
    loadTasks(supabase, {
      courseIds,
      until: new Date(now.getTime() + OVERVIEW_RANGE_DAYS * 86_400_000).toISOString(),
      limit: OVERVIEW_LIMIT,
      offset: 0,
    }),
    loadDebtTasks(supabase, { courseIds, ...debtWindow(now) }),
    loadUpcomingExams(supabase, { courseIds, since: now.toISOString(), pool: EXAM_POOL }),
  ])
  const tasksError = upcomingError ?? overview.error

  // 口径与可视化模型都在纯函数层算（`lib/tasks/progress.ts`），这里只做接线。
  const debtSummary = summarizeDebt(debt.tasks, now)
  const calendar = buildWeekCalendar(overview.tasks, now)
  const exams = buildUpcomingExams(examPool.tasks, now)

  // 同步状态视图：只算**已关联 Canvas** 的课（未关联的课没有"同步"这回事）。
  const syncViews = courses
    .filter((course) => course.canvasCourseId !== null)
    .map((course) => toCourseSyncView(course, { credentialUsable: credentialUsable === true }))
  const syncOverview = summarizeSyncStatus(syncViews, now)
  const syncLines = new Map(
    syncViews.map((view) => [view.courseId, toCourseSyncLine(view, now)] as const),
  )

  return (
    <AppShell title="课程面板">
      <div className="mx-auto max-w-[1100px] space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">我的课程</h1>
            <p className="mt-2 text-sm text-ink-muted">
              先建课程，再上传 syllabus —— Tempo 会帮你把里面的考试、评分和日程抽出来。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SyncControls hasCanvasLink={hasCanvasLink} />
            <CourseCreatePanel />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-ink-muted">{email}</span>
          {hasDemo ? <DemoControls hasDemo={hasDemo} variant="inline" /> : null}
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              登出
            </Button>
          </form>
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

        {credentialError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">Canvas 连接状态加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              同步状态可能不准（失败原因会按「暂时性故障」处理）。{credentialError}
            </p>
          </div>
        ) : null}

        <TokenExpiryBanner view={expiryView} reconnectHref={reconnectHref} />

        <SyncStatusBar overview={syncOverview} now={now} />

        {/* 欠账统计失败时**藏起卡片而不是显示成空** —— 一个全空的条形图会被读成
            "没有欠账"，那正是静默的错误数据（CodingRules 7）。 */}
        {!error && courses.length > 0 && debt.error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">欠账统计加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              下面的日历与清单不受影响，但「已到期作业」卡片暂时不显示。{debt.error}
            </p>
          </div>
        ) : null}

        {/* 债务条只统计 Canvas 作业 —— 一门 Canvas 课都没关联时它永远是空的，
            显示一个空的"没有欠账"只会让人困惑（P0-2-6 的 hasCanvasLink 同源判断）。 */}
        {!error && courses.length > 0 && hasCanvasLink && !debt.error ? (
          <DebtBar summary={debtSummary} />
        ) : null}

        {!error && courses.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">接下来 7 天</h2>
              <p className="text-xs text-muted-foreground">作业与考试混排 · 点一条跳到课程</p>
            </div>
            <WeekCalendar model={calendar} exams={exams} />
            {/* 考试查询失败时**明说** —— 否则日历会静静地少一条「最近的考试」，
                用户只会以为"我最近没考试"（CodingRules 7：空数据比错误数据更危险）。 */}
            {examPool.error ? (
              <p role="alert" className="text-xs text-destructive">
                「最近的考试」加载失败，考试信息可能不完整：{examPool.error}
              </p>
            ) : null}
            {overview.total > overview.tasks.length ? (
              <p className="text-xs text-ink-faint">
                任务较多，日历只排了取回的 {overview.tasks.length} 条；其余在下方清单里。
              </p>
            ) : null}
          </section>
        ) : null}

        {!error && courses.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">待办清单</h2>
              <p className="text-xs text-muted-foreground">
                {OVERVIEW_RANGE_DAYS} 天内到期 · 已逾期的也在里面 · 勾完成在这里
              </p>
            </div>
            <TaskList items={toListItems(overview.tasks, now)} />
          </section>
        ) : null}

        {!error && courses.length === 0 ? (
          <DemoControls hasDemo={hasDemo} variant="cta" />
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
                  // 卡片分支不再用「undefined → null」隐式判定加载失败：
                  // Map.get() 不存在（这门课没任务）与查询错误是两种不同状态，
                  // 全部转成「空数组」让卡片显示「近期没有待办」；
                  // 真正的加载失败由 `loadError`（来自 tasksError）显式控制。
                  upcomingTasks={toUpcomingViews(upcomingByCourse.get(course.id), now)}
                  loadError={tasksError}
                  // 未关联的课查不到 view → undefined → 卡片不渲染同步行。
                  syncLine={syncLines.get(course.id) ?? null}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  )
}
