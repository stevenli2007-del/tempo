import { redirect } from 'next/navigation'

import { CourseCard } from '@/components/courses/course-card'
import { CourseCreatePanel } from '@/components/courses/course-create-panel'
import { DemoControls } from '@/components/courses/demo-controls'
import { AppShell } from '@/components/shell/app-shell'
import { loadCredentialMeta } from '@/lib/canvas/credentials'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { groupBySemester, loadLatestSyllabi, toUpcomingViews } from '@/lib/courses/course-list'
import { createClient } from '@/lib/supabase/server'
import { toCourseSyncLine, toCourseSyncView } from '@/lib/sync/status'
import { loadUpcomingTasks } from '@/lib/tasks'
import type { CanvasCredentialMeta } from '@/types/canvas'

export const metadata = {
  title: '我的课程 · Tempo',
}

// 依赖用户 session，绝不能被静态预渲染（同 /dashboard）。
export const dynamic = 'force-dynamic'

/**
 * 课程列表页（P0-3-7b 从 dashboard 拆出）。
 *
 * **为什么要有这一页**：dashboard 的 `<h1>` 原写着「我的课程」，可主体是任务视图
 * （已到期作业 / 周历 / 待办清单），13 张课程卡被挤到**页面最底部垫底** ——
 * 标题和内容说的不是一件事，而且看一门课要滚过整个任务区。
 *
 * 拆开之后两个页面的问题各自纯粹：
 *   - `/dashboard` 只回答「接下来要做什么」（任务视图）
 *   - `/courses`   只回答「我有哪些课」（资产视图）
 *
 * 📌 卡片的数据构造（`formatDue` / `toUpcomingViews` / `loadLatestSyllabi`）在
 * `lib/courses/course-list.ts` 与 `lib/tasks/format.ts`，**与 dashboard 共用同一份**。
 */
export default async function CoursesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware，Next 16 更名）已经拦过一道，这里再兜一次底。
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
  const hasDemo = courses.some((course) => course.isDemo)

  // `now` 服务端算一次注入纯函数，避免与客户端各算一遍导致 hydration mismatch。
  const now = new Date()
  const courseIds = courses.map((course) => course.id)

  // 两路并行：syllabus 状态 + 卡片近期任务。互不依赖。
  const [{ byCourse: syllabiByCourse, error: syllabusError }, upcoming] = await Promise.all([
    loadLatestSyllabi(supabase, courseIds),
    loadUpcomingTasks(supabase, courseIds),
  ])
  const upcomingByCourse = upcoming.byCourse
  const tasksError = upcoming.error

  /**
   * 凭据状态 —— 只用来给卡片上的同步状态行定档（P0-2-7）。
   *
   * 三态：可用 / 不可用 / 未知（查询失败）。查询失败时**不当成"没有凭据"** ——
   * 那会把失败误判成「需要重新连接」，给连着好 token 的用户派错活。
   */
  let credential: CanvasCredentialMeta | null = null
  let credentialUsable: boolean | null = null
  let credentialError: string | null = null
  try {
    credential = await loadCredentialMeta(supabase, user.id)
    credentialUsable = credential !== null && credential.status === 'active'
  } catch (cause) {
    credentialError = cause instanceof Error ? cause.message : String(cause)
  }

  // 同步状态行：只算**已关联 Canvas** 的课（未关联的课没有"同步"这回事）。
  const syncLines = new Map(
    courses
      .filter((course) => course.canvasCourseId !== null)
      .map((course) => {
        const view = toCourseSyncView(course, { credentialUsable: credentialUsable === true })
        return [course.id, toCourseSyncLine(view, now)] as const
      }),
  )

  return (
    <AppShell title="我的课程">
      <div className="mx-auto max-w-[1100px] space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">我的课程</h1>
            <p className="mt-2 text-sm text-ink-muted">
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
              课程与 syllabus 不受影响，但卡片上的「近期任务」可能不完整。{tasksError}
            </p>
          </div>
        ) : null}

        {/* 凭据查询失败时明说 —— 否则卡片上的同步状态行会按"暂时性故障"显示，
            用户不知道那可能是失败态而非真实状态（CodingRules 7）。 */}
        {credentialError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">Canvas 连接状态加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              卡片上的同步状态可能不准（失败原因会按「暂时性故障」处理）。{credentialError}
            </p>
          </div>
        ) : null}

        {!error && courses.length === 0 ? <DemoControls hasDemo={hasDemo} variant="cta" /> : null}

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
