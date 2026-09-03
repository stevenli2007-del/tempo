import { redirect } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { CourseCard } from '@/components/courses/course-card'
import { CourseCreatePanel } from '@/components/courses/course-create-panel'
import { signOut } from '@/lib/auth/actions'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { SYLLABUS_COLUMNS, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import { loadCourseSections } from '@/lib/sections'
import { createClient } from '@/lib/supabase/server'
import type { Course } from '@/types/course'
import type { StoredSections } from '@/types/sections'
import type { Syllabus } from '@/types/syllabus'

export const metadata = {
  title: '我的课程 · Tempo',
}

// 依赖用户 session，绝不能被静态预渲染。
// 虽然 createClient() 里的 cookies() 已能让 Next 识别为动态路由，
// 但这里显式声明，避免将来有人调整调用顺序时又退化成静态页。
export const dynamic = 'force-dynamic'

/**
 * 课程没有任何板块数据时的兜底（模块级常量，身份稳定）。
 *
 * `StoredSections` 的键全是可选的，空对象在这里是正确的 —— 表单会把每个板块当空数组渲染。
 */
const EMPTY_SECTIONS: StoredSections = {}

/** 按学期分组。Map 保持插入顺序，配合 SQL 的 created_at 升序，分组顺序稳定可预期。 */
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

  // 五板块（P0-1-6 编辑表单的初值）。契约没有「读板块」的端点，
  // 走服务组件直查 —— 与 loadLatestSyllabi 同一模式。
  const { byCourse: sectionsByCourse, error: sectionsError } = await loadCourseSections(
    supabase,
    courses.map((course) => course.id),
  )

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

        {sectionsError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">五板块内容加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              课程列表不受影响，但展开的板块会是空的 —— 此时保存会把板块清空，
              请刷新重试后再编辑。{sectionsError}
            </p>
          </div>
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
                  sections={sectionsByCourse.get(course.id) ?? EMPTY_SECTIONS}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}
