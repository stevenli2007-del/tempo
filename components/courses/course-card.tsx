'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CourseForm } from '@/components/courses/course-form'
import { SyllabusUpload } from '@/components/courses/syllabus-upload'
import { SectionEditor } from '@/components/sections/section-editor'
import type { Course } from '@/types/course'
import type { StoredSections } from '@/types/sections'
import type { Syllabus } from '@/types/syllabus'

interface CourseCardProps {
  course: Course
  /** 该课程最新一份 syllabus；没有则为 null（P0-1-1 起展示上传入口）。 */
  syllabus: Syllabus | null
  /** 该课程五板块的当前数据（服务端直查，`lib/sections.ts`）。 */
  sections: StoredSections
}

export function CourseCard({ course, syllabus, sections }: CourseCardProps) {
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
      setIsConfirmingDelete(false)
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
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

  const meta = [course.courseCode, course.instructorName].filter(Boolean).join(' · ')

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-card-foreground">
            {course.courseName}
          </h3>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {meta || '未填写编码与教师'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null)
              setIsConfirmingDelete(true)
            }}
          >
            删除
          </Button>
        </div>
      </div>

      <SyllabusUpload courseId={course.id} syllabus={syllabus} />

      <SectionEditor
        courseId={course.id}
        sections={sections}
        parseStatus={syllabus ? syllabus.parseStatus : 'none'}
      />

      {isConfirmingDelete ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-foreground">
            删除「{course.courseName}」？课程及其任务会从列表中隐藏，数据仍保留。
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? '删除中…' : '确认删除'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsConfirmingDelete(false)}
              disabled={isDeleting}
            >
              取消
            </Button>
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
