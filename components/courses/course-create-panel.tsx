'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CourseForm } from '@/components/courses/course-form'
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'

/**
 * 「新建课程」的开关容器。
 *
 * 表单默认收起，避免每进一次总览页都被一张空表单占住视线。
 */
export function CourseCreatePanel({ lang }: { lang: Lang }) {
  const [isOpen, setIsOpen] = useState(false)

  if (!isOpen) {
    return (
      <Button size="lg" onClick={() => setIsOpen(true)}>
        {t(lang, 'courses.create')}
      </Button>
    )
  }

  return (
    <div className="w-full rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-card-foreground">{t(lang, 'courses.createTitle')}</h2>
      <CourseForm
        mode="create"
        lang={lang}
        onCancel={() => setIsOpen(false)}
        onDone={() => setIsOpen(false)}
      />
    </div>
  )
}
