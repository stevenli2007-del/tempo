'use client'

/**
 * 课程详情页「标签页」内容区（P0-5-2 修订版）。
 *
 * 左侧目录点哪项，右侧就只显示该面板的内容；不再把所有 section 堆在同一长页。
 * 全部数据由服务端页面注入，本组件只负责 tab 状态与条件渲染。
 */

import { useState } from 'react'

import { SectionEditor } from '@/components/sections/section-editor'
import type { CourseFileView } from '@/lib/course-files/grouping'
import { t } from '@/lib/i18n/translate'
import { Lang } from '@/lib/i18n/types'
import type { CourseDetail } from '@/types/course'
import type { Task } from '@/types/task'

import { AssignmentDetail } from './assignment-detail'
import { CanvasLink } from './canvas-link'
import { CourseFiles } from './course-files'
import { CourseDetailNav, NavItem } from './course-detail-nav'
import { ExamReviewSection } from './exam-review/exam-review-section'
import { GradePie } from './grade-pie'
import { SyllabusUpload } from './syllabus-upload'

type CourseDetailTabsProps = {
  lang: Lang
  navItems: NavItem[]
  detail: CourseDetail
  hasCredential: boolean
  courseTasks: { error: string | null; tasks: Task[] }
  courseTaskList: Task[]
  scoredCount: number
  now: Date
  courseFiles: { error: string | null; files: CourseFileView[] }
}

export function CourseDetailTabs({
  lang,
  navItems,
  detail,
  hasCredential,
  courseTasks,
  courseTaskList,
  scoredCount,
  now,
  courseFiles,
}: CourseDetailTabsProps) {
  const [activeTab, setActiveTab] = useState(navItems[0]?.id ?? 'syllabus')

  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[200px_1fr]">
      <CourseDetailNav items={navItems} activeId={activeTab} onSelect={setActiveTab} />

      <div className="min-w-0">
        {/* ---------- 课程大纲：Canvas 关联 + 成绩构成 + 课程板块 ---------- */}
        {activeTab === 'syllabus' && (
          <div className="space-y-6">
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
        )}

        {/* ---------- 作业详情 ---------- */}
        {activeTab === 'assignments' && (
          <details className="rounded-xl border border-border bg-card shadow-sm" open>
            <summary className="cursor-pointer list-none p-5 text-sm font-medium text-foreground">
              {t(lang, 'detail.assignments')}
              <span className="ml-2 font-normal text-ink-muted">
                {/* 说的必须和展开后看到的是同一件事（P0-3-17 验收修正，2026-09-17）。 */}
                {courseTasks.error
                  ? t(lang, 'detail.loadFailedShort')
                  : scoredCount > 0
                    ? t(lang, 'detail.scoredLine', { scored: scoredCount }) +
                      t(lang, 'detail.scoredUnscored', { unscored: courseTaskList.length - scoredCount })
                    : t(lang, 'detail.totalNoScore', { n: courseTaskList.length })}
              </span>
            </summary>
            <div className="px-5 pb-5">
              {/* 查询失败必须明说 —— 静默空列表会被读成"这门课没有作业"（CodingRules 7）。 */}
              {courseTasks.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(lang, 'detail.assignmentsFailed', { error: courseTasks.error })}
                </p>
              ) : (
                <AssignmentDetail tasks={courseTaskList} now={now} lang={lang} />
              )}
            </div>
          </details>
        )}

        {/* ---------- 资料 ---------- */}
        {activeTab === 'files' && (
          <CourseFiles courseId={detail.id} lang={lang} files={courseFiles.files ?? []} error={courseFiles.error ?? null} />
        )}

        {/* ---------- 考试复习 ---------- */}
        {activeTab === 'exams' && (
          <ExamReviewSection courseId={detail.id} lang={lang} exams={detail.examDates} />
        )}
      </div>
    </div>
  )
}
