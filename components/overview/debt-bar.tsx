import Link from 'next/link'

import { courseColorKey, courseColorVar } from '@/lib/courses/course-color'
import type { DebtCounts, DebtSummary } from '@/lib/tasks/progress'

/**
 * 总览页「已到期作业」负担卡（P0-3-7c）。口径见 `lib/tasks/progress.ts` 与 `API-Contract.md §5.4`。
 *
 * ### 为什么不是「进度条」
 * 执行卡里叫它进度条，但它**不能**是进度条 —— 理由见 `summarizeDebt()` 的注释：
 * 分母会随老师发布作业而长大，全学期口径的百分比会**倒退**；而且没有"工作量"字段，
 * 只有件数。所以它回答的是「**我欠了多少**」，不是「我完成了多少」。
 *
 * ### 三条刻意的设计（对齐 ADR-016）
 * 1. **条上只画欠账**（未交 + 待确认），已交不占段位、只出现在文字里 ——
 *    "做完的事不是新闻"。若把已交画成一大段灰，整条会读成「完成度 90%」，
 *    那就是 R5 禁止的庆祝性激励。
 * 2. **不出现百分比**。"6 / 18 件" 是事实，"33%" 会被读成成绩。
 * 3. **待确认单列第三色（琥珀）**，绝不并进"未交" —— Canvas 不知道 ≠ 用户没交
 *    （ADR-013，P0-3-10 实测过已交却报未交）。
 */

/** 三个桶共用的一条分段条。`base` 是归一化基数：整体条用总数，课程条用"最重那门"的总数 —— 这样条长可比。 */
function DebtStack({ counts, base }: { counts: DebtCounts; base: number }) {
  const overduePct = base > 0 ? (counts.overdue / base) * 100 : 0
  const unconfirmedPct = base > 0 ? (counts.unconfirmed / base) * 100 : 0

  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface2">
      {overduePct > 0 ? (
        <div className="h-full bg-red" style={{ width: `${overduePct}%` }} />
      ) : null}
      {unconfirmedPct > 0 ? (
        <div className="h-full bg-amber" style={{ width: `${unconfirmedPct}%` }} />
      ) : null}
    </div>
  )
}

export function DebtBar({ summary }: { summary: DebtSummary }) {
  const { overall, courses, windowDays } = summary
  // 只列真的有欠账的课 —— 到期的都交了的课不占位置（少数派优先）。
  const withDebt = courses.filter((course) => course.overdue > 0 || course.unconfirmed > 0)
  const maxTotal = withDebt.reduce((max, course) => Math.max(max, course.total), 0)

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-debt-overdue={overall.overdue}
      data-debt-unconfirmed={overall.unconfirmed}
      data-debt-submitted={overall.submitted}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">已到期作业</h3>
        {overall.overdue > 0 ? (
          <span className="text-sm font-semibold text-destructive tabular-nums">
            未交 {overall.overdue}
          </span>
        ) : overall.total > 0 ? (
          <span className="text-sm text-muted-foreground">没有欠账</span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        近 {windowDays} 天 · 只统计 Canvas 作业
      </p>

      {overall.total === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          近 {windowDays} 天没有已到期的 Canvas 作业。
        </p>
      ) : (
        <>
          <div className="mt-3">
            <DebtStack counts={overall} base={overall.total} />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {overall.unconfirmed > 0 ? (
              <span className="text-amber">待确认 {overall.unconfirmed}</span>
            ) : null}
            <span className="text-muted-foreground">已交 {overall.submitted}</span>
            <span className="text-ink-faint">共 {overall.total} 件</span>
          </div>

          {withDebt.length > 0 ? (
            <ul className="mt-4 space-y-2 border-t border-line pt-3">
              {withDebt.map((course) => (
                <li key={course.courseId} className="flex items-center gap-2.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: courseColorVar(courseColorKey(course.courseId)) }}
                    aria-hidden
                  />
                  <Link
                    href={`/courses/${course.courseId}`}
                    className="w-32 shrink-0 truncate text-xs text-ink underline-offset-4 hover:underline"
                  >
                    {course.courseName}
                  </Link>
                  <div className="min-w-0 flex-1">
                    <DebtStack counts={course} base={maxTotal} />
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-destructive">
                    未交 {course.overdue}
                  </span>
                </li>
              ))}
            </ul>
          ) : overall.overdue === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">到期的都交了。</p>
          ) : null}
        </>
      )}

      <p className="mt-4 text-xs text-ink-faint">
        考试与手动任务没有外部真相（Canvas 不知道你考没考），不计入欠账 —— 分母宁可小，不能脏。
      </p>
    </div>
  )
}
