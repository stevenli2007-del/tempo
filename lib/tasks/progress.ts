import { addDays, dayKeyToUtcDate, monthDayLabel, schoolDayKey, weekdayLabel } from '@/lib/time'
import type { Lang } from '@/lib/i18n/types'
import type { Task, TaskSubmissionState } from '@/types/task'

/**
 * 总览页可视化的**口径层**（P0-3-7a）。
 *
 * ### 为什么单独一层纯函数
 * 执行卡把「先定义进度的分子分母」列为 3-7 的硬前置：口径没定，既写不出代码，
 * 也没法判断"算得对不对"。收在这一处的好处是它**零 IO、零 Supabase 依赖** ——
 * 可以直接喂假数据跑（`scripts/regress-progress.ts` 就是拿夹具钉它）。
 * 「今日任务」切片（P0-3-16）与提醒引擎（P0-3-14）都复用这里的完成判定，不另写一份。
 *
 * ### 🔴 完成判定只有一个来源（别在别处再写一遍 `status === 'done'`）
 * `isCanvasDone()`（Canvas 真相轴）与 `isEffectivelyDone()`（用户手勾 ∪ Canvas 真相）
 * 是全站唯一判定：待办清单、周历、课程页、提醒引擎、今日任务都调它。
 * 曾经三处各写一份 → 出现"分组说已完成、行内却画空勾选框"的自相矛盾，
 * 而 `tsc` / `eslint` / `build` 全绿（P0-3-15 的教训，见 `CodingRules.md` §10.1 第 21 条）。
 *
 * 注：`source='canvas'` 的欠账统计（原「已到期作业」债务条）已于 P0-3-16 删除，
 * 总览页改用「今日任务」的加权切片（`lib/tasks/today.ts`）。
 */

/** 周历覆盖的天数（含今天）。 */
export const CALENDAR_DAYS = 7

export type CalendarInput = Pick<
  Task,
  | 'id'
  | 'courseId'
  | 'courseName'
  | 'title'
  | 'dueDate'
  | 'taskType'
  | 'source'
  | 'status'
  | 'submissionState'
  | 'isDerived'
>

/**
 * 是不是考试派生任务。**周历的 lime 块与「最近的考试」条共用这一个判据。**
 *
 * 用 `taskType` 而不是 `isDerived`：Phase 0 两者等价（`exam-tasks.ts` 写 `task_type='exam'`
 * 且 `is_derived=true`），但 `is_derived` 的语义是"这行是派生的缓存"，
 * 将来出现**非考试**的派生任务（如 Phase 2 的 routine）时，用它会误判成考试。
 */
export function isExamTask(task: Pick<Task, 'taskType'>): boolean {
  return task.taskType === 'exam'
}

// ---------------------------------------------------------------- 完成判定

/**
 * Canvas 判定「已完成」的三个提交态（ADR-015 的外部真相轴）。
 *
 * 🔴 **与 `isCanvasDone()` 同源** —— 这是本卡（P0-3-35）刻意加的：
 * 总览取数要在 SQL 侧排除「已完成的历史」，就得拼
 * `submission_state.not.in.(submitted,pending_review,graded)`；
 * 若那一处另抄一遍三个字符串，就是 P0-3-15 那类「两处都绿、肉眼才看得出」的分叉
 * （将来加一个态 → SQL 与界面口径悄悄打架）。所以常量在这里，两边都读它。
 */
export const CANVAS_DONE_STATES: readonly TaskSubmissionState[] = [
  'submitted',
  'pending_review',
  'graded',
]

/**
 * Canvas 是否**已判定完成**这条任务（外部真相轴，ADR-015）。
 *
 * 三个值都算完成：`submitted`（交了）、`pending_review`（交了、待查重）、
 * `graded`（评完了）。**顺序即语义**：只要 Canvas 收到了作业，用户就不该再被催。
 *
 * ### 🔴 为什么必须单独抽一个函数（P0-3-15）
 * 这个三值 OR 原先在**三处各写了一份**：本文件的 `isEffectivelyDone`、
 * `app/(routes)/dashboard/page.tsx` 的 `canvasCompleted`、
 * `lib/courses/course-list.ts` 的 `canvasCompleted`。
 * 三份副本里只要有一处漏掉 `pending_review`，就会出现"总览页说已完成、课程页还算逾期"
 * 这类自相矛盾 —— 而这种矛盾**不会报错**，只会让用户不再信任页面上的任何数字。
 *
 * **故意不含**：
 * - `external_unconfirmed` —— 外部平台（Gradescope）没有可信记录，ADR-013；
 * - `null` —— Canvas 压根不追踪完成态（on_paper / not_graded / 考试派生）；
 * - `unsubmitted` / `missing` —— Canvas 明确说没收到，正是要催的那一类。
 */
export function isCanvasDone(state: TaskSubmissionState | null): boolean {
  if (state === null) return false
  return CANVAS_DONE_STATES.includes(state)
}

/**
 * 「这条任务算不算做完了」——**全站唯一的判定**（P0-3-7 提为共享函数，在此之前
 * `dashboard/page.tsx` 与 `task-list.tsx` 各写了一份，很容易只改一处）。
 *
 * 两个来源**合并**，缺一不可：
 * - `status === 'done'` —— 用户手勾的，**永远是最高优先**（ADR-015：status 归用户主权）；
 * - `isCanvasDone()` —— Canvas 已判定完成，外部真相。
 *
 * **故意不含** `external_unconfirmed`：外部平台（Gradescope）没有可信记录时我们**不知道**
 * 交没交，把它当"已完成"是猜，当"未完成"是诬告 —— 它只能是第三态（ADR-013）。
 * `missing` / `unsubmitted` 同理留给调用方按语境处理。
 */
export function isEffectivelyDone(
  task: Pick<Task, 'status' | 'submissionState'>,
): boolean {
  return task.status === 'done' || isCanvasDone(task.submissionState)
}

// ---------------------------------------------------------------- 「需手动确认」

/**
 * 这条任务我们**判断不了完成态**，需要用户自己确认（P0-3-17）。
 *
 * ### 判据只有一条：**Canvas 自己说不追踪**
 * `source === 'canvas'`（这条是 Canvas 同步进来的）**且** `submissionState === null`。
 *
 * `deriveSubmission()` 在这三种情况下落 null：
 * ① `submission_types` 含 `none` / `not_graded` / `on_paper`（考勤打卡、纸质作业、mentor form）；
 * ② 没有内联 submission 且不是 `external_tool`；
 * ③ submission 的 `workflow_state` 是我们不认识的取值。
 * 三种的共同点：**Canvas 明确表示它这里没有可信的完成信号**。标「已逾期」就是诬告
 * （ADR-013：Canvas 不知道 ≠ 用户没交 —— `Lecture 1 - Airbags (makeup form)` 正是这类）。
 *
 * ### 🔴 为什么必须带 `source === 'canvas'`，而不是只看 `submissionState === null`
 * `null` 是个**共用取值**，它同时装着另外两类任务：
 * - `source = 'syllabus'` 的**考试派生任务**（`exam_dates` → tasks）—— Canvas 压根没见过它们，
 *   这里的 null 不是"Canvas 不追踪"，而是"**与 Canvas 无关**"；
 * - `source = 'manual'` 的用户自建任务 —— 同上。
 *
 * 只看 `submissionState === null` 会把上面两类一起吞进来，后果是**全部考试不再被提醒**
 * （`isRemindable` 也用它）—— 一学期只有 3-5 场的高风险事项因为"没有外部真相"就静默了，
 * 这正是 `lib/reminders/build.ts` 文件头专门写了一段警告要避免的事。
 * 考试与手动任务的 null 表示"**该由用户自己勾**"，而不是"我们不敢判断"。
 *
 * ### 用它做什么（三件事，必须同时做，否则又是不一致）
 * ① 徽标显示灰色「需手动确认」（不是空框、也不是红）；
 * ② **不标红「已逾期」**（周历逾期条 + 待办清单）；
 * ③ **不进提醒邮件**（`isRemindable`）。
 * 三项共用本函数 —— 只做其中一两项就会出现"清单不标红、邮件却催"这类自相矛盾。
 */
export function needsManualConfirmation(
  task: Pick<Task, 'source' | 'submissionState'>,
): boolean {
  return task.source === 'canvas' && task.submissionState === null
}

// ---------------------------------------------------------------- 逾期资格

/**
 * 这条任务**够格被标「已逾期」**吗？（只判状态轴，日期由调用方自己比。）
 *
 * ### 为什么必须是一个独立函数（P0-3-17 顺手修的 P0-3-16 遗留）
 * 「已逾期」是本项目里**最容易变成诬告**的三个字：它断言"你该交的没交"。
 * 而它的判据在四个地方各自出现过：周历逾期条、总览页待办清单、课程卡近期任务、
 * 课程页作业详情。P0-3-16 只改了其中一处（总览页红组），于是当时就留下了
 * 「周历说逾期、今日任务说没事」的自相矛盾 —— 同一个页面上的两条信息打架。
 *
 * 收成一个函数之后，**改口径就是改这里**。
 *
 * ### 四种不能标的情况（每一种都有实测或 ADR 依据）
 * 1. `status === 'done'` —— 用户自己说做完了（用户主权最高，ADR-015）；
 * 2. `isCanvasDone()` —— Canvas 已收到/已评分；
 * 3. `external_unconfirmed` —— 外部平台（Gradescope）交的，Canvas 的"未交"只是**推断**，
 *    实测出现过假阴性（Lab 1: Airbags 已交却报未交，ADR-013）；
 * 4. `needsManualConfirmation()` —— Canvas 明说它不追踪这条（on_paper / none / not_graded）。
 *
 * **刻意保留为真**的：`source='syllabus'` 的考试与手动任务（`null` 态）——
 * 它们的日期来自**用户自己的** syllabus，说"这个日子过了"是陈述用户自己的记录，
 * 不是替第三方下结论。只有这类任务才该在过期后继续显眼。
 */
export function canBeOverdue(
  task: Pick<Task, 'status' | 'source' | 'submissionState'>,
): boolean {
  if (task.status === 'done') return false
  if (isCanvasDone(task.submissionState)) return false
  if (task.submissionState === 'external_unconfirmed') return false
  if (needsManualConfirmation(task)) return false
  return true
}

// ---------------------------------------------------------------- 周历口径

export interface CalendarPill {
  id: string
  title: string
  courseId: string
  courseName: string
  /** 考试派生任务 → 用 lime 实心块（少数派，值得抢眼）。 */
  isExam: boolean
  /** 这条任务**自己的截止时刻**已过（当天 10:00 截止、现在 15:00 也算）。 */
  isOverdue: boolean
}

export interface CalendarDay {
  /** `YYYY-MM-DD`（学校时区），也是 React key。 */
  key: string
  /** 「周一」。 */
  weekday: string
  /** 「9/13」。 */
  monthDay: string
  isToday: boolean
  pills: CalendarPill[]
}

export interface WeekCalendarModel {
  /** 滚动 7 天，**今天在最左**。 */
  days: CalendarDay[]
  /**
   * 已过期且仍未完成的 —— 收成顶部一整条，不散落在过去的格子里。
   * **只收够格标逾期的**（`canBeOverdue()`，P0-3-17）：Canvas 已判定完成、
   * 外部平台无记录、Canvas 明说不追踪的三类都不进来 —— 那些在待办清单与课程页里仍看得见。
   */
  overdue: CalendarPill[]
  /** 没有截止日期的（考试 TBD 等）—— 底部单列，**不编日期塞进格子**。 */
  undated: CalendarPill[]
}

function toPill(task: CalendarInput, nowMs: number): { pill: CalendarPill; dueMs: number | null } {
  const dueMs = task.dueDate === null ? null : new Date(task.dueDate).getTime()
  const valid = dueMs !== null && !Number.isNaN(dueMs)
  return {
    pill: {
      id: task.id,
      title: task.title,
      courseId: task.courseId,
      courseName: task.courseName,
      isExam: isExamTask(task),
      isOverdue: valid && dueMs < nowMs,
    },
    dueMs: valid ? dueMs : null,
  }
}

/**
 * 建周历模型。**收全部任务**（含考试），只过滤掉已完成的。
 *
 * ### 为什么用「滚动 7 天」而不是「本周一–周日」
 * 按学校节奏对齐听起来更对，但周日打开会看到一个基本空的日历 —— 第一印象就废了。
 * 滚动窗口的每一天都有内容可看。
 *
 * ### 逾期为什么收成顶部一整条
 * 过去的日子**没人会往回翻**。把逾期任务散落在上个月的格子里，等于把它们藏起来，
 * 与 Tempo「不隐藏问题」的原则冲突。
 */
export function buildWeekCalendar(
  tasks: CalendarInput[],
  now: Date,
  lang: Lang = 'zh',
): WeekCalendarModel {
  const nowMs = now.getTime()
  const todayKey = schoolDayKey(now)

  const days: CalendarDay[] = []
  const byKey = new Map<string, CalendarDay>()
  for (let i = 0; i < CALENDAR_DAYS; i++) {
    const key = addDays(todayKey, i)
    const day: CalendarDay = {
      key,
      weekday: weekdayLabel(key, lang),
      monthDay: monthDayLabel(key, lang),
      isToday: i === 0,
      pills: [],
    }
    days.push(day)
    byKey.set(key, day)
  }

  const overdue: { pill: CalendarPill; dueMs: number }[] = []
  const undated: CalendarPill[] = []
  const perDay = new Map<string, { pill: CalendarPill; dueMs: number }[]>()

  for (const task of tasks) {
    // 已完成的不进日历：日历回答"接下来做什么"，做完的事在下方清单的折叠盒里。
    // 与 TaskList 共用同一个判定函数，避免"日历显示已交的、清单却不显示"。
    if (isEffectivelyDone(task)) continue

    const { pill, dueMs } = toPill(task, nowMs)

    if (dueMs === null) {
      // 含"坏日期"（NaN）—— 当日期待定处理：不编日期，也不静默丢掉这一行。
      undated.push(pill)
      continue
    }

    const day = byKey.get(schoolDayKey(new Date(dueMs)))
    if (day) {
      const list = perDay.get(day.key)
      if (list) list.push({ pill, dueMs })
      else perDay.set(day.key, [{ pill, dueMs }])
    } else if (dueMs < nowMs) {
      // 落在 7 天窗口之外、且已过期 → 顶部逾期条。
      //
      // 🔴 P0-3-17：「够不够格标逾期」收在 `canBeOverdue()` 一处（原先这里收**全部来源**，
      //    于是 `makeup form` 这类 Canvas 明说不追踪的任务被标「已逾期 16 天」，
      //    与总览页红组的口径打架 —— P0-3-16 留下的不一致，本卡修掉）。
      //    不够格的任务在**下方待办清单**与**课程页作业详情**里仍然看得见
      //    （只是标灰色的「需手动确认」），所以这不是"把它藏起来"，而是"不给它贴假结论"。
      if (!canBeOverdue(task)) continue
      overdue.push({ pill, dueMs })
    }
    // 落在窗口之外、且未到期 → 不进周历（周历只覆盖 7 天，这是刻意的）。
    // 这类任务在下方「全部待办」清单里仍然看得见，不会消失。
  }

  for (const day of days) {
    const list = perDay.get(day.key)
    if (!list) continue
    // 同一天内按截止时刻升序 —— 早上先说事。
    list.sort((a, b) => a.dueMs - b.dueMs || a.pill.title.localeCompare(b.pill.title))
    day.pills = list.map((entry) => entry.pill)
  }

  // 逾期条：最近逾期的在最前（欠得新鲜的先处理）。
  overdue.sort((a, b) => b.dueMs - a.dueMs || a.pill.title.localeCompare(b.pill.title))

  return { days, overdue: overdue.map((entry) => entry.pill), undated }
}

// ---------------------------------------------------------------- 最近的考试

export interface UpcomingExam {
  id: string
  title: string
  courseId: string
  courseName: string
  /** 「10/20 周二」—— 服务端算好，客户端算时区会 hydration mismatch。 */
  dateLabel: string
  /** 距今天数，0 = 今天。从**日历键**相减得出，不受时区偏移/夏令时影响。 */
  daysUntil: number
}

/** 「最近的考试」默认列几条。 */
export const EXAM_LOOKAHEAD = 3

/**
 * 「最近的考试」条 —— **故意不受 7 天窗口限制**。
 *
 * ### 为什么必须有这一条（实测触发的）
 * 7 天滚动窗口对作业够用（每周都有），但对考试**完全不够**：2026-09-13 实测，
 * Steven 的 4 场考试全部在 7 天之外（最近一场 Unit 1 Exam 在 9/22，还有 9 天）。
 * 也就是说只做周历的话，日历里**一场考试都看不到** —— 执行卡要求的
 * 「考试日期并进主 Calendar」等于没兑现。
 *
 * 而考试恰恰是**最稀疏、最高风险**的一类事项：一门课一学期只有 3-5 次，
 * 错过一次的代价远大于漏做一个作业。所以给它单独一条，且看得比 7 天更远。
 */
export function buildUpcomingExams(
  tasks: CalendarInput[],
  now: Date,
  limit = EXAM_LOOKAHEAD,
  lang: Lang = 'zh',
): UpcomingExam[] {
  const todayKey = schoolDayKey(now)
  const todayMs = dayKeyToUtcDate(todayKey).getTime()
  const nowMs = now.getTime()
  const exams: { exam: UpcomingExam; dueMs: number }[] = []

  for (const task of tasks) {
    if (!isExamTask(task)) continue
    // 已完成的考试（用户考完勾掉了）不再提醒。
    if (isEffectivelyDone(task)) continue
    if (task.dueDate === null) continue // 日期待定 → 留着在周历底部的「日期待定」行
    const dueMs = new Date(task.dueDate).getTime()
    if (Number.isNaN(dueMs) || dueMs < nowMs) continue // 已过去的不叫"最近要考的"

    const key = schoolDayKey(new Date(dueMs))
    exams.push({
      exam: {
        id: task.id,
        title: task.title,
        courseId: task.courseId,
        courseName: task.courseName,
        dateLabel: `${monthDayLabel(key, lang)} ${weekdayLabel(key, lang)}`,
        daysUntil: Math.round((dayKeyToUtcDate(key).getTime() - todayMs) / 86_400_000),
      },
      dueMs,
    })
  }

  exams.sort((a, b) => a.dueMs - b.dueMs || a.exam.title.localeCompare(b.exam.title))
  return exams.slice(0, limit).map((entry) => entry.exam)
}
