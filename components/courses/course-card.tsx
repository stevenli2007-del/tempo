'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { syllabusStatusText } from '@/components/courses/syllabus-status'
import type { Course } from '@/types/course'
import type { Syllabus } from '@/types/syllabus'

/**
 * 课程卡片（P0-1-7 建，P0-1-8 瘦身，P0-1-9 加近期任务）。
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
}

interface CourseCardProps {
  course: Course
  /** 该课程最新一份 syllabus；没有则为 null。 */
  syllabus: Syllabus | null
  /**
   * 近期未完成的任务（最多 2 条）。已完成的不算 —— 卡片的语义是"接下来要做什么"。
   *
   * `null` 表示**没能加载到**，不是"这门课没有任务"。两者在 UI 上必须分开：
   * 把加载失败渲染成"没有任务"等于静默的错误数据（CodingRules 7）。
   */
  upcomingTasks: UpcomingTaskView[] | null
}

function UpcomingTasks({ tasks }: { tasks: UpcomingTaskView[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-baseline gap-2 text-xs">
          <span className="truncate text-foreground/80">{task.title}</span>
          <span
            className={`shrink-0 ${task.isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {task.dueLabel ?? '日期待定'}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function CourseCard({ course, syllabus, upcomingTasks }: CourseCardProps) {
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
        setError(typeof message === 'string' ? message : `删除失败（HTTP ${response.status}）`)
        return
      }
      setIsConfirmingDelete(false)
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setIsDeleting(false)
    }
  }

  const meta = [course.courseCode, course.instructorName].filter(Boolean).join(' · ')

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <Link href={`/courses/${course.id}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-card-foreground underline-offset-4 hover:underline">
              {course.courseName}
            </h3>
            {course.isDemo ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                示例
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {meta || '未填写编码与教师'}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{syllabusStatusText(syllabus)}</p>

          {upcomingTasks === null ? (
            <p className="mt-2 text-xs text-destructive">近期任务加载失败</p>
          ) : upcomingTasks.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground/70">近期没有待办</p>
          ) : (
            <UpcomingTasks tasks={upcomingTasks} />
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
          删除
        </button>
      </div>

      {isConfirmingDelete ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-foreground">
            删除「{course.courseName}」？课程及其任务会从列表中隐藏，数据仍保留。
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
              className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
            >
              {isDeleting ? '删除中…' : '确认删除'}
            </button>
            <button
              type="button"
              onClick={() => setIsConfirmingDelete(false)}
              disabled={isDeleting}
              className="h-8 rounded-md px-3 text-xs text-muted-foreground"
            >
              取消
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
