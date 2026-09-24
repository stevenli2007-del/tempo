'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { syllabusStatusText } from '@/components/courses/syllabus-status'
import { ExamMark } from '@/components/tasks/exam-mark'
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import { courseColorClasses, courseColorKey } from '@/lib/courses/course-color'
import type { CourseSyncLine } from '@/lib/sync/status'
import { SUBMISSION_BADGE_CLASS, submissionBadge } from '@/lib/tasks/submission'
import type { Course } from '@/types/course'
import type { TaskSource, TaskSubmissionState } from '@/types/task'
import type { Syllabus } from '@/types/syllabus'

/**
 * 课程卡片（P0-1-7 建，P0-1-8 瘦身，P0-1-9 加近期任务，P0-2-7 加同步状态行）。
 *
 * P0-1-8 的拍板：**全部操作搬到详情页**（`app/(routes)/courses/[id]`）——
 * 上传 / 解析 / 五板块编辑 / 课程元信息编辑都在那儿，卡片只做摘要 + 入口。
 * 单一编辑入口，也顺带去掉了 P0-1-6 留下的「dashboard 一次性加载所有课程五板块」的开销。
 *
 * 保留在卡片上的只有**删除**：它是列表级动作，就地操作比进详情页绕一圈顺手，
 * 且归档语义下风险可控（有二次确认）。
 */

/**
 * 卡片上「近期任务」的视图模型。
 *
 * 日期由服务端格式化成 label 传进来，而不是给 ISO 串让客户端自己转 ——
 * 服务端（UTC）与浏览器（用户时区）渲染结果不同会导致 hydration mismatch。
 */
export interface UpcomingTaskView {
  id: string
  title: string
  /** null = 日期待定（TBD）。 */
  dueLabel: string | null
  isOverdue: boolean
  /**
   * 任务来源（P0-3-17）。徽标「需手动确认」只给 **Canvas 来源** 的 null 态，
   * 所以这里必须带 `source` —— 与总览页清单传的是同一个形状。
   */
  source: TaskSource
  /** Canvas 提交态（P0-3-10）；null = 不追踪。卡片显示「已评分」等轻量徽标。 */
  submissionState: TaskSubmissionState | null
  /**
   * 是不是考试（P0-3-33）。判据来自 `isExamTask()`（`taskType === 'exam'`），
   * **在这里算好**再传进来 —— 卡片与总览清单必须用同一套考试视觉，
   * 而"是不是考试"的判定全站只有一处。
   */
  isExam: boolean
}

interface CourseCardProps {
  course: Course
  /** 界面语言（服务端页面传入，随 cookie 切换）。 */
  lang: Lang
  /** 该课程最新一份 syllabus；没有则为 null。 */
  syllabus: Syllabus | null
  /**
   * 近期未完成的任务（最多 2 条）。已完成的不算 —— 卡片的语义是"接下来要做什么"。
   *
   * 永远传数组：`[]` 表示这门课没有未完成的任务（正常状态），
   * 非空表示有任务。**不再用 `null` 表示"加载失败"** —— 那种状态改由 `loadError` 控制。
   */
  upcomingTasks: UpcomingTaskView[]
  /** tasks 查询失败时的错误原文。仅在非空时显示「加载失败」分支。 */
  loadError?: string | null
  /**
   * Canvas 同步状态行（P0-2-7）。**未关联 Canvas 的课传 null** ——
   * 那种课不存在"同步"这回事，显示一行同步状态是无意义噪声。
   *
   * 文案与时间都由服务端算好再传进来（客户端算时区会 hydration mismatch）。
   */
  syncLine?: CourseSyncLine | null
}

/** 卡片上的轻量提交态标注（P0-3-10）—— 口径已搬到 `lib/tasks/submission.ts`（P0-3-15）。 */

function UpcomingTasks({ tasks, lang }: { tasks: UpcomingTaskView[]; lang: Lang }) {
  return (
    <ul className="mt-2 space-y-1">
      {tasks.map((task) => {
        // 徽标口径与总览页任务行**共用一处**（`lib/tasks/submission.ts`，P0-3-15）——
        // 各写一份 switch 迟早出现"同一份作业两页写着不同的状态"。
        // P0-3-17：入参改为整行（`null` 的含义取决于 `source`）。
        const badge = submissionBadge(task, lang)
        return (
          <li key={task.id} className="flex items-baseline gap-2 text-xs">
            <span className="truncate text-foreground/80">{task.title}</span>
            {/* 考试标记（P0-3-33）：卡片上的近期任务同样要能认出考试 ——
                这里与总览清单、周历 pill 用**同一个** `ExamMark`。 */}
            {task.isExam ? <ExamMark lang={lang} /> : null}
            <span
              className={`shrink-0 ${task.isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {task.dueLabel ?? t(lang, 'common.dateTbd')}
              {badge ? (
                <>
                  {' · '}
                  <span className={SUBMISSION_BADGE_CLASS[badge.tone]} title={badge.title}>
                    {badge.label}
                  </span>
                </>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function CourseCard({
  course,
  lang,
  syllabus,
  upcomingTasks,
  loadError,
  syncLine,
}: CourseCardProps) {
  const router = useRouter()
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleDelete() {
    setError(null)
    setIsDeleting(true)
    try {
      const response = await fetch(`/api/v1/courses/${course.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : t(lang, 'courses.deleteFailed', { status: response.status }))
        return
      }
      setIsConfirmingDelete(false)
      router.refresh()
    } catch {
      setError(t(lang, 'common.networkError'))
    } finally {
      setIsDeleting(false)
    }
  }

  const color = courseColorClasses(courseColorKey(course.id))
  /**
   * 课程编码既然已经单独做成彩色的 chip（见下），这一行就只剩教师。
   * 两者都没有时仍然要写清楚"没填" —— 留一行空白会被读成"加载失败"。
   */
  const teacherLine =
    course.instructorName ??
    (course.courseCode ? t(lang, 'courses.teacherMissing') : t(lang, 'courses.codeTeacherMissing'))

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm">
      {/* 课程色条（P0-3-33）：从一颗 3px 圆点升级成整张卡高的 4px 色条 ——
          圆点太小，一屏十几张卡扫不出哪张是哪门课（Steven 2026-09-20：
          「单单一颗很小的颜色亮点不足以区分」）。同一门课在课程卡 / 待办清单 /
          周历 pill / 今日任务行上是**同一个颜色**（`courseColorKey()` 一处决定）。
          `overflow-hidden` + 绝对定位：色条贴着卡片的圆角走，不会从圆角里戳出一截直角。 */}
      <span className={`absolute inset-y-0 left-0 w-1 ${color.bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-4">
        <Link href={`/courses/${course.id}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-card-foreground underline-offset-4 hover:underline">
              {course.courseName}
            </h3>
            {course.courseCode ? (
              <span
                className={`shrink-0 rounded-badge px-1.5 py-0.5 text-[11px] font-medium ${color.chip}`}
              >
                {course.courseCode}
              </span>
            ) : null}
            {course.isDemo ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {t(lang, 'courses.demo')}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{teacherLine}</p>
          <p className="mt-2 text-xs text-muted-foreground">{syllabusStatusText(syllabus, lang)}</p>

          {/* 同步状态行：失败时是红色并带原因（hover 看原文）。
              它排在 syllabus 状态之后、任务列表之前 —— 这条信息解释的是
              "下面这些任务有多可信"，放在任务上面才连得起来。 */}
          {syncLine ? (
            <p
              className={`mt-1 text-xs ${syncLine.tone === 'error' ? 'text-destructive' : 'text-muted-foreground/80'}`}
              title={syncLine.hint ?? undefined}
              data-sync-tone={syncLine.tone}
            >
              {syncLine.text}
            </p>
          ) : null}

          {loadError ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-destructive">{t(lang, 'courses.upcomingLoadFailed')}</p>
              <p
                className="break-all text-[10px] leading-tight text-muted-foreground/80"
                title={loadError}
              >
                {loadError}
              </p>
            </div>
          ) : upcomingTasks.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground/70">{t(lang, 'courses.noUpcoming')}</p>
          ) : (
            <UpcomingTasks tasks={upcomingTasks} lang={lang} />
          )}
        </Link>

        <button
          type="button"
          onClick={() => {
            setError(null)
            setIsConfirmingDelete(true)
          }}
          className="shrink-0 text-sm text-muted-foreground hover:text-destructive"
        >
          {t(lang, 'common.delete')}
        </button>
      </div>

      {isConfirmingDelete ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-foreground">
            {t(lang, 'courses.deleteConfirm', { name: course.courseName })}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
              className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
            >
              {isDeleting ? t(lang, 'common.deleting') : t(lang, 'common.confirmDelete')}
            </button>
            <button
              type="button"
              onClick={() => setIsConfirmingDelete(false)}
              disabled={isDeleting}
              className="h-8 rounded-md px-3 text-xs text-muted-foreground"
            >
              {t(lang, 'common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
