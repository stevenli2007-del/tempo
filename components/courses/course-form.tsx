'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Course } from '@/types/course'

interface CourseFormBaseProps {
  /** 保存成功后回调。编辑模式下父组件用它收起表单。 */
  onDone?: () => void
  /** 取消编辑。 */
  onCancel?: () => void
}

/**
 * create 不带 course；edit 必须带 course（用于取 id 与回填默认值）。
 * 用可辨识联合而不是可选字段，避免 edit 模式下还要判空。
 */
type CourseFormProps = CourseFormBaseProps &
  ({ mode: 'create'; course?: undefined } | { mode: 'edit'; course: Course })

const INPUT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

const LABEL_CLASS = 'block text-sm font-medium text-foreground'

export function CourseForm(props: CourseFormProps) {
  const { mode, onDone, onCancel } = props
  // 联合类型在 props 未解构时才能正确收窄，所以这里单独取一次。
  const editing = props.mode === 'edit' ? props.course : null

  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = event.currentTarget
    const formData = new FormData(form)
    const text = (key: string) => String(formData.get(key) ?? '').trim()

    const payload = {
      semester: text('semester'),
      courseName: text('courseName'),
      // 选填字段留空表示清空，传 null 而不是空字符串（契约 1.1：不用空字符串代替"未知"）。
      courseCode: text('courseCode') || null,
      instructorName: text('instructorName') || null,
    }

    const url = editing ? `/api/v1/courses/${editing.id}` : '/api/v1/courses'

    setIsPending(true)
    try {
      const response = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : `保存失败（HTTP ${response.status}）`)
        return
      }

      if (mode === 'create') {
        form.reset()
      }
      // 服务端组件重新取数，列表立刻反映变更。
      router.refresh()
      onDone?.()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="courseName" className={LABEL_CLASS}>
            课程名 <span className="text-destructive">*</span>
          </label>
          <input
            id="courseName"
            name="courseName"
            required
            maxLength={120}
            defaultValue={editing?.courseName ?? ''}
            placeholder="Math 53"
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="semester" className={LABEL_CLASS}>
            学期 <span className="text-destructive">*</span>
          </label>
          <input
            id="semester"
            name="semester"
            required
            maxLength={50}
            defaultValue={editing?.semester ?? ''}
            placeholder="Fall 2026"
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="courseCode" className={LABEL_CLASS}>
            课程编码
          </label>
          <input
            id="courseCode"
            name="courseCode"
            maxLength={50}
            defaultValue={editing?.courseCode ?? ''}
            placeholder="MATH 53"
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="instructorName" className={LABEL_CLASS}>
            授课教师
          </label>
          <input
            id="instructorName"
            name="instructorName"
            maxLength={120}
            defaultValue={editing?.instructorName ?? ''}
            placeholder="Douskey"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="lg" disabled={isPending}>
          {isPending ? '保存中…' : editing ? '保存修改' : '创建课程'}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={isPending}>
            取消
          </Button>
        ) : null}
      </div>
    </form>
  )
}
