import Link from 'next/link'

import { ExamMark } from '@/components/tasks/exam-mark'
import { examScheduleLabel } from '@/lib/course-update/exam-match'
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import type { StoredExamDate } from '@/types/sections'

/**
 * 课程页的「考试复习」入口（P0-3-31）。
 *
 * ### 🔴 本卡验收⑤的落点：非考试任务**没有入口**
 * 这份清单的数据源是 `exam_dates`（考试的**权威源**，ADR-004）—— 里面**只会有考试**。
 * 作业 / 阅读 / 手动任务都不在 `exam_dates` 里，因此**天然**不会出现在这里，
 * 也不会有任何路由能把它们变成复习页（复习页的入口参数就是 `exam_dates.id`）。
 *
 * ### 为什么单独一块，而不是塞进「五个板块 → 考试日期」
 * 那一块是**数据编辑器**（非受控表单 + 编辑/查看切换），是"改数据"的地方；
 * 这里是**动作入口**（进复习模式），是"用数据"的地方。混在一起会让
 * "我只是想看复习页"要先进编辑器、再退出编辑模式 —— 而且那块默认是**折叠**的。
 * 两块共用同一个数据源（`detail.examDates`），所以不会出现"两处考试不一样"。
 *
 * ⚠️ 没有考试时**整块不渲染**：一个空的"考试复习"区只会占版面。
 */
export function ExamReviewSection({
  courseId,
  lang,
  exams,
}: {
  courseId: string
  lang: Lang
  exams: StoredExamDate[]
}) {
  if (exams.length === 0) return null

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-exam-review-section
    >
      <h2 className="mb-1 text-sm font-medium text-foreground">{t(lang, 'detail.examReview')}</h2>
      <p className="text-xs text-ink-faint">{t(lang, 'detail.examReviewHint')}</p>

      <ul className="mt-3 space-y-2">
        {exams.map((exam) => (
          <li
            key={exam.id}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-b-0 last:pb-0"
            data-exam-review-entry={exam.id}
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium break-words text-foreground">
                {/* 考试标记（P0-3-33）：与周历 pill / 今日任务行 / 待办清单是**同一套视觉**
                    （`components/tasks/exam-mark.tsx`）—— 同一场考试在哪个页面都该长得一样。
                    这里数据源是 `exam_dates`，每一行必然是考试，标记的作用是"跨页面认得出是它"。 */}
                <ExamMark lang={lang} />
                {exam.examName}
                {exam.status === 'tbd' ? (
                  <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-normal text-ink-faint">
                    {t(lang, 'detail.examTbd')}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-ink-faint">
                {examScheduleLabel({
                  examDate: exam.examDate,
                  examTime: exam.examTime,
                  location: exam.location,
                  lang,
                })}
              </p>
            </div>
            <Link
              href={`/courses/${courseId}/exams/${exam.id}/review`}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/50"
            >
              {t(lang, 'detail.reviewMode')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
