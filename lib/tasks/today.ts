import { dayKeyToUtcDate, monthDayLabel, schoolDayKey, weekdayLabel } from '@/lib/time'
import type { Lang } from '@/lib/i18n/types'
import { isEffectivelyDone, isExamTask } from '@/lib/tasks/progress'
import type { Task } from '@/types/task'

/**
 * 总览页「今日任务」的**口径层**（P0-3-16）—— 取代原「已到期作业」债务条。
 *
 * ### 它回答什么（与债务条的区别）
 * 债务条回答"我**欠**了多少"（只看**已经过去**的 Canvas 未交作业）；本卡回答
 * "今天大概要花多少力气"：
 * - **今天到期** → 算整件（100%）；
 * - **未来 `horizonDays` 天内** → 按 `1 / 剩余天数` 折算（9/17 看 9/21 到期 = 1/4 = 25%）；
 * - **逾期未完成** → 各算一件，收进顶部红组。
 * 三者相加即"今日工作量"（一个**加权件数**）—— 越远的事，对今天的压力越小。
 *
 * ### 权重为什么是 `1 / 剩余天数`
 * `tasks` 没有"工作量"字段，最朴素的假设是"把这件事平摊到它到期前的每一天，
 * 今天该摊到 1/N"。今天到期（N=0）与明天到期（N=1）都记整件 —— 你只剩今天能动手。
 *
 * ### 🔴 边界（ADR-013 / ADR-015）
 * - **红组只收 Canvas 明确说没交的**（`submissionState ∈ {unsubmitted, missing}`）。
 *   `null`（Canvas 不追踪：`on_paper` / `none` / 考试派生）与 `external_unconfirmed`
 *   （Gradescope 等 LTI）**不进红组** —— Canvas 不知道你交没交，标红就是诬告
 *   （`Lecture 1 Airbags makeup form` 正是这一类；它归 P0-3-17 的「需手动确认」）。
 * - 已完成（`isEffectivelyDone()`）一律不进（与周历、待办清单**共用同一个判定**）。
 * - **纯计算、零 IO、不改任何状态** —— `status` / `submission_state` 只读（ADR-015 红线）。
 */

/**
 * 「今日任务」向未来看的天数。**必须 ≤ 总览页取数窗口**
 * （`dashboard/page.tsx` 的 `OVERVIEW_RANGE_DAYS`，同为 7）—— 否则会切出总览根本没取回的日期。
 */
export const TODAY_HORIZON_DAYS = 7

export type TodayInput = Pick<
  Task,
  | 'id'
  | 'courseId'
  | 'courseName'
  | 'title'
  | 'dueDate'
  | 'taskType'
  | 'status'
  | 'submissionState'
  | 'canvasUrl'
>

export interface TodayItem {
  id: string
  courseId: string
  courseName: string
  title: string
  /** 「9/21 周一」。 */
  dueLabel: string
  /** 距今天数（按学校本地日历日）：0 = 今天，负数 = 已过期。 */
  daysUntil: number
  /** 归一化权重：今天 / 明天 / 逾期 = 1；再远 = 1 / 剩余天数。 */
  weight: number
  /** 展示用整数百分比（100 / 50 / 33 / 25 …）。 */
  weightPct: number
  isExam: boolean
  /**
   * Canvas 作业页地址（P0-3-17）。有值时任务名是外链；null 时退回跳课程页。
   * 与总览清单、课程页作业详情**同一套口径**（点任务名 = 去源头看）。
   */
  canvasUrl: string | null
}

export interface TodayModel {
  /** 逾期**且 Canvas 确认未交**的 —— 红组，置顶。 */
  overdue: TodayItem[]
  /** 今天到期（整件）。 */
  dueToday: TodayItem[]
  /** 未来 `horizonDays` 天内到期（按 1/剩余天数 折算）。 */
  upcoming: TodayItem[]
  /** 今日加权工作量 = Σ weight。 */
  load: number
  horizonDays: number
}

/** Canvas **明确说没收到**的两种提交态 —— 只有它们够格进红组（ADR-013）。 */
const CONFIRMED_UNSUBMITTED = new Set(['unsubmitted', 'missing'])

export function buildTodayTasks(
  tasks: TodayInput[],
  now: Date,
  horizonDays = TODAY_HORIZON_DAYS,
  lang: Lang = 'zh',
): TodayModel {
  const todayKey = schoolDayKey(now)
  const todayMs = dayKeyToUtcDate(todayKey).getTime()

  const overdue: { item: TodayItem; dueMs: number }[] = []
  const dueToday: { item: TodayItem; dueMs: number }[] = []
  const upcoming: { item: TodayItem; dueMs: number }[] = []

  for (const task of tasks) {
    // 已完成的不进（与周历 / 清单同源判定）。
    if (isEffectivelyDone(task)) continue
    // 无日期（含坏日期）无从切片 —— 它们在周历底部「日期待定」与清单里仍然看得见。
    if (task.dueDate === null) continue
    const dueMs = new Date(task.dueDate).getTime()
    if (Number.isNaN(dueMs)) continue

    const dayKey = schoolDayKey(new Date(dueMs))
    // 按**日历键**相差天数 —— 不受时区偏移 / 夏令时影响（CodingRules §10.2）。
    const daysUntil = Math.round((dayKeyToUtcDate(dayKey).getTime() - todayMs) / 86_400_000)

    // 视野外（更远的未来）不进。逾期不限下界：欠着的就该被看见。
    if (daysUntil > horizonDays) continue

    const weight = daysUntil <= 0 ? 1 : 1 / daysUntil
    const item: TodayItem = {
      id: task.id,
      courseId: task.courseId,
      courseName: task.courseName,
      title: task.title,
      dueLabel: `${monthDayLabel(dayKey, lang)} ${weekdayLabel(dayKey, lang)}`,
      daysUntil,
      weight,
      weightPct: Math.round(weight * 100),
      isExam: isExamTask(task),
      canvasUrl: task.canvasUrl,
    }

    if (daysUntil < 0) {
      // 🔴 只收 Canvas 确认未交的 —— 其余（null / external_unconfirmed）不是"未交"，是"不知道"。
      if (!CONFIRMED_UNSUBMITTED.has(task.submissionState ?? '')) continue
      overdue.push({ item, dueMs })
    } else if (daysUntil === 0) {
      dueToday.push({ item, dueMs })
    } else {
      upcoming.push({ item, dueMs })
    }
  }

  // 排序：逾期最近优先（欠得新鲜的先处理）；今天按时刻升序；未来按剩余天数升序。
  overdue.sort((a, b) => b.dueMs - a.dueMs || a.item.title.localeCompare(b.item.title))
  dueToday.sort((a, b) => a.dueMs - b.dueMs || a.item.title.localeCompare(b.item.title))
  upcoming.sort(
    (a, b) => a.item.daysUntil - b.item.daysUntil || a.item.title.localeCompare(b.item.title),
  )

  const load =
    overdue.reduce((sum, entry) => sum + entry.item.weight, 0) +
    dueToday.reduce((sum, entry) => sum + entry.item.weight, 0) +
    upcoming.reduce((sum, entry) => sum + entry.item.weight, 0)

  return {
    overdue: overdue.map((entry) => entry.item),
    dueToday: dueToday.map((entry) => entry.item),
    upcoming: upcoming.map((entry) => entry.item),
    load,
    horizonDays,
  }
}
