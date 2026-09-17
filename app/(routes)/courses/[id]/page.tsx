import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AssignmentDetail } from '@/components/courses/assignment-detail'
import { CanvasLink } from '@/components/courses/canvas-link'
import { CourseActions } from '@/components/courses/course-actions'
import { GradePie } from '@/components/courses/grade-pie'
import { SyllabusUpload } from '@/components/courses/syllabus-upload'
import { SectionEditor } from '@/components/sections/section-editor'
import { AppShell } from '@/components/shell/app-shell'
import { UUID_PATTERN } from '@/lib/api/params'
import { loadCredentialMeta } from '@/lib/canvas/credentials'
import { loadCourseDetail } from '@/lib/course-detail'
import { createClient } from '@/lib/supabase/server'
import { loadTasks } from '@/lib/tasks'

/**
 * 课程详情页（P0-1-8 建，P0-3-17 重排）。
 *
 * 一门课的全部操作都在这里：syllabus 上传 + 解析、五板块查看 / 编辑、课程信息编辑、归档删除。
 * 读逻辑在 `lib/course-detail.ts`，与 `GET /api/v1/courses/:id` 共用一份 ——
 * 页面直查 DB（RLS 保护），不 fetch 自己的 API（省一次往返）。
 *
 * ### P0-3-17 的重排（原先是"单列 max-w-3xl 一路往下堆"）
 * 旧版把 `Canvas 关联 → 五个板块` 竖着摞成一条长条，**打开就得滚**，
 * 而"这门课现在什么状况"（构成、作业、分数）反而要滚到底或根本看不到。
 * 新顺序按**问题**排，而不是按数据表排：
 *   概览（Canvas 关联 / 成绩构成 / 作业概况，宽屏三栏一屏看完）
 *   → 作业详情（**折叠**，含分数条与 Canvas 外链）
 *   → 资料（Phase 1 占位）
 *   → 课程板块（原来的五板块编辑器，含 syllabus 上传）
 *
 * ### 作业数据为什么单独取，而不塞进 `loadCourseDetail`
 * `loadCourseDetail` 同时被 `GET /api/v1/courses/:id` 使用 —— 往里加 tasks 等于
 * **改对外契约的响应形状**（那个端点的消费者是前端与将来的第三方）。
 * 页面自己调 `loadTasks({ until: null })`（不限时间上界：详情页要的是**全部**作业，
 * 不是 7 天窗口），契约一动不动。
 *
 * 约定：**列表页在 `/dashboard`**（不新增 `/courses` 列表路由），详情页挂在 `/courses/[id]`。
 */

export const metadata = {
  title: '课程详情 · Tempo',
}

// 依赖用户 session，绝不能被静态预渲染。
export const dynamic = 'force-dynamic'

/**
 * 详情页一次最多取回多少条作业。
 * 只用来兜住极端数据（PostgREST 单次响应），**不是展示上限** ——
 * Phase 0 实测一门课最多 25 条，200 是宽裕上限。
 */
const COURSE_TASK_LIMIT = 200

interface PageProps {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>
}

export default async function CourseDetailPage({ params }: PageProps) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware，Next 16 更名）已拦过一道，这里再兜一次底。
  if (!user) {
    redirect('/login')
  }

  if (!UUID_PATTERN.test(id)) {
    notFound()
  }

  // 两路查询互不依赖，并行发（详情 + 该课全部任务）。
  // `now` 服务端算一次注入纯函数，避免与客户端各算一遍导致 hydration mismatch。
  const now = new Date()
  const [{ found, detail, error }, courseTasks] = await Promise.all([
    loadCourseDetail(supabase, id),
    loadTasks(supabase, { courseIds: [id], until: null, limit: COURSE_TASK_LIMIT, offset: 0 }),
  ])

  // 查询失败必须让用户看见，不能降级成「课程不存在」（CodingRules 7）。
  if (error) {
    return (
      <AppShell title="课程详情">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">课程详情加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
          <Link href="/courses" className="mt-4 inline-block text-sm text-muted-foreground">
            ← 返回我的课程
          </Link>
        </div>
      </AppShell>
    )
  }

  // ADR-010：不存在 / 不属于当前用户 / 已归档，统一按不存在处理。
  if (!found || !detail) {
    notFound()
  }

  /**
   * 撤销授权入口（P0-2-9）需要知道用户是否已保存 Canvas 凭据。
   *
   * **已撤销的凭据算「没有」**：撤销后那一行仍在库里（`status='revoked'`，重连时复用同一行），
   * 但入口应当消失 —— 都断开了还摆一个「撤销授权」按钮是自相矛盾的。
   *
   * 查询失败按「没有凭据」处理并**静默**：撤销入口是这个页面的**次要**功能，
   * 不该因为一次附属查询失败就盖住整门课的内容；凭据查询的显式报错由 dashboard 负责（P0-2-7）。
   */
  let hasCredential = false
  try {
    const credential = await loadCredentialMeta(supabase, user.id)
    hasCredential = credential !== null && credential.status !== 'revoked'
  } catch {
    hasCredential = false
  }

  const meta = [detail.courseCode, detail.instructorName].filter(Boolean).join(' · ')

  // 作业概况：只数**已知为真**的（不给未知状态编一个数字）。
  const scoredCount = courseTasks.tasks.filter(
    (task) => task.submissionScore !== null && task.pointsPossible !== null,
  ).length

  return (
    <AppShell title="课程详情">
      <div className="mx-auto max-w-[1100px] space-y-6">
        <Link href="/courses" className="inline-block text-sm text-ink-muted hover:text-ink">
          ← 返回我的课程
        </Link>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.courseName}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {[detail.semester, meta].filter(Boolean).join(' · ') || '未填写学期与编码'}
          </p>
        </div>

        <CourseActions course={detail} />

        {/* ---------- 概览：宽屏三栏，一屏看完"这门课现在什么样" ---------- */}
        <div className="grid gap-4 lg:grid-cols-3" data-course-overview>
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-medium text-foreground">Canvas 关联</h2>
            <CanvasLink
              courseId={detail.id}
              canvasCourseId={detail.canvasCourseId}
              hasCredential={hasCredential}
            />
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm lg:col-span-2">
            <h2 className="mb-3 text-sm font-medium text-foreground">成绩构成</h2>
            <GradePie components={detail.gradeComponents} />
          </section>
        </div>

        {/* ---------- 作业详情（折叠）：默认收起，标题上带条数 ---------- */}
        <details className="rounded-xl border border-border bg-card shadow-sm" data-assignments-detail>
          <summary className="cursor-pointer list-none p-5 text-sm font-medium text-foreground">
            作业详情
            <span className="ml-2 font-normal text-ink-muted">
              {courseTasks.error
                ? '加载失败'
                : `${courseTasks.tasks.length} 项${scoredCount > 0 ? ` · ${scoredCount} 项有分数` : ''}`}
            </span>
          </summary>
          <div className="px-5 pb-5">
            {/* 查询失败必须明说 —— 一个静默空列表会被读成"这门课没有作业"（CodingRules 7）。 */}
            {courseTasks.error ? (
              <p role="alert" className="text-sm text-destructive">
                作业列表加载失败：{courseTasks.error}
              </p>
            ) : (
              <AssignmentDetail tasks={courseTasks.tasks} now={now} />
            )}
          </div>
        </details>

        {/* ---------- 资料（Phase 1 占位，P0-3-19） ---------- */}
        <section className="rounded-xl border border-dashed border-border p-5">
          <h2 className="text-sm font-medium text-foreground">资料</h2>
          <p className="mt-1.5 text-xs text-ink-faint">
            Canvas 里的课件、复习卷、答案会按文件夹结构列在这里（`P0-3-19`）。
            Tempo 只存文件名与外链，**不下载内容** —— 需要看时点开回 Canvas。
          </p>
        </section>

        {/* ---------- 课程板块（原「五个板块」，含 syllabus 上传） ---------- */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-medium text-foreground">课程板块</h2>
          <SectionEditor
            courseId={detail.id}
            sections={{
              gradeComposition: detail.gradeComponents,
              courseOutline: detail.outlineItems,
              testDates: detail.examDates,
              officeHours: detail.officeHours,
              submissionPolicy: detail.submissionPolicies,
            }}
            parseStatus={detail.syllabus ? detail.syllabus.parseStatus : 'none'}
            uploadSlot={
              <SyllabusUpload courseId={detail.id} syllabus={detail.syllabus} />
            }
          />
        </section>
      </div>
    </AppShell>
  )
}
