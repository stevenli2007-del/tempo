/**
 * P0-3-7 回归：总览可视化的**口径层**（`lib/tasks/progress.ts`）四件事都对 ——
 * 债务条的三个桶、周历的分桶与窗口、最近的考试条的取用与排序，
 * 以及 P0-3-15 加的**完成判定与提交态徽标**（`isCanvasDone` / `isEffectivelyDone` /
 * `submissionBadge`）。
 *
 * 运行：`npm run regress:progress`（**纯函数，不需要网络，不需要 env**，秒级）
 *
 * ### 为什么值得单独一个回归脚本
 * 口径是整个 3-7 里唯一「算错了没人看得出来」的地方：页面照样渲染，数字也长得像真的
 * （曾经写错一次就会把考试算进欠账，而 UI 上看不出任何异常）。
 * 而它的输入是纯数据 —— 最适合用固定夹具钉死，不依赖真实数据库。
 *
 * 夹具里的日期都相对 `NOW = 2026-09-13 15:48 PDT` 构造，断言写的是**语义**
 * （"今晚到期归 9/13"、"9/22 的考试还有 9 天"），所以将来改时区/改窗口会立刻暴露。
 */
import {
  buildUpcomingExams,
  buildWeekCalendar,
  classifyDebt,
  isCanvasDone,
  isEffectivelyDone,
  summarizeDebt,
} from '@/lib/tasks/progress'
import { SUBMISSION_BADGE_CLASS, submissionBadge } from '@/lib/tasks/submission'
import type { Task, TaskSubmissionState } from '@/types/task'

const NOW = new Date('2026-09-13T22:48:32Z') // 2026-09-13 15:48 PDT

const PAST = '2026-09-10T23:59:00-07:00' // 3 天前
const OLD = '2026-07-01T23:59:00-07:00' // 74 天前（债务条窗口外）
const TOO_FAR = '2026-09-20T23:59:00-07:00' // 周历窗口外、且未到期
const TONIGHT = '2026-09-13T23:59:00-07:00' // 今晚（= 09-14T06:59Z —— P0-3-10 的"差一天"用例）

let seq = 0
function mk(over: Partial<Task>): Task {
  seq += 1
  return {
    id: `t${seq}`,
    courseId: 'c1',
    courseName: 'CHEM 1A',
    title: `任务 ${seq}`,
    dueDate: null,
    taskType: 'assignment',
    source: 'canvas',
    status: 'pending',
    isDerived: false,
    submissionState: 'unsubmitted',
    submittedAt: null,
    ...over,
  }
}

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
}

// ---------------------------------------------------------------- 债务条

const debtTasks: Task[] = [
  mk({ title: 'A 未交', dueDate: PAST, submissionState: 'unsubmitted' }), // overdue
  mk({ title: 'B 缺交', dueDate: PAST, submissionState: 'missing' }), // overdue
  mk({ title: 'C 已评分', dueDate: PAST, submissionState: 'graded' }), // submitted
  mk({ title: 'D 待查重', dueDate: PAST, submissionState: 'pending_review' }), // submitted
  mk({ title: 'E 外部平台', dueDate: PAST, submissionState: 'external_unconfirmed' }), // unconfirmed
  mk({ title: 'F 不追踪', dueDate: PAST, submissionState: null }), // unconfirmed
  mk({ title: 'G 手勾', dueDate: PAST, status: 'done', submissionState: 'unsubmitted' }), // submitted
  mk({ title: 'H 考试派生', dueDate: PAST, source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }), // 排除（ADR-013）
  mk({ title: 'I 手动', dueDate: PAST, source: 'manual', submissionState: null }), // 排除
  mk({ title: 'J 无日期', dueDate: null }), // 排除（不编日期）
  mk({ title: 'K 未到期', dueDate: TOO_FAR }), // 排除
  mk({ title: 'L 太旧', dueDate: OLD }), // 排除（30 天窗口外）
  mk({ title: 'M 今晚到期', dueDate: TONIGHT }), // 排除（还没到期）
  mk({ title: 'N 课程2未交', dueDate: PAST, courseName: 'MATH 53', courseId: 'c2' }),
  mk({ title: 'O 三天后考试', dueDate: '2026-09-16T23:59:00-07:00', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: 'P 明天到期', dueDate: '2026-09-14T23:59:00-07:00' }),
  mk({ title: 'Q 最后一天', dueDate: '2026-09-19T23:59:00-07:00' }),
  mk({ title: 'R 已完成的过期作业', dueDate: PAST, status: 'done', submissionState: 'graded' }),
]

check(
  '债务条三桶互斥穷尽：已交 4 / 未交 3 / 待确认 2（考试、手动、无日期、未到期、30 天外全部排除）',
  JSON.stringify(summarizeDebt(debtTasks, NOW).overall) ===
    JSON.stringify({ submitted: 4, overdue: 3, unconfirmed: 2, total: 9 }),
  JSON.stringify(summarizeDebt(debtTasks, NOW).overall),
)

const debtCourses = summarizeDebt(debtTasks, NOW).courses
check(
  '课程排序按未交降序（CHEM 1A 未交 2 在 MATH 53 未交 1 之前）',
  debtCourses[0]?.courseName === 'CHEM 1A' && debtCourses[1]?.courseName === 'MATH 53',
  debtCourses.map((c) => `${c.courseName}:${c.overdue}`).join(' , '),
)

check('classifyDebt：unsubmitted/missing → 未交', classifyDebt(debtTasks[0]) === 'overdue' && classifyDebt(debtTasks[1]) === 'overdue')
check('classifyDebt：graded / 手勾 → 已交', classifyDebt(debtTasks[2]) === 'submitted' && classifyDebt(debtTasks[6]) === 'submitted')
check('classifyDebt：external_unconfirmed / NULL → 待确认（绝不显示"未交"）', classifyDebt(debtTasks[4]) === 'unconfirmed' && classifyDebt(debtTasks[5]) === 'unconfirmed')

// ---------------------------------------------------------------- 周历

const calendar = buildWeekCalendar(debtTasks, NOW)
check(
  '周历为滚动 7 天且今天在最左（9/13 周日 → 9/19 周六）',
  calendar.days.length === 7 &&
    calendar.days[0].key === '2026-09-13' &&
    calendar.days[0].weekday === '周日' &&
    calendar.days[0].isToday &&
    calendar.days[6].key === '2026-09-19' &&
    calendar.days[6].weekday === '周六',
  calendar.days.map((d) => `${d.weekday}(${d.monthDay})`).join(' '),
)
check(
  '时区：今晚 23:59 PDT 到期的作业归 9/13（不是 9/14）',
  calendar.days[0].pills.some((p) => p.title === 'M 今晚到期'),
  calendar.days[0].pills.map((p) => p.title).join(' , ') || '（空）',
)
check(
  '考试进日历且标 isExam（9/16 的 O），非考试任务不标',
  calendar.days[3]?.pills.find((p) => p.title === 'O 三天后考试')?.isExam === true &&
    calendar.days[3]?.pills.find((p) => p.title === 'P 明天到期') === undefined,
)
check(
  '逾期的收在顶部整条，不散落在过去的格子里（A/B/E/F/H/I/N/L，按最近优先）',
  calendar.overdue.length === 8 &&
    !calendar.overdue.some((p) => p.title.startsWith('G') || p.title.startsWith('R')) &&
    calendar.overdue.every((p) => !calendar.days.some((d) => d.pills.some((x) => x.id === p.id))),
  calendar.overdue.map((p) => p.title).join(' , '),
)
check('无截止日期的收进「日期待定」，不编日期塞进格子', calendar.undated.length === 1 && calendar.undated[0].title === 'J 无日期')
check(
  '已完成的不进日历（手勾的 G、Canvas 已评分的 R）',
  ![...calendar.days.flatMap((d) => d.pills), ...calendar.overdue, ...calendar.undated].some(
    (p) => p.title.startsWith('G ') || p.title.startsWith('R '),
  ),
)
check(
  '窗口外未到期的（K，9/20）不进日历 —— 周历只覆盖 7 天',
  !calendar.days.some((d) => d.pills.some((p) => p.title === 'K 未到期')) &&
    !calendar.overdue.some((p) => p.title === 'K 未到期'),
)

// ---------------------------------------------------------------- 最近的考试

const examTasks: Task[] = [
  mk({ title: 'Final Exam', dueDate: '2026-12-14T23:59:59Z', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: 'Unit 1 Exam', dueDate: '2026-09-22T23:59:59Z', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: 'Unit 2 Exam', dueDate: '2026-10-20T23:59:59Z', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: 'Unit 3 Exam', dueDate: '2026-11-10T23:59:59Z', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: '已考完的 Exam', dueDate: '2026-09-01T23:59:59Z', source: 'syllabus', taskType: 'exam', isDerived: true, status: 'done', submissionState: null }),
  mk({ title: 'TBD 考试', dueDate: null, source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: '今天的考试', dueDate: TONIGHT, source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: '作业不该进来', dueDate: '2026-09-15T23:59:59Z', taskType: 'assignment' }),
]

const exams = buildUpcomingExams(examTasks, NOW)
check(
  '最近的考试默认 3 条、按日期升序、跨过 7 天窗口',
  exams.length === 3 && exams.map((e) => e.title).join(' > ') === '今天的考试 > Unit 1 Exam > Unit 2 Exam',
  exams.map((e) => `${e.title}(还有 ${e.daysUntil} 天)`).join(' , '),
)
check('还剩天数与日期标签正确（Unit 1 Exam 还有 9 天，9/22 周二）', exams[1]?.daysUntil === 9 && exams[1]?.dateLabel === '9/22 周二', `${exams[1]?.daysUntil} 天 / ${exams[1]?.dateLabel}`)
check('今天的考试 daysUntil = 0', exams[0]?.daysUntil === 0)
check(
  '已考完 / TBD / 已过期 / 非考试任务都不进来',
  !exams.some((e) => ['已考完的 Exam', 'TBD 考试', '作业不该进来'].includes(e.title)),
)
check(
  '放宽到 5 条时顺序为 今天 > 9/22 > 10/20 > 11/10 > 12/14',
  buildUpcomingExams(examTasks, NOW, 5).map((e) => e.title).join(' > ') ===
    '今天的考试 > Unit 1 Exam > Unit 2 Exam > Unit 3 Exam > Final Exam',
)

// ---------------------------------------------------------------- 完成判定与提交态徽标（P0-3-15）

// 一条任务有**两轴**：`status` 归用户主权、`submission_state` 归 Canvas 真相（ADR-015）。
// 这两个函数的输出直接决定"任务出现在待办区还是已完成区"—— 算错**不会报错**，
// 只会让用户觉得页面在胡说（2026-09-17 Steven 截图抓到：Canvas 已评分的作业
// 被归进「已完成」盒、却画着空勾选框）。所以把六种 state 全部钉死。

const CANVAS_DONE_STATES = ['submitted', 'pending_review', 'graded'] as const

check(
  'isCanvasDone：submitted / pending_review / graded 为真（三者都算 Canvas 已判定完成）',
  CANVAS_DONE_STATES.every((s) => isCanvasDone(s)),
  CANVAS_DONE_STATES.map((s) => `${s}=${isCanvasDone(s)}`).join(' '),
)
check(
  'isCanvasDone：unsubmitted / missing / external_unconfirmed / null 为假',
  !isCanvasDone('unsubmitted') &&
    !isCanvasDone('missing') &&
    !isCanvasDone('external_unconfirmed') &&
    !isCanvasDone(null),
)
check(
  'isEffectivelyDone = 手勾 或 Canvas 已判定完成（两轴取并，缺一不可）',
  isEffectivelyDone({ status: 'done', submissionState: null }) &&
    isEffectivelyDone({ status: 'pending', submissionState: 'graded' }) &&
    !isEffectivelyDone({ status: 'pending', submissionState: 'unsubmitted' }),
)
check(
  '🔴 null（考试派生 / Canvas 不追踪）不算已完成 —— 防"顺手统一"把它并进去',
  !isCanvasDone(null) && !isEffectivelyDone({ status: 'pending', submissionState: null }),
)

// 徽标：六态各有文案 + 色调，null 不标。**文案与颜色一起钉** —— 只改色也是回归。
const badgeCases: [TaskSubmissionState | null, string | null, string | null][] = [
  ['unsubmitted', '未提交', 'warning'],
  ['missing', '缺交', 'danger'],
  ['submitted', '已提交', 'positive'],
  ['pending_review', '待查重', 'positive'],
  ['graded', '已评分', 'positive'],
  ['external_unconfirmed', '待确认', 'neutral'],
  [null, null, null],
]
check(
  'submissionBadge：六态文案与色调逐一对齐，null 不标',
  badgeCases.every(([state, label, tone]) => {
    const b = submissionBadge(state)
    return label === null ? b === null : b?.label === label && b?.tone === tone
  }),
  badgeCases.map(([s, l]) => `${s ?? 'null'}→${l ?? '（不标）'}`).join(' '),
)
check(
  'submissionBadge：每个徽标都带得出悬停解释（只有两个字说不清来源）',
  badgeCases.every(([state]) => state === null || (submissionBadge(state)?.title.length ?? 0) > 0),
)
check(
  'SUBMISSION_BADGE_CLASS：四种语气都有文字色工具类（缺一个会渲染成默认前景色）',
  (['warning', 'danger', 'positive', 'neutral'] as const).every((t) =>
    SUBMISSION_BADGE_CLASS[t].startsWith('text-'),
  ),
)

// ---------------------------------------------------------------- 汇总

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed > 0) process.exitCode = 1
