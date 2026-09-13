import Link from 'next/link'

import { courseColorKey, courseColorVar } from '@/lib/courses/course-color'
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
 * 2. **考试用 lime 实心块** —— 一门课一学期只有 3-5 次考试，是天然少数派，
 *    值得抢眼（「标签的价值在于标出少数派」）。同时带一个「考」字，
 *    不靠颜色单独传达信息。
 * 3. **pill 里不做勾选** —— 格子里塞 checkbox 既点不准，又会让「标记完成」出现两套交互。
 *    pill 只负责跳到课程详情；**改 `status` 的唯一入口仍是下方「全部待办」清单**
 *    （`TaskList`，PATCH 只允许改 status，ADR-004）。
 */

function Pill({ pill }: { pill: CalendarPill }) {
  const title = `${pill.courseName} · ${pill.title}${pill.isExam ? '（考试）' : ''}`

  if (pill.isExam) {
    return (
      <Link
        href={`/courses/${pill.courseId}`}
        title={title}
        className="flex items-center gap-1 rounded-badge bg-lime px-1.5 py-1 text-[11px] font-medium leading-tight text-on-lime"
      >
        <span className="shrink-0 font-semibold">考</span>
        <span className="truncate">{pill.title}</span>
      </Link>
    )
  }

  return (
    <Link
      href={`/courses/${pill.courseId}`}
      title={title}
      className="flex items-center gap-1 rounded-badge bg-surface2 px-1.5 py-1 text-[11px] leading-tight hover:bg-nav-active"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: courseColorVar(courseColorKey(pill.courseId)) }}
        aria-hidden
      />
      <span className={`truncate ${pill.isOverdue ? 'text-destructive' : 'text-ink-muted'}`}>
        {pill.title}
      </span>
    </Link>
  )
}

function PillList({ pills }: { pills: CalendarPill[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {pills.map((pill) => (
        <li key={pill.id} className="max-w-full">
          <Pill pill={pill} />
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
function UpcomingExams({ exams }: { exams: UpcomingExam[] }) {
  if (exams.length === 0) return null

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-xs text-muted-foreground">
        最近的考试
        <span className="ml-1.5">（超出 7 天的也列在这里）</span>
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {exams.map((exam) => (
          <li key={exam.id} className="max-w-full">
            <Link
              href={`/courses/${exam.courseId}`}
              title={`${exam.courseName} · ${exam.title} · ${exam.dateLabel}`}
              className="flex items-center gap-1.5 rounded-badge bg-lime/20 px-2 py-1 text-[11px] hover:bg-lime/30"
            >
              <span className="shrink-0 font-semibold text-lime-dark">
                {exam.daysUntil === 0 ? '今天' : `还有 ${exam.daysUntil} 天`}
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
}: {
  model: WeekCalendarModel
  exams: UpcomingExam[]
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
        <p className="text-sm text-muted-foreground">
          接下来 7 天没有要做的事。上传 syllabus 或连上 Canvas 后，这里会自动排出来。
        </p>
      ) : null}

      {overdue.length > 0 ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-xs font-medium text-destructive">
            已逾期 {overdue.length} 项
            <span className="ml-1.5 font-normal text-muted-foreground">按最近的排在前</span>
          </p>
          <div className="mt-1.5">
            <PillList pills={overdue} />
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
                      <Pill pill={pill} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <UpcomingExams exams={exams} />

      {undated.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-muted-foreground">
            日期待定
            <span className="ml-1.5">（syllabus 里只写了「某周」、没给具体日子的，不编日期）</span>
          </p>
          <div className="mt-1.5">
            <PillList pills={undated} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
