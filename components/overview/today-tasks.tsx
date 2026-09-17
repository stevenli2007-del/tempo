import Link from 'next/link'

import { courseColorKey, courseColorVar } from '@/lib/courses/course-color'
import type { TodayItem, TodayModel } from '@/lib/tasks/today'

/**
 * 总览页「今日任务」卡（P0-3-16）—— 取代原「已到期作业」债务条。
 *
 * ### 服务端组件
 * 切片、日期标签、权重全由 `buildTodayTasks()` 在**服务端**算好（客户端各算一遍
 * 时区就是 hydration mismatch，P0-3-10 的教训）。这里没有 `useState`，不带 `'use client'`。
 *
 * ### 三种行的"尾标"（口径见 `lib/tasks/today.ts`）
 * - 逾期：`逾期 N 天`（红色语境里再报百分比没有意义）。
 * - 今天：`100%`（让"今天到期算整件"这条口径**可见** —— 否则用户看不懂下面的百分比从哪来）。
 * - 未来：`N%`（= `1 / 剩余天数`，越远越轻）。
 */

function Row({ item, trailing }: { item: TodayItem; trailing: string }) {
  return (
    <li>
      <Link
        href={`/courses/${item.courseId}`}
        title={`${item.courseName} · ${item.title} · ${item.dueLabel}`}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface2"
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: courseColorVar(courseColorKey(item.courseId)) }}
          aria-hidden
        />
        <span className="w-24 shrink-0 truncate text-[11px] text-ink-faint">{item.courseName}</span>
        <span className="min-w-0 flex-1 truncate text-ink">
          {item.isExam ? <span className="mr-1 font-semibold text-lime-dark">考</span> : null}
          {item.title}
        </span>
        <span className="shrink-0 text-[11px] text-ink-faint">{item.dueLabel}</span>
        <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-ink-muted">
          {trailing}
        </span>
      </Link>
    </li>
  )
}

/** 加权工作量：整数不带小数点，否则留一位（"1.8"）。 */
function formatLoad(load: number): string {
  return Number.isInteger(load) ? String(load) : load.toFixed(1)
}

export function TodayTasks({ model }: { model: TodayModel }) {
  const { overdue, dueToday, upcoming, load, horizonDays } = model
  const isEmpty = overdue.length === 0 && dueToday.length === 0 && upcoming.length === 0

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-today-load={load}
      data-today-overdue={overdue.length}
      data-today-due={dueToday.length}
      data-today-upcoming={upcoming.length}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">今日任务</h3>
        {isEmpty ? null : (
          <span className="text-sm font-semibold tabular-nums text-ink">
            今日工作量 ≈ {formatLoad(load)} 件
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        今天到期按整件算；未来 {horizonDays} 天的按「1 / 剩余天数」折算，越远越轻
      </p>

      {isEmpty ? (
        <p className="mt-3 text-sm text-muted-foreground">
          今天没有到期的任务，接下来 {horizonDays} 天也很空。
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {overdue.length > 0 ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <p className="text-xs font-medium text-destructive">
                逾期未完成 {overdue.length}
                <span className="ml-1.5 font-normal text-muted-foreground">Canvas 确认未交的</span>
              </p>
              <ul className="mt-1">
                {overdue.map((item) => (
                  <Row key={item.id} item={item} trailing={`逾期 ${-item.daysUntil} 天`} />
                ))}
              </ul>
            </div>
          ) : null}

          {dueToday.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-ink-muted">今天到期 {dueToday.length}</p>
              <ul className="mt-1">
                {dueToday.map((item) => (
                  <Row key={item.id} item={item} trailing={`${item.weightPct}%`} />
                ))}
              </ul>
            </div>
          ) : null}

          {upcoming.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-ink-muted">
                未来 {horizonDays} 天 {upcoming.length}
              </p>
              <ul className="mt-1">
                {upcoming.map((item) => (
                  <Row key={item.id} item={item} trailing={`${item.weightPct}%`} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <p className="mt-4 text-xs text-ink-faint">
        考试与手动任务没有外部真相，不标「逾期」；点任一条进入课程页。
      </p>
    </div>
  )
}
