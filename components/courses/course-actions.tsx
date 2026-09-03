'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { CourseForm } from '@/components/courses/course-form'
import type { Course } from '@/types/course'

/**
 * 详情页的课程级操作：编辑元信息 / 归档删除。
 *
 * P0-1-8 搬过来的（原本在卡片里）。删除后**跳回总览** ——
 * 留在详情页会渲染一门已归档的课程（服务端查不到了），是个死胡同。
 */
export function CourseActions({ course }: { course: Course }) {
  const router = useRouter()
  const [isEditing, setIsEditing] = useState(false)
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
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
      setIsDeleting(false)
    }
  }

  if (isEditing) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <CourseForm
          mode="edit"
          course={course}
          onDone={() => setIsEditing(false)}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        className="h-8 rounded-md border border-border bg-card px-3 text-sm text-foreground"
      >
        编辑信息
      </button>
      <button
        type="button"
        onClick={() => {
          setError(null)
          setIsConfirmingDelete(true)
        }}
        className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:text-destructive"
      >
        删除
      </button>

      {isConfirmingDelete ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm text-foreground">
            删除「{course.courseName}」？课程及其任务会从列表中隐藏，数据仍保留。
          </p>
          <div className="mt-2 flex items-center gap-2">
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
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
