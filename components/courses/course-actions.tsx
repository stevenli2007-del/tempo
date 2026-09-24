'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { CourseForm } from '@/components/courses/course-form'
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import type { Course } from '@/types/course'

/**
 * 详情页的课程级操作：编辑元信息 / 归档删除。
 *
 * P0-1-8 搬过来的（原本在卡片里）。删除后**跳回总览** ——
 * 留在详情页会渲染一门已归档的课程（服务端查不到了），是个死胡同。
 */
export function CourseActions({ course, lang }: { course: Course; lang: Lang }) {
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
        setError(typeof message === 'string' ? message : t(lang, 'courses.deleteFailed', { status: response.status }))
        return
      }
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError(t(lang, 'common.networkError'))
      setIsDeleting(false)
    }
  }

  if (isEditing) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <CourseForm
          mode="edit"
          lang={lang}
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
        {t(lang, 'courses.editInfo')}
      </button>
      <button
        type="button"
        onClick={() => {
          setError(null)
          setIsConfirmingDelete(true)
        }}
        className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:text-destructive"
      >
        {t(lang, 'common.delete')}
      </button>

      {isConfirmingDelete ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm text-foreground">
            {t(lang, 'courses.deleteConfirm', { name: course.courseName })}
          </p>
          <div className="mt-2 flex items-center gap-2">
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
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
