'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CourseForm } from '@/components/courses/course-form'

/**
 * 「新建课程」的开关容器。
 *
 * 表单默认收起，避免每进一次总览页都被一张空表单占住视线。
 */
export function CourseCreatePanel() {
  const [isOpen, setIsOpen] = useState(false)

  if (!isOpen) {
    return (
      <Button size="lg" onClick={() => setIsOpen(true)}>
        新建课程
      </Button>
    )
  }

  return (
    <div className="w-full rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-card-foreground">新建课程</h2>
      <CourseForm
        mode="create"
        onCancel={() => setIsOpen(false)}
        onDone={() => setIsOpen(false)}
      />
    </div>
  )
}
