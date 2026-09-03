'use client'

import { useState } from 'react'

import { ExamDatesForm } from '@/components/sections/exam-dates-form'
import { GradeComponentsForm } from '@/components/sections/grade-components-form'
import { OfficeHoursForm } from '@/components/sections/office-hours-form'
import { OutlineItemsForm } from '@/components/sections/outline-items-form'
import { SubmissionPoliciesForm } from '@/components/sections/submission-policies-form'
import type { StoredSections } from '@/types/sections'

/**
 * 课程卡片内的五板块编辑器（P0-1-6）。
 *
 * 结构：折叠面板 + 五个 tab（每板块一个 `PUT` 端点，独立保存）。
 * 数据初值由 dashboard 服务端直查（`lib/sections.ts`），保存走契约 §4 的 PUT。
 * 正式课程详情页是 P0-1-8 —— 这里刻意不新增路由。
 */

const TABS = [
  { key: 'grade', label: '成绩构成' },
  { key: 'outline', label: '大纲' },
  { key: 'exams', label: '考试日期' },
  { key: 'officeHours', label: 'Office Hour' },
  { key: 'policies', label: '提交政策' },
] as const

type TabKey = (typeof TABS)[number]['key']

export function SectionEditor({
  courseId,
  sections,
  parseStatus,
}: {
  courseId: string
  sections: StoredSections
  /** 最新 syllabus 的解析状态：未解析过就提示先解析/手动补。 */
  parseStatus: 'none' | 'pending' | 'processing' | 'completed' | 'failed'
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabKey>('grade')

  const counts: Record<TabKey, number> = {
    grade: sections.gradeComposition?.length ?? 0,
    outline: sections.courseOutline?.length ?? 0,
    exams: sections.testDates?.length ?? 0,
    officeHours: sections.officeHours?.length ?? 0,
    policies: sections.submissionPolicy?.length ?? 0,
  }

  /*
   * 表单是非受控的（自己保存自己的 draft），所以服务端数据一变必须重挂载才能拿到新初值。
   * key = 板块数据序列化 —— 数据没变时字符串稳定，不会无谓重挂载。
   * 见 `shared.tsx` 里 useSectionForm 的说明。
   */
  const keyOf = (items: unknown[] | undefined) => JSON.stringify(items ?? [])

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-medium text-foreground">五个板块</span>
        <span className="text-xs text-muted-foreground">{open ? '收起 ▴' : '编辑 / 查看 ▾'}</span>
      </button>

      {open && parseStatus === 'none' ? (
        <p className="mt-3 text-sm text-muted-foreground">
          还没有解析过的数据。可以先上传并解析 syllabus，也可以直接在下面手动补条目。
        </p>
      ) : null}

      {open && parseStatus === 'failed' ? (
        <p className="mt-3 text-sm text-muted-foreground">
          上次解析失败了（换模型或改 prompt 后可重新解析）。你也可以直接在下面手动补条目。
        </p>
      ) : null}

      {open ? (
        <>
          <div className="mt-3 flex flex-wrap gap-1 border-b border-border pb-2">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                className={`rounded-md px-2 py-1 text-xs ${
                  tab === entry.key
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {entry.label}
                {counts[entry.key] > 0 ? (
                  <span className="ml-1 text-muted-foreground">{counts[entry.key]}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="mt-3">
            {tab === 'grade' ? (
              <GradeComponentsForm
                key={keyOf(sections.gradeComposition)}
                courseId={courseId}
                items={sections.gradeComposition ?? []}
              />
            ) : null}
            {tab === 'outline' ? (
              <OutlineItemsForm
                key={keyOf(sections.courseOutline)}
                courseId={courseId}
                items={sections.courseOutline ?? []}
              />
            ) : null}
            {tab === 'exams' ? (
              <ExamDatesForm
                key={keyOf(sections.testDates)}
                courseId={courseId}
                items={sections.testDates ?? []}
              />
            ) : null}
            {tab === 'officeHours' ? (
              <OfficeHoursForm
                key={keyOf(sections.officeHours)}
                courseId={courseId}
                items={sections.officeHours ?? []}
              />
            ) : null}
            {tab === 'policies' ? (
              <SubmissionPoliciesForm
                key={keyOf(sections.submissionPolicy)}
                courseId={courseId}
                items={sections.submissionPolicy ?? []}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
