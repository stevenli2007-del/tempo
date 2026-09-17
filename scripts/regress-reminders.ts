/**
 * P0-3-14 提醒「内容渲染层」纯函数回归（零副作用，不连库、不连 Worker）。
 *
 * 测的是「截止临近排序」「可行动判定」「邮件组装」「频控（本地日历日）」—— 与 `lib/reminders/build.ts` 同口径。
 * 这是**唯一一类**「代码照样过、但口径被悄悄放宽」的 bug：排序退化会让 TBD 排到前面、
 * 可行动判定放宽会让没到期的事也天天发信（与 ADR-016 R3「准确优先于频繁」直接冲突）。
 *
 * 用 `tsx` 直接 import 真函数（tsx 认 tsconfig 的 `@/` paths）。
 * 改 build.ts 时务必同步这里（顶部注释已写明）。
 */

import {
  buildReminderEmail,
  computeActionable,
  isRemindable,
  isSameLocalDay,
  sortByDueDateAsc,
} from '@/lib/reminders/build'

let passed = 0
let failed = 0

function assert(cond: boolean, name: string) {
  if (cond) {
    passed += 1
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

// 固定"现在"为 2026-09-17 12:00 UTC，保证断言可复现（不依赖系统时钟）。
const NOW = new Date('2026-09-17T12:00:00.000Z')

const overdue = { courseName: 'CHEM 1A', title: 'Homework 1', dueDate: '2026-09-15T23:59:00Z', taskType: 'assignment' as const }
const dueSoon = { courseName: 'MATH 53', title: 'Homework 7', dueDate: '2026-09-18T23:59:00Z', taskType: 'assignment' as const }
const farFuture = { courseName: 'PHYSICS 7A', title: 'Problem Set 3', dueDate: '2026-12-01T23:59:00Z', taskType: 'assignment' as const }
const tbd = { courseName: 'CHEM 1A', title: 'Lab Report', dueDate: null, taskType: 'assignment' as const }

// ---------- 可提醒判据（「绝不误报」，2026-09-17 实发信 bug 的回归锚） ----------

{
  // 🔴 反例（真实事故）：Canvas 已判定完成、但 `status` 仍是 pending（同步永不写 status，ADR-015）。
  //    首版只筛 status → 真发的那封信 21 条里 18 条是这类 → 误报率 86%。
  assert(isRemindable({ status: 'pending', submissionState: 'submitted' }) === false, '可提醒：Canvas 已提交 → 不提醒')
  assert(isRemindable({ status: 'pending', submissionState: 'graded' }) === false, '可提醒：Canvas 已评分 → 不提醒')
  assert(isRemindable({ status: 'pending', submissionState: 'pending_review' }) === false, '可提醒：Canvas 待查重 → 不提醒')
  // 用户主权优先：手勾 done 的一律不提醒（哪怕 Canvas 说没交）。
  assert(isRemindable({ status: 'done', submissionState: 'unsubmitted' }) === false, '可提醒：用户已勾 done → 不提醒')
  // 无外部真相（Gradescope 等 LTI）→ 不催（ADR-013：当"没交"是诬告）。
  assert(isRemindable({ status: 'pending', submissionState: 'external_unconfirmed' }) === false, '可提醒：外部平台待确认 → 不催')
  // Canvas 明确说没收到 → 正是最该催的一类。
  assert(isRemindable({ status: 'pending', submissionState: 'unsubmitted' }) === true, '可提醒：Canvas 未交 → 提醒')
  assert(isRemindable({ status: 'pending', submissionState: 'missing' }) === true, '可提醒：Canvas 缺交 → 提醒')
  // ⚠️ 防"顺手统一"：`null` 包含全部 syllabus 派生考试与手动任务，**必须提醒**
  //    （考试一学期只有 3-5 次；因"没外部真相"就不提醒是灾难）。null ≠ 不确定。
  assert(isRemindable({ status: 'pending', submissionState: null }) === true, '可提醒：Canvas 不追踪（含考试派生）→ 仍提醒')
}

// ---------- 频控：本地日历日（「每用户每天至多一封」） ----------

const TZ = 'America/Los_Angeles'

{
  // 反例（2026-09-17 实测踩到的静默 bug）：固定 24h 窗口下「昨 14:00:03 发 → 今 14:00:00 查」，
  // 差值 86,397,000ms < 24h → 被误判「今天已发过」→ 跳过 → 退化成隔天一封。日历日判据必须放行。
  assert(
    isSameLocalDay(new Date('2026-09-17T14:00:03Z'), new Date('2026-09-18T14:00:00Z'), TZ) === false,
    '频控：隔天同一时刻不算同一天（修「隔天一封」）',
  )
  assert(
    isSameLocalDay(new Date('2026-09-17T14:00:00Z'), new Date('2026-09-17T20:00:00Z'), TZ) === true,
    '频控：同一天内一律拦（每天至多一封）',
  )
  assert(
    isSameLocalDay(new Date('2026-09-18T06:59:00Z'), new Date('2026-09-18T07:00:00Z'), TZ) === false,
    '频控：跨 PT 零点算新的一天',
  )
  assert(
    isSameLocalDay(new Date('2026-09-17T23:00:00Z'), new Date('2026-09-18T01:00:00Z'), TZ) === true,
    '频控：UTC 跨日但本地同日仍拦',
  )
  assert(
    isSameLocalDay(new Date('2026-09-18T02:00:00Z'), new Date('2026-09-18T13:00:00Z'), 'UTC') === true &&
      isSameLocalDay(new Date('2026-09-18T02:00:00Z'), new Date('2026-09-18T13:00:00Z'), TZ) === false,
    '频控：按用户时区判定（非 UTC 硬编码）',
  )
}

// ---------- 排序：截止临近（TBD 排最后） ----------

{
  const sorted = sortByDueDateAsc([tbd, farFuture, dueSoon, overdue])
  assert(sorted[0] === overdue, '排序：逾期在最前')
  assert(sorted[1] === dueSoon, '排序：即将到期次之')
  assert(sorted[2] === farFuture, '排序：远未来再次')
  assert(sorted[3] === tbd, '排序：TBD 永远最后')
}

{
  // 同日同日期 → 按 title 稳定排序。
  const a = { courseName: 'X', title: 'A', dueDate: '2026-09-20T00:00:00Z', taskType: 'assignment' as const }
  const b = { courseName: 'X', title: 'B', dueDate: '2026-09-20T00:00:00Z', taskType: 'assignment' as const }
  const sorted = sortByDueDateAsc([b, a])
  assert(sorted[0] === a && sorted[1] === b, '排序：同日按 title 稳定')
}

// ---------- 可行动判定 ----------

{
  const r = computeActionable([overdue, dueSoon, farFuture, tbd], NOW)
  assert(r.overdueCount === 1, '可行动：逾期计数 = 1')
  assert(r.dueSoonCount === 1, '可行动：即将到期计数 = 1')
  assert(r.actionable === true, '可行动：有逾期/即将到期 → true')
}

{
  // 只有远未来 + TBD → 不可行动（不应发信）。
  const r = computeActionable([farFuture, tbd], NOW)
  assert(r.actionable === false, '可行动：仅远未来+TBD → false')
  assert(r.overdueCount === 0 && r.dueSoonCount === 0, '可行动：无逾期/即将到期')
}

// ---------- 邮件组装（聚焦版：正文只列可行动项） ----------

{
  const built = buildReminderEmail({
    tasks: [tbd, farFuture, dueSoon, overdue],
    timezone: 'America/Los_Angeles',
    now: NOW,
    unsubscribeUrl: 'https://tempo.example.com/api/v1/reminders/unsubscribe?t=abc',
    viewUrl: 'https://tempo.example.com/dashboard',
  })
  assert(built.actionable === true, '组装：actionable 透传')
  assert(built.subject.includes('待处理'), '组装：可行动主题含「待处理」')
  assert(built.html.includes('CHEM 1A'), '组装：html 含课程名')
  assert(built.html.includes('Homework 1'), '组装：html 含可行动任务标题')
  assert(built.html.includes('已逾期'), '组装：html 含逾期标签')
  assert(built.html.includes('还有 1 天') || built.html.includes('还有'), '组装：html 含即将到期标签')
  assert(built.html.includes('日期待定'), '组装：折叠行含「日期待定」计数')
  assert(
    built.html.includes('https://tempo.example.com/api/v1/reminders/unsubscribe?t=abc'),
    '组装：html 含退订链接',
  )
  assert(built.text.includes('Homework 1'), '组装：text 含可行动任务标题')
  assert(built.totalCount === 4, '组装：totalCount = 全部 pending = 4')

  // 聚焦版核心口径：正文只列可行动项，其余折叠成计数。
  assert(built.shownCount === 2, '聚焦：shownCount = 可行动 2（逾期+即将到期）')
  assert(built.hiddenCount === 2, '聚焦：hiddenCount = 2（远未来+TBD）')
  assert(built.hiddenTbdCount === 1, '聚焦：hiddenTbdCount = 1（TBD）')
  assert(!built.html.includes('Problem Set 3'), '聚焦：远未来任务不进正文')
  assert(!built.html.includes('Lab Report'), '聚焦：TBD 任务不进正文表格')
  assert(built.html.includes('另有'), '聚焦：html 含「另有 N 项」折叠行')
  assert(built.html.includes('在 Tempo 查看'), '聚焦：html 含落地页链接文案')
  assert(built.html.includes('https://tempo.example.com/dashboard'), '聚焦：html 含落地页链接')
  assert(built.text.includes('另有 2 项'), '聚焦：text 含折叠计数')
}

{
  // 不可行动 → 主题用「任务一览」，正文无表格（可行动为空），只留折叠行。
  const built = buildReminderEmail({
    tasks: [farFuture, tbd],
    timezone: 'America/Los_Angeles',
    now: NOW,
    unsubscribeUrl: 'https://tempo.example.com/u?t=x',
    viewUrl: 'https://tempo.example.com/dashboard',
  })
  assert(built.actionable === false, '组装(不可行动)：actionable = false')
  assert(built.subject.includes('任务一览'), '组装(不可行动)：主题用「任务一览」')
  assert(built.shownCount === 0, '聚焦(不可行动)：正文 0 条')
  assert(!built.html.includes('PHYSICS 7A'), '聚焦(不可行动)：远未来任务不进正文')
  // HTML 里数字被 <strong> 包住，故断言标记形态而非「另有 2 项」整串。
  assert(
    built.html.includes('另有 <strong') && built.html.includes('2</strong> 项更远的任务'),
    '聚焦(不可行动)：折叠行仍给出总数',
  )
}

console.log(`\n提醒回归：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
