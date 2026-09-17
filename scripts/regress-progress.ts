/**
 * P0-3-7 回归：总览可视化的**口径层**（`lib/tasks/progress.ts` + `lib/tasks/today.ts`）——
 * 周历的分桶与窗口、最近的考试条的取用与排序、**今日任务的加权切片**（P0-3-16），
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
  canBeOverdue,
  isCanvasDone,
  isEffectivelyDone,
  needsManualConfirmation,
} from '@/lib/tasks/progress'
import { buildTodayTasks, TODAY_HORIZON_DAYS } from '@/lib/tasks/today'
import { isRemindable } from '@/lib/reminders/build'
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
    // P0-3-17 新增的三个字段。默认全 null（= "Canvas 没给"），
    // 需要它们的用例显式覆盖 —— 默认值必须是"没有"，绝不能是 0（0 是"真的是 0 分"）。
    canvasUrl: null,
    pointsPossible: null,
    submissionScore: null,
    ...over,
  }
}

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
}

// ---------------------------------------------------------------- 夹具
//
// 一份夹具同时喂周历与「今日任务」（两者都收全部来源、都用同一个完成判定）——
// 拆成两份迟早漂开。注释标注每条落在/不进各口径的原因。

const fixture: Task[] = [
  mk({ title: 'A 未交', dueDate: PAST, submissionState: 'unsubmitted' }), // 逾期 · Canvas 确认未交
  mk({ title: 'B 缺交', dueDate: PAST, submissionState: 'missing' }), // 逾期 · Canvas 确认缺交
  mk({ title: 'C 已评分', dueDate: PAST, submissionState: 'graded' }), // 已完成（Canvas）
  mk({ title: 'D 待查重', dueDate: PAST, submissionState: 'pending_review' }), // 已完成（Canvas）
  mk({ title: 'E 外部平台', dueDate: PAST, submissionState: 'external_unconfirmed' }), // 无外部真相 → 不进红组
  mk({ title: 'F 不追踪', dueDate: PAST, submissionState: null }), // Canvas 明说不追踪 → 不进逾期条（P0-3-17）
  mk({ title: 'G 手勾', dueDate: PAST, status: 'done', submissionState: 'unsubmitted' }), // 已完成（手勾）
  mk({ title: 'H 考试派生', dueDate: PAST, source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }), // 与 Canvas 无关 → 仍算逾期
  mk({ title: 'I 手动', dueDate: PAST, source: 'manual', submissionState: null }), // 与 Canvas 无关 → 仍算逾期
  mk({ title: 'J 无日期', dueDate: null }), // 不进（不编日期）
  mk({ title: 'K 未到期', dueDate: TOO_FAR }), // 不进周历（窗口外）；进「今日任务」的未来切片
  mk({ title: 'L 太旧', dueDate: OLD }), // 不进（周历窗与今日视野外）
  mk({ title: 'M 今晚到期', dueDate: TONIGHT }), // 今天到期
  mk({ title: 'N 课程2未交', dueDate: PAST, courseName: 'MATH 53', courseId: 'c2' }),
  mk({ title: 'O 三天后考试', dueDate: '2026-09-16T23:59:00-07:00', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }),
  mk({ title: 'P 明天到期', dueDate: '2026-09-14T23:59:00-07:00' }),
  mk({ title: 'Q 最后一天', dueDate: '2026-09-19T23:59:00-07:00' }),
  mk({ title: 'R 已完成的过期作业', dueDate: PAST, status: 'done', submissionState: 'graded' }),
]

// ---------------------------------------------------------------- 周历

const calendar = buildWeekCalendar(fixture, NOW)
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
  '逾期的收在顶部整条，不散落在过去的格子里（A/B/H/I/N/L，按最近优先）',
  calendar.overdue.length === 6 &&
    !calendar.overdue.some((p) => p.title.startsWith('G') || p.title.startsWith('R')) &&
    calendar.overdue.every((p) => !calendar.days.some((d) => d.pills.some((x) => x.id === p.id))),
  calendar.overdue.map((p) => p.title).join(' , '),
)
check(
  '🔴 P0-3-17：逾期条只收「够格标逾期」的 —— E（外部平台）与 F（Canvas 明说不追踪）都排掉',
  !calendar.overdue.some((p) => p.title.startsWith('E ') || p.title.startsWith('F ')) &&
    // 但考试派生（H）与手动任务（I）**保留** —— 它们的日期来自用户自己的 syllabus，
    // 说"这个日子过了"是陈述用户自己的记录，不是替第三方下结论。
    calendar.overdue.some((p) => p.title.startsWith('H ')) &&
    calendar.overdue.some((p) => p.title.startsWith('I ')),
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

// ---------------------------------------------------------------- 今日任务（P0-3-16）

// 口径：今天到期 100% + 未来按 1/剩余天数 切片 + 逾期未完成（红组，**只收 Canvas 确认未交的**）。
// 夹具独立于上面的 `fixture`（那份服务周历）—— 两套口径的断言不互相牵扯。

const todayTasks: Task[] = [
  mk({ title: '逾期未交', dueDate: '2026-09-11T23:59:00-07:00', submissionState: 'unsubmitted' }), // 红
  mk({ title: '逾期缺交', dueDate: '2026-09-05T23:59:00-07:00', submissionState: 'missing' }), // 红
  mk({ title: '逾期不追踪', dueDate: '2026-09-11T23:59:00-07:00', submissionState: null }), // 不进红（ADR-013）
  mk({ title: '逾期外部平台', dueDate: '2026-09-11T23:59:00-07:00', submissionState: 'external_unconfirmed' }), // 不进红
  mk({ title: '逾期考试', dueDate: '2026-09-11T23:59:00-07:00', source: 'syllabus', taskType: 'exam', isDerived: true, submissionState: null }), // 不进红
  mk({ title: '逾期已完成', dueDate: '2026-09-11T23:59:00-07:00', status: 'done' }), // 已完成 → 不进
  mk({ title: '今天到期', dueDate: '2026-09-13T23:59:00-07:00' }), // 0 天 → 100%
  mk({ title: '明天到期', dueDate: '2026-09-14T23:59:00-07:00' }), // 1 天 → 100%
  mk({ title: '三天后', dueDate: '2026-09-16T23:59:00-07:00' }), // 3 天 → 33%
  mk({ title: '四天后', dueDate: '2026-09-17T23:59:00-07:00' }), // 4 天 → 25%
  mk({ title: '第七天', dueDate: '2026-09-20T23:59:00-07:00' }), // 7 天 → 14%（视野内）
  mk({ title: '第八天', dueDate: '2026-09-21T23:59:00-07:00' }), // 视野外 → 排除
  mk({ title: '无日期', dueDate: null }), // 排除
]

const todayModel = buildTodayTasks(todayTasks, NOW)
check(
  '今日任务·分组：红组 = Canvas 确认未交的逾期（2）；今天 = 1；未来 7 天 = 4（按剩余天数升序）',
  todayModel.overdue.map((i) => i.title).join(',') === '逾期未交,逾期缺交' &&
    todayModel.dueToday.map((i) => i.title).join(',') === '今天到期' &&
    todayModel.upcoming.map((i) => i.title).join(',') === '明天到期,三天后,四天后,第七天',
  `overdue=[${todayModel.overdue.map((i) => i.title)}] due=[${todayModel.dueToday.map((i) => i.title)}] up=[${todayModel.upcoming.map((i) => i.title)}]`,
)
check(
  '🔴 红组只收 Canvas 明确说没交的（null / external_unconfirmed / 考试派生 都不进红组，ADR-013）',
  todayModel.overdue.every((i) => !['逾期不追踪', '逾期外部平台', '逾期考试'].includes(i.title)) &&
    todayModel.overdue.length === 2,
)
check(
  '切片：今天/明天 = 100%，3 天 = 33%，4 天 = 25%，7 天 = 14%',
  todayModel.dueToday[0]?.weightPct === 100 &&
    todayModel.upcoming.map((i) => i.weightPct).join(',') === '100,33,25,14',
  todayModel.upcoming.map((i) => `${i.title}:${i.weightPct}%`).join(' '),
)
check(
  '视野外（第八天）与无日期不进任何组',
  [...todayModel.overdue, ...todayModel.dueToday, ...todayModel.upcoming].every(
    (i) => i.title !== '第八天' && i.title !== '无日期',
  ),
)
check(
  '已完成的不进（逾期已完成）',
  [...todayModel.overdue, ...todayModel.dueToday, ...todayModel.upcoming].every(
    (i) => i.title !== '逾期已完成',
  ),
)
check(
  '今日工作量 = Σweight（2 逾期 + 1 今天 + 1 明天 + 1/3 + 1/4 + 1/7）',
  Math.abs(todayModel.load - (2 + 1 + 1 + 1 / 3 + 1 / 4 + 1 / 7)) < 1e-9,
  `load=${todayModel.load}`,
)
check(
  'horizonDays 回传正确（默认 7）',
  todayModel.horizonDays === TODAY_HORIZON_DAYS && TODAY_HORIZON_DAYS === 7,
)

// 🔴 直接钉验收标准里给的那一例：2026-09-17 看 2026-09-21 到期 = 25%（1/4）。
const sep17Model = buildTodayTasks(
  [mk({ title: '验收例', dueDate: '2026-09-21T23:59:00-07:00' })],
  new Date('2026-09-17T19:00:00Z'), // 2026-09-17 12:00 PDT
)
check(
  '🔴 验收标准：2026-09-17 看 09-21 到期显示 25%',
  sep17Model.upcoming[0]?.weightPct === 25,
  `weightPct=${sep17Model.upcoming[0]?.weightPct}`,
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

// 徽标：六态各有文案 + 色调；null 的语义取决于**来源**（P0-3-17）。**文案与颜色一起钉** —— 只改色也是回归。
type BadgeCase = [source: Task['source'], state: TaskSubmissionState | null, label: string | null, tone: string | null]
const badgeCases: BadgeCase[] = [
  ['canvas', 'unsubmitted', '未提交', 'warning'],
  ['canvas', 'missing', '缺交', 'danger'],
  ['canvas', 'submitted', '已提交', 'positive'],
  ['canvas', 'pending_review', '待查重', 'positive'],
  ['canvas', 'graded', '已评分', 'positive'],
  ['canvas', 'external_unconfirmed', '待确认', 'neutral'],
  // 🔴 P0-3-17：Canvas 明说不追踪完成态 → 「需手动确认」
  ['canvas', null, '需手动确认', 'neutral'],
  // 与 Canvas 无关的 null（考试派生 / 用户自建）→ **不标**（给每场考试挂徽标是纯噪声）
  ['syllabus', null, null, null],
  ['manual', null, null, null],
]
check(
  'submissionBadge：六态文案与色调逐一对齐；canvas+null 标「需手动确认」，syllabus/manual+null 不标',
  badgeCases.every(([source, state, label, tone]) => {
    const b = submissionBadge({ source, submissionState: state })
    return label === null ? b === null : b?.label === label && b?.tone === tone
  }),
  badgeCases.map(([s, st, l]) => `${s}+${st ?? 'null'}→${l ?? '（不标）'}`).join(' '),
)
check(
  'submissionBadge：每个徽标都带得出悬停解释（只有两个字说不清来源）',
  badgeCases.every(
    ([source, state]) =>
      state === null && source !== 'canvas' ||
      (submissionBadge({ source, submissionState: state })?.title.length ?? 0) > 0,
  ),
)
check(
  'SUBMISSION_BADGE_CLASS：四种语气都有文字色工具类（缺一个会渲染成默认前景色）',
  (['warning', 'danger', 'positive', 'neutral'] as const).every((t) =>
    SUBMISSION_BADGE_CLASS[t].startsWith('text-'),
  ),
)

// ---------------------------------------------------------------- 需手动确认 / 逾期资格（P0-3-17）

// 这两个判据是 P0-3-17 的核心：它们决定"哪些任务不该被标红、不该被催"。
// 判错的两个后果都是静默的 —— 要么诬告用户（把 makeup form 标成逾期），
// 要么吞掉真提醒（把考试一起排掉）。所以两侧都钉。

check(
  '🔴 needsManualConfirmation：只有 canvas 来源的 null 才算（syllabus/manual 的 null 不算）',
  needsManualConfirmation({ source: 'canvas', submissionState: null }) &&
    !needsManualConfirmation({ source: 'syllabus', submissionState: null }) &&
    !needsManualConfirmation({ source: 'manual', submissionState: null }) &&
    !needsManualConfirmation({ source: 'canvas', submissionState: 'unsubmitted' }) &&
    !needsManualConfirmation({ source: 'canvas', submissionState: 'graded' }),
)

check(
  '🔴 canBeOverdue：手勾 / Canvas 已判定完成 / 外部平台 / Canvas 明说不追踪 —— 四类都不标逾期',
  !canBeOverdue({ status: 'done', source: 'canvas', submissionState: 'unsubmitted' }) &&
    !canBeOverdue({ status: 'pending', source: 'canvas', submissionState: 'graded' }) &&
    !canBeOverdue({ status: 'pending', source: 'canvas', submissionState: 'external_unconfirmed' }) &&
    !canBeOverdue({ status: 'pending', source: 'canvas', submissionState: null }),
)
check(
  '🔴 canBeOverdue：Canvas 明确说没交的（unsubmitted / missing）够格；考试派生与手动任务也够格',
  canBeOverdue({ status: 'pending', source: 'canvas', submissionState: 'unsubmitted' }) &&
    canBeOverdue({ status: 'pending', source: 'canvas', submissionState: 'missing' }) &&
    canBeOverdue({ status: 'pending', source: 'syllabus', submissionState: null }) &&
    canBeOverdue({ status: 'pending', source: 'manual', submissionState: null }),
)

// 提醒范围（`isRemindable`，P0-3-14 立的口径 + P0-3-17 补的例外）。
check(
  '🔴 isRemindable：Canvas 明说不追踪的不催（makeup form 这类，P0-3-17 修复）',
  !isRemindable({ source: 'canvas', status: 'pending', submissionState: null }),
)
check(
  '🔴 isRemindable：**考试派生与手动任务的 null 照样提醒** —— 防"顺手统一"吞掉全部考试',
  isRemindable({ source: 'syllabus', status: 'pending', submissionState: null }) &&
    isRemindable({ source: 'manual', status: 'pending', submissionState: null }),
)
check(
  'isRemindable：已完成 / 外部平台 / Canvas 明说不追踪 三类都不催，其余照催',
  !isRemindable({ source: 'canvas', status: 'pending', submissionState: 'graded' }) &&
    !isRemindable({ source: 'canvas', status: 'done', submissionState: 'unsubmitted' }) &&
    !isRemindable({ source: 'canvas', status: 'pending', submissionState: 'external_unconfirmed' }) &&
    isRemindable({ source: 'canvas', status: 'pending', submissionState: 'unsubmitted' }) &&
    isRemindable({ source: 'canvas', status: 'pending', submissionState: 'missing' }),
)

// `canvasUrl` 必须**原样透传**到「今日任务」的行模型（P0-3-17 的"点任务名跳 Canvas"）。
const linkModel = buildTodayTasks(
  [mk({ title: '有外链', dueDate: '2026-09-14T23:59:00-07:00', canvasUrl: 'https://example.test/a/1' })],
  NOW,
)
check(
  '今日任务：canvasUrl 原样透传（null 时不编链接）',
  linkModel.upcoming[0]?.canvasUrl === 'https://example.test/a/1' &&
    todayModel.dueToday[0]?.canvasUrl === null,
  `${linkModel.upcoming[0]?.canvasUrl} / ${todayModel.dueToday[0]?.canvasUrl}`,
)

// ---------------------------------------------------------------- 汇总

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed > 0) process.exitCode = 1
