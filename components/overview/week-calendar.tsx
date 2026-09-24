import Link from 'next/link'

import { EXAM_CHIP_CLASS, ExamMark } from '@/components/tasks/exam-mark'
import { courseColorClasses, courseColorKey } from '@/lib/courses/course-color'
import type { Lang } from '@/lib/i18n/types'
import { t } from '@/lib/i18n/translate'
import type { CalendarPill, UpcomingExam, WeekCalendarModel } from '@/lib/tasks/progress'

/**
 * 总览页周历（P0-3-7b）。
 *
 * ### 服务端组件
 * 数据（哪一天、星期几、是否已逾期）全部由 `buildWeekCalendar()` 在**服务端**算好 ——
 * 客户端各算一遍时区就是 hydration mismatch（P0-3-10 的教训）。
 * 所以这里没有任何 `useState`，也不带 `'use client'`：只有 `Link` 需要交互。
 *
 * ### 三个刻意的决定（都别"顺手优化"掉）
 * 1. **逾期不散落在过去的格子里**，收成顶部一整条 —— 过去的日子没人会往回翻，
 *    散落在上个月的格子里等于把它们藏起来（与 Tempo「不隐藏问题」冲突）。
 * 2. **考试用「边框 + 底色 + 图标 + 考」** —— 一门课一学期只有 3-5 次考试，是天然少数派，
 *    值得抢眼（「标签的价值在于标出少数派」）。P0-3-33 之前它是**实心 lime 块 + 一个「考」字**，
 *    而总览页别处又各是另一套画法；现在统一走 `components/tasks/exam-mark.tsx` 那一套，
 *    全站同一场考试长得一样。**不靠颜色单独传达信息**：边框与图标在全色盲下依然在。
 * 3. **每个 pill 左边一根课程色条**（P0-3-33）—— 之前只有一颗 1.5px 的圆点，
 *    小到看不出区别（Steven：「单单一颗很小的颜色亮点不足以区分」）。
 *    现在改成 `border-l-2` 的整高色边，扫描一列 pill 就能按颜色分组。
 * 4. **pill 里不做勾选** —— 格子里塞 checkbox 既点不准，又会让「标记完成」出现两套交互。
 *    pill 只负责跳到课程详情；**改 `status` 的唯一入口仍是下方「全部待办」清单**
 *    （`TaskList`，PATCH 只允许改 status，ADR-004）。
 */

function Pill({ pill, lang }: { pill: CalendarPill; lang: Lang }) {
  const title = `${pill.courseName} · ${pill.title}${pill.isExam ? t(lang, 'calendar.examTag') : ''}`
  // 课程色三件套（P0-3-33）：类名是静态字面量（`lib/courses/course-color.ts`），
  // 不是 `border-l-${color}` 这种运行时拼接 —— 拼接出来的类 Tailwind 扫不到、不生成。
  const color = courseColorClasses(courseColorKey(pill.courseId))

  if (pill.isExam) {
    return (
      <Link
        href={`/courses/${pill.courseId}`}
        title={title}
        className={`flex items-center gap-1 rounded-badge border-l-2 px-1.5 py-1 text-[11px] font-medium leading-tight text-lime-dark ${color.edge} ${EXAM_CHIP_CLASS}`}
      >
        <ExamMark bare lang={lang} />
        <span className="truncate">{pill.title}</span>
      </Link>
    )
  }

  return (
    <Link
      href={`/courses/${pill.courseId}`}
      title={title}
      className={`flex items-center gap-1 rounded-badge border-l-2 bg-surface2 px-1.5 py-1 text-[11px] leading-tight hover:bg-nav-active ${color.edge}`}
    >
      <span className={`truncate ${pill.isOverdue ? 'text-destructive' : 'text-ink-muted'}`}>
        {pill.title}
      </span>
    </Link>
  )
}

function PillList({ pills, lang }: { pills: CalendarPill[]; lang: Lang }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {pills.map((pill) => (
        <li key={pill.id} className="max-w-full">
          <Pill pill={pill} lang={lang} />
        </li>
      ))}
    </ul>
  )
}

/**
 * 「最近的考试」条 —— **刻意不受 7 天窗口限制**。
 *
 * 理由见 `buildUpcomingExams()` 的注释：7 天窗口对作业够用，对考试完全不够
 * （2026-09-13 实测：Steven 的 4 场考试全在 7 天之外，最近一场还有 9 天）。
 * 考试是最稀疏、最高风险的一类事项 —— 漏看一次期中的代价远大于漏做一个作业，
 * 所以它值得单独一条、且看得比 7 天更远。
 */
function UpcomingExams({ exams, lang }: { exams: UpcomingExam[]; lang: Lang }) {
  if (exams.length === 0) return null

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-xs text-muted-foreground">
        {t(lang, 'calendar.upcomingExams')}
        <span className="ml-1.5">{t(lang, 'calendar.upcomingExamsNote')}</span>
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {exams.map((exam) => (
          <li key={exam.id} className="max-w-full">
            <Link
              href={`/courses/${exam.courseId}`}
              title={`${exam.courseName} · ${exam.title} · ${exam.dateLabel}`}
              className={`flex items-center gap-1.5 rounded-badge border-l-2 bg-lime/20 px-2 py-1 text-[11px] hover:bg-lime/30 ${
                courseColorClasses(courseColorKey(exam.courseId)).edge
              }`}
            >
              <span className="shrink-0 font-semibold text-lime-dark">
                {exam.daysUntil === 0
                  ? t(lang, 'calendar.today')
                  : t(lang, 'calendar.daysLeft', { n: exam.daysUntil })}
              </span>
              <span className="truncate text-ink">{exam.title}</span>
              <span className="shrink-0 text-ink-faint">{exam.dateLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function WeekCalendar({
  model,
  exams,
  lang,
}: {
  model: WeekCalendarModel
  exams: UpcomingExam[]
  lang: Lang
}) {
  const { days, overdue, undated } = model
  const isEmpty =
    overdue.length === 0 &&
    undated.length === 0 &&
    exams.length === 0 &&
    days.every((day) => day.pills.length === 0)

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {isEmpty ? (
        <p className="text-sm text-muted-foreground">{t(lang, 'calendar.empty')}</p>
      ) : null}

      {overdue.length > 0 ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-xs font-medium text-destructive">
            {t(lang, 'calendar.overdue', { n: overdue.length })}
            <span className="ml-1.5 font-normal text-muted-foreground">
              {t(lang, 'calendar.overdueNote')}
            </span>
          </p>
          <div className="mt-1.5">
            <PillList pills={overdue} lang={lang} />
          </div>
        </div>
      ) : null}

      {isEmpty ? null : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[620px] grid-cols-7 gap-2">
            {days.map((day) => (
              <div
                key={day.key}
                className={`rounded-xl border p-2 ${
                  day.isToday ? 'border-lime/70 bg-surface2/50' : 'border-line'
                }`}
              >
                <div className="mb-1.5 flex items-baseline justify-between gap-1">
                  <span
                    className={`text-xs font-semibold ${day.isToday ? 'text-lime-dark' : 'text-ink'}`}
                  >
                    {day.weekday}
                  </span>
                  <span className="text-[11px] text-ink-faint">{day.monthDay}</span>
                </div>
                <ul className="flex min-h-[56px] flex-col gap-1">
                  {day.pills.map((pill) => (
                    <li key={pill.id} className="min-w-0">
                      <Pill pill={pill} lang={lang} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <UpcomingExams exams={exams} lang={lang} />

      {undated.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-muted-foreground">
            {t(lang, 'calendar.undated')}
            <span className="ml-1.5">{t(lang, 'calendar.undatedNote')}</span>
          </p>
          <div className="mt-1.5">
            <PillList pills={undated} lang={lang} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
