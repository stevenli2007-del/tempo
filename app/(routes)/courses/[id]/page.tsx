import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AssignmentDetail } from '@/components/courses/assignment-detail'
import { CanvasLink } from '@/components/courses/canvas-link'
import { CourseFiles } from '@/components/courses/course-files'
import { CourseActions } from '@/components/courses/course-actions'
import { ExamReviewSection } from '@/components/courses/exam-review/exam-review-section'
import { GradePie } from '@/components/courses/grade-pie'
import { SyllabusUpload } from '@/components/courses/syllabus-upload'
import { SectionEditor } from '@/components/sections/section-editor'
import { AppShell } from '@/components/shell/app-shell'
import { UUID_PATTERN } from '@/lib/api/params'
import { loadCredentialMeta } from '@/lib/canvas/credentials'
import { loadCourseDetail } from '@/lib/course-detail'
import { loadCourseFiles } from '@/lib/course-files/load'
import { createClient } from '@/lib/supabase/server'
import { dropCanvasExamPlaceholders, loadTasks } from '@/lib/tasks'
import { getLang } from '@/lib/i18n/server'
import { t } from '@/lib/i18n/translate'

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
 *   → 资料（P0-3-19：按 Canvas 的**文件夹树**分组 + 外链回 Canvas；索引只存目录，
 *     点「一键总结」才临时读那一份文件 → `P0-3-19b`，见 `lib/course-files/summary/`）
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

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const lang = await getLang()
  return { title: `${t(lang, 'detail.title')} · Tempo` }
}

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

  const lang = await getLang()

  // 三路查询互不依赖，并行发（详情 + 该课全部任务 + 资料索引）。
  // `now` 服务端算一次注入纯函数，避免与客户端各算一遍导致 hydration mismatch。
  const now = new Date()
  const [{ found, detail, error }, courseTasks, courseFiles] = await Promise.all([
    loadCourseDetail(supabase, id),
    loadTasks(supabase, { courseIds: [id], until: null, limit: COURSE_TASK_LIMIT, offset: 0 }),
    loadCourseFiles(supabase, id),
  ])

  // 查询失败必须让用户看见，不能降级成「课程不存在」（CodingRules 7）。
  if (error) {
    return (
      <AppShell title={t(lang, 'detail.title')}>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">{t(lang, 'detail.loadFailed')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
          <Link href="/courses" className="mt-4 inline-block text-sm text-muted-foreground">
            {t(lang, 'detail.back')}
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

  // Canvas 的「考试空壳作业」（同名、无截止日）在这页同样不该占一行 ——
  // 判据与总览页同一份（`dropCanvasExamPlaceholders`，P0-3-36）。
  const courseTaskList = dropCanvasExamPlaceholders(courseTasks.tasks)

  // 作业概况：只数**已知为真**的（不给未知状态编一个数字）。
  const scoredCount = courseTaskList.filter(
    (task) => task.submissionScore !== null && task.pointsPossible !== null,
  ).length

  return (
    <AppShell title={t(lang, 'detail.title')}>
      <div className="mx-auto max-w-[1100px] space-y-6">
        <Link href="/courses" className="inline-block text-sm text-ink-muted hover:text-ink">
          {t(lang, 'detail.back')}
        </Link>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.courseName}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {[detail.semester, meta].filter(Boolean).join(' · ') || t(lang, 'detail.noSemester')}
          </p>
        </div>

        <CourseActions course={detail} lang={lang} />

        {/* ---------- 概览：宽屏三栏，一屏看完"这门课现在什么样" ---------- */}
        <div className="grid gap-4 lg:grid-cols-3" data-course-overview>
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-medium text-foreground">{t(lang, 'detail.canvasLink')}</h2>
            <CanvasLink
              courseId={detail.id}
              lang={lang}
              canvasCourseId={detail.canvasCourseId}
              hasCredential={hasCredential}
            />
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm lg:col-span-2">
            <h2 className="mb-3 text-sm font-medium text-foreground">{t(lang, 'detail.gradeComposition')}</h2>
            <GradePie components={detail.gradeComponents} lang={lang} />
          </section>
        </div>

        {/* ---------- 作业详情（折叠）：默认收起，标题上带条数 ---------- */}
        <details className="rounded-xl border border-border bg-card shadow-sm" data-assignments-detail>
          <summary className="cursor-pointer list-none p-5 text-sm font-medium text-foreground">
            {t(lang, 'detail.assignments')}
            <span className="ml-2 font-normal text-ink-muted">
              {/* 🔴 说的必须和展开后看到的是同一件事（P0-3-17 验收修正，2026-09-17）：
                  区里只列「已出分」的行，所以这里也报已出分的条数；总数另说一句，
                  好让用户知道被过滤掉多少，不至于以为作业少了。 */}
              {courseTasks.error
                ? t(lang, 'detail.loadFailedShort')
                : scoredCount > 0
                  ? t(lang, 'detail.scoredLine', { scored: scoredCount }) +
                    t(lang, 'detail.scoredUnscored', { unscored: courseTaskList.length - scoredCount })
                  : t(lang, 'detail.totalNoScore', { n: courseTaskList.length })}
            </span>
          </summary>
          <div className="px-5 pb-5">
            {/* 查询失败必须明说 —— 一个静默空列表会被读成"这门课没有作业"（CodingRules 7）。 */}
            {courseTasks.error ? (
              <p role="alert" className="text-sm text-destructive">
                {t(lang, 'detail.assignmentsFailed', { error: courseTasks.error })}
              </p>
            ) : (
              <AssignmentDetail tasks={courseTaskList} now={now} lang={lang} />
            )}
          </div>
        </details>

        {/* ---------- 资料（P0-3-19）：按 Canvas 文件夹结构分组，点开回 Canvas ---------- */}
        <CourseFiles courseId={detail.id} lang={lang} files={courseFiles.files} error={courseFiles.error} />

        {/* ---------- 考试复习（P0-3-31）：数据源是 exam_dates（只会有考试）→ 非考试任务天然无入口 ---------- */}
        <ExamReviewSection courseId={detail.id} lang={lang} exams={detail.examDates} />

        {/* ---------- 课程板块（原「五个板块」，含 syllabus 上传） ---------- */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-medium text-foreground">{t(lang, 'detail.sections')}</h2>
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
              <SyllabusUpload courseId={detail.id} lang={lang} syllabus={detail.syllabus} />
            }
          />
        </section>
      </div>
    </AppShell>
  )
}
