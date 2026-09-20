import Link from 'next/link'

import { EXAM_SURFACE_CLASS, ExamMark } from '@/components/tasks/exam-mark'
import { courseColorClasses, courseColorKey } from '@/lib/courses/course-color'
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
 *
 * ### P0-3-33：两处"看不出来"的修正
 * ① **课程色**从一颗 2px 圆点升级成「左侧整高色边 + 染色的课程名 chip」——
 *    圆点太小，扫一列看不出哪几行是同一门课（Steven 2026-09-20 反馈）。
 *    色值仍是 `courseColorKey(courseId)` 的确定性映射，与课程卡 / 周历**同一门课同一个颜色**。
 * ② **考试整行铺考试底** + 图标 + 「考」—— 之前只有一个绿字「考」前缀，
 *    夹在作业里几乎认不出（Steven：「考试和作业几乎没差别」）。判定仍只用
 *    `TodayItem.isExam`（来自 `isExamTask()` 一处），这里不新增任何判定。
 */

/**
 * 一行任务。**两个链接分开**（P0-3-17）：
 * - **课程名** → 课程详情页（看这门课的全部信息）；
 * - **任务名** → Canvas 作业页（`canvasUrl` 有值时），否则退回课程详情页。
 *
 * ⚠️ 不能像 P0-3-16 那样"整行包一个 `<Link>`"再往里塞 Canvas 外链 ——
 * HTML 不允许 `<a>` 嵌套 `<a>`（React 会按 hydration 报错/浏览器会拆开标签）。
 * 所以外层是普通 `li`，两个链接各自承担一个动作。
 */
function Row({ item, trailing }: { item: TodayItem; trailing: string }) {
  const courseHref = `/courses/${item.courseId}`
  const titleClass = 'truncate text-ink underline-offset-4 hover:underline'
  const color = courseColorClasses(courseColorKey(item.courseId))

  /**
   * 行的底色：考试行整行铺考试底（P0-3-33），其余行只在 hover 时变色。
   * ⚠️ 两条分支必须**各自**给出 hover 底色 —— 若考试行留着通用的 `hover:bg-surface2`，
   * 鼠标一上去考试底就被抹掉，用户会以为"高亮消失了"。
   */
  const rowTone = item.isExam
    ? `${EXAM_SURFACE_CLASS} hover:bg-lime/20`
    : 'hover:bg-surface2'

  return (
    <li
      className={`flex items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-sm ${color.edge} ${rowTone}`}
    >
      <Link
        href={courseHref}
        title={`查看「${item.courseName}」课程详情`}
        className={`w-24 shrink-0 truncate rounded-badge px-1.5 py-0.5 text-center text-[11px] underline-offset-4 hover:underline ${color.chip}`}
      >
        {item.courseName}
      </Link>
      {/* 考试标记（P0-3-33）：不给整行铺底的旧版本这里只有一个绿字「考」，
          与作业行几乎无从分辨。三件套 = 底色（整行）+ 边框 + 图标 + 「考」。
          放在标题链接**外面**：标题带 `truncate`（overflow:hidden），
          塞进去的长标题会把标记切掉一半。 */}
      {item.isExam ? <ExamMark bare /> : null}
      {item.canvasUrl ? (
        <a
          href={item.canvasUrl}
          target="_blank"
          rel="noreferrer"
          title={`在 Canvas 打开「${item.title}」`}
          className={`min-w-0 flex-1 ${titleClass}`}
        >
          {item.title}
        </a>
      ) : (
        <Link
          href={courseHref}
          title={`${item.courseName} · ${item.title} · ${item.dueLabel}`}
          className={`min-w-0 flex-1 ${titleClass}`}
        >
          {item.title}
        </Link>
      )}
      <span className="shrink-0 text-[11px] text-ink-faint">{item.dueLabel}</span>
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-ink-muted">
        {trailing}
      </span>
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
        考试与手动任务没有外部真相，不标「逾期」；点<strong className="font-medium">课名</strong>
        进课程页，点<strong className="font-medium">任务名</strong>去 Canvas。
      </p>
    </div>
  )
}
