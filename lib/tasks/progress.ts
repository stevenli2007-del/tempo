import { addDays, dayKeyToUtcDate, monthDayLabel, schoolDayKey, weekdayLabel } from '@/lib/time'
import type { Task, TaskSubmissionState } from '@/types/task'

/**
 * 总览页可视化的**口径层**（P0-3-7a）。
 *
 * ### 为什么单独一层纯函数
 * 执行卡把「先定义进度的分子分母」列为 3-7 的硬前置：口径没定，既写不出代码，
 * 也没法判断"算得对不对"。收在这一处的好处是它**零 IO、零 Supabase 依赖** ——
 * 可以直接喂假数据跑（本文件末尾有可执行的自测块），将来邮件摘要（P0-3-11）也能复用同一口径。
 *
 * ### 🔴 两个消费者对「考试任务」的态度**相反**（最容易被"顺手统一"改坏的地方）
 * - **周历**要**显示**考试（`source='syllabus'` / `isDerived`）：一门课一学期只有 3-5 次考试，
 *   是天然少数派，最该被看见（「标签的价值在于标出少数派」）。
 * - **债务条**必须**排除**考试：考试没有外部真相（Canvas 不知道你考没考），
 *   把"考完忘了回来勾"算成欠账，就是诬告用户（ADR-013 / ADR-015）。
 *
 * 所以：`buildWeekCalendar()` 收全部任务，`summarizeDebt()` 第一行就 `source !== 'canvas'` 跳过。
 * **改这个文件之前先看清改的是哪一边。**
 */

/** 债务条的时间窗口（天）。30 天 ≈ 一个月，够回答"这个月我欠了什么"。 */
export const DEBT_WINDOW_DAYS = 30

/** 周历覆盖的天数（含今天）。 */
export const CALENDAR_DAYS = 7

/**
 * 债务条时间窗口的边界（ISO 串）。**取数（`loadDebtTasks`）与汇总（`summarizeDebt`）
 * 共用这一处** —— 两边各算一遍窗口迟早会漂开，那时条上的数字和取回的行对不上，
 * 而且不会报错。
 */
export function debtWindow(now: Date): { since: string; until: string } {
  return {
    since: new Date(now.getTime() - DEBT_WINDOW_DAYS * 86_400_000).toISOString(),
    until: now.toISOString(),
  }
}

/**
 * 债务条只关心这几个字段 —— 用结构类型而不是完整的 `Task`，
 * 单测可以直接喂最小对象（`Task` 天然满足它）。
 */
export type DebtInput = Pick<
  Task,
  'courseId' | 'courseName' | 'dueDate' | 'source' | 'status' | 'submissionState'
>

export type CalendarInput = Pick<
  Task,
  | 'id'
  | 'courseId'
  | 'courseName'
  | 'title'
  | 'dueDate'
  | 'taskType'
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
  return state === 'submitted' || state === 'pending_review' || state === 'graded'
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
  task: Pick<DebtInput, 'status' | 'submissionState'>,
): boolean {
  return task.status === 'done' || isCanvasDone(task.submissionState)
}

// ---------------------------------------------------------------- 债务条口径

export type DebtBucket = 'submitted' | 'overdue' | 'unconfirmed'
export interface DebtCounts {
  /** 已交：用户手勾，或 Canvas 已判定提交。 */
  submitted: number
  /** 未交：**Canvas 明确说自己没收到**（unsubmitted / missing）。 */
  overdue: number
  /** 待确认：没有外部真相（外部平台 / Canvas 不追踪），既不算已交也不算未交。 */
  unconfirmed: number
  /** 三个桶之和。 */
  total: number
}

export interface CourseDebt extends DebtCounts {
  courseId: string
  courseName: string
}

export interface DebtSummary {
  overall: DebtCounts
  /** 按「未交」降序 —— 债务条的价值在"先看见最痛的那门"。 */
  courses: CourseDebt[]
  windowDays: number
}

function emptyCounts(): DebtCounts {
  return { submitted: 0, overdue: 0, unconfirmed: 0, total: 0 }
}

function tally(counts: DebtCounts, bucket: DebtBucket): void {
  counts[bucket] += 1
  counts.total += 1
}

/**
 * 一条**已过期**的 Canvas 任务落在哪个桶。顺序即优先级。
 *
 * 三个桶互斥且穷尽 —— 这是刻意的：饼图那类"占比"图要求分段互斥，
 * 而我们的数据模型里"已提交"和"已逾期"天然可以同时成立，
 * 所以先判完成、再判未知、剩下的才是真欠账。
 */
export function classifyDebt(task: DebtInput): DebtBucket {
  // ① 完成 → 已交（用户手勾优先，ADR-015）
  if (isEffectivelyDone(task)) return 'submitted'

  // ② 没有外部真相 → 待确认。**绝不写成"未交"**（ADR-013：Canvas 不知道 ≠ 用户没交）
  //    - `external_unconfirmed`：外部平台（Gradescope），实测出现过已交却报未交（P0-3-10）
  //    - `null`：Canvas 压根不追踪完成态（not_graded 考勤 / on_paper / none）
  if (task.submissionState === 'external_unconfirmed' || task.submissionState === null) {
    return 'unconfirmed'
  }

  // ③ 剩下的只可能是 Canvas **明确说没收到**的：unsubmitted / missing。
  //    这是唯一能理直气壮称"未交"的一类 —— 也是这个条存在的全部理由。
  return 'overdue'
}

/**
 * 把一批任务汇总成债务条数据。**只统计 `source = 'canvas'`**。
 *
 * ### 分母为什么这么小（这是本卡最重要的产品判断）
 * `courses` 里没有学分、`tasks` 里没有工作量 —— 「进度」没有天然分母。
 * 退而求其次用"件数"时，分母还会**自己长大**（Canvas 只回传老师已发布的作业，
 * 老师每周新发 → 全学期口径的百分比会**倒退**，用户以为算错了）。
 * 所以口径取 **近 30 天已到期**：一旦过期，分母就冻住，剩下的全是真实欠账。
 *
 * 而**排除考试派生 / 手动任务**的理由是方向性的：那两类没有外部真相，
 * 学生考完试忘了回来勾，就会显示成"欠账" —— 这正是 ADR-013 要防的诬告。
 * **分母宁可小，不能脏。**
 */
export function summarizeDebt(tasks: DebtInput[], now: Date): DebtSummary {
  const nowMs = now.getTime()
  const sinceMs = nowMs - DEBT_WINDOW_DAYS * 86_400_000
  const overall = emptyCounts()
  const courses = new Map<string, CourseDebt>()

  for (const task of tasks) {
    // 见文件头：考试派生 / 手动任务不进债务条。
    if (task.source !== 'canvas') continue
    // 日期待定不进条 —— 没有 due 就无从判"过期"（Database.md 3.9：不编假日期）。
    if (task.dueDate === null) continue

    const dueMs = new Date(task.dueDate).getTime()
    if (Number.isNaN(dueMs)) continue
    // 未到期不是欠账。
    if (dueMs > nowMs) continue
    // 30 天以外不翻旧账。
    if (dueMs < sinceMs) continue

    const bucket = classifyDebt(task)
    tally(overall, bucket)

    let course = courses.get(task.courseId)
    if (!course) {
      course = { courseId: task.courseId, courseName: task.courseName, ...emptyCounts() }
      courses.set(task.courseId, course)
    }
    tally(course, bucket)
  }

  return {
    overall,
    courses: [...courses.values()].sort(
      (a, b) => b.overdue - a.overdue || b.total - a.total || a.courseName.localeCompare(b.courseName),
    ),
    windowDays: DEBT_WINDOW_DAYS,
  }
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
  /** 已过期且仍未完成的 —— 收成顶部一整条，不散落在过去的格子里。 */
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
export function buildWeekCalendar(tasks: CalendarInput[], now: Date): WeekCalendarModel {
  const nowMs = now.getTime()
  const todayKey = schoolDayKey(now)

  const days: CalendarDay[] = []
  const byKey = new Map<string, CalendarDay>()
  for (let i = 0; i < CALENDAR_DAYS; i++) {
    const key = addDays(todayKey, i)
    const day: CalendarDay = {
      key,
      weekday: weekdayLabel(key),
      monthDay: monthDayLabel(key),
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
        dateLabel: `${monthDayLabel(key)} ${weekdayLabel(key)}`,
        daysUntil: Math.round((dayKeyToUtcDate(key).getTime() - todayMs) / 86_400_000),
      },
      dueMs,
    })
  }

  exams.sort((a, b) => a.dueMs - b.dueMs || a.exam.title.localeCompare(b.exam.title))
  return exams.slice(0, limit).map((entry) => entry.exam)
}
