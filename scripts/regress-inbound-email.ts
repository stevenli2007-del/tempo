/**
 * P0-3-11 邮件入站纯函数回归（零副作用，不连库、不连 LLM）。
 *
 * 测的是「token 解析」与「决策函数」—— 与 `lib/email/token.ts` / `lib/email/plan.ts` 同口径。
 * 这是**唯一一类**「代码照样过、但拦截被悄悄放宽 / 决策被悄悄放开」的 bug：
 * token 解析退化会让未知地址被当成合法、决策放宽会偷偷自动新建任务。
 *
 * 用 `tsx` 直接 import 真函数（tsx 认 tsconfig 的 `@/` paths）。
 * 改 token.ts / plan.ts 时务必同步这里（顶部注释已写明）。
 */

import { extractTokenFromAddress, generateInboundToken, MIN_TOKEN_LENGTH } from '@/lib/email/token'
import { decideInboundAction, type ParsedInbound } from '@/lib/email/plan'
import type { TaskCandidate } from '@/types/task'

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

// ---------- token 解析 ----------

const tok = generateInboundToken()
assert(tok.length >= MIN_TOKEN_LENGTH, 'generateInboundToken 长度达标')

assert(extractTokenFromAddress(`inbound+${tok}@tempo.app`) === tok, '本地+tok@域 解出 token')
assert(
  extractTokenFromAddress(`INBOUND+${tok}@Tempo.App`.toLowerCase()) === tok,
  '大小写归一无影响',
)
assert(
  extractTokenFromAddress(`inbound+${tok}@tempo.app, other@x.com`) === tok,
  '多收件人取首个地址仍解出 token',
)
assert(extractTokenFromAddress('steven@tempo.app') === null, '无 + 返回 null')
assert(extractTokenFromAddress('inbound@tempo.app') === null, '仅有 + 前缀但无 token 返回 null')
assert(extractTokenFromAddress('plain text') === null, '无 @ 返回 null')
assert(extractTokenFromAddress(`inbound+short@tempo.app`) === null, 'token 过短返回 null')

// ---------- 决策函数 ----------
//
// 🔴 本段是**安全边界**的回归：2026-09-17 之前 plan.ts 复用对话框的模糊阈值 0.6，
// 实测「Homework 9999」（不存在的作业）会以 0.84 命中真实作业。现已收紧为
// **归一化后完全相等**，下面的用例把这条边界钉死 —— 谁放宽了谁就得改这里的断言。

function submittedAs(taskTitle: string | null): ParsedInbound {
  return { taskTitle, event: 'submitted', newDueDate: null, courseHint: null, warnings: [] }
}

const candidates: TaskCandidate[] = [
  { id: 'a', title: 'Homework 6', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false, status: 'pending' },
  { id: 'b', title: 'Lab 1', dueDate: null, taskType: 'assignment', source: 'manual', isDerived: false, status: 'pending' },
  // 同名两条（真实数据里 `Homework 7` 就是这样）：一条未完成、一条已完成 → 应挑未完成的那条
  { id: 'c-pending', title: 'Homework 7', dueDate: '2026-09-18T06:59:59+00:00', taskType: 'assignment', source: 'canvas', isDerived: false, status: 'pending' },
  { id: 'c-done', title: 'Homework 7', dueDate: '2026-09-18T23:59:59+00:00', taskType: 'assignment', source: 'canvas', isDerived: false, status: 'done' },
  // 同名两条都未完成 → 歧义，不许猜
  { id: 'd-1', title: 'Homework 8', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false, status: 'pending' },
  { id: 'd-2', title: 'Homework 8', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false, status: 'pending' },
  // 同名两条都已完成 → 无事可做
  { id: 'e-1', title: 'Homework 9', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false, status: 'done' },
  { id: 'e-2', title: 'Homework 9', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false, status: 'done' },
  // 干扰项：与「Homework 6: 1D Kinematics」极像（旧模糊匹配会给 0.9091），归一化后并不相等
  { id: 'f', title: 'Homework 01 - 1D Kinematics', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false, status: 'pending' },
]

const submitted: ParsedInbound = {
  taskTitle: 'Homework 6',
  event: 'submitted',
  newDueDate: null,
  courseHint: null,
  warnings: [],
}
const d1 = decideInboundAction(submitted, candidates)
assert(d1.action === 'mark_done' && d1.taskId === 'a', 'submitted + 命中 → mark_done a')

const noMatch: ParsedInbound = {
  taskTitle: 'Midterm',
  event: 'submitted',
  newDueDate: null,
  courseHint: null,
  warnings: [],
}
const d2 = decideInboundAction(noMatch, candidates)
assert(d2.action === 'none' && d2.reason === 'no_match', 'submitted + 无命中 → none/no_match')

const dueChanged: ParsedInbound = {
  taskTitle: 'Homework 6',
  event: 'due_date_changed',
  newDueDate: '10/20',
  courseHint: null,
  warnings: [],
}
const d3 = decideInboundAction(dueChanged, candidates)
assert(
  d3.action === 'none' && d3.reason === 'unsupported_event',
  '改期 → none/unsupported_event（只记录不落写）',
)

const newAssign: ParsedInbound = {
  taskTitle: 'New Project',
  event: 'new_assignment',
  newDueDate: null,
  courseHint: null,
  warnings: [],
}
const d4 = decideInboundAction(newAssign, candidates)
assert(
  d4.action === 'none' && d4.reason === 'unsupported_event',
  '新作业 → none/unsupported_event（绝不自动新建）',
)

const other: ParsedInbound = {
  taskTitle: null,
  event: 'other',
  newDueDate: null,
  courseHint: null,
  warnings: [],
}
const d5 = decideInboundAction(other, candidates)
assert(d5.action === 'none' && d5.reason === 'no_event', 'other → none/no_event')

const submittedNoTitle: ParsedInbound = {
  taskTitle: null,
  event: 'submitted',
  newDueDate: null,
  courseHint: null,
  warnings: [],
}
const d6 = decideInboundAction(submittedNoTitle, candidates)
assert(d6.action === 'none' && d6.reason === 'no_title', 'submitted 但无标题 → none/no_title')

// ---------- 收紧后的匹配边界（2026-09-17）----------

// 归一化仍吸收大小写 / 缩写差异：`HW 6` 与 `Homework 6` 归一化后同为 `homework6`
const d7 = decideInboundAction(submittedAs('HW 6'), candidates)
assert(d7.action === 'mark_done' && d7.taskId === 'a', '缩写等价：HW 6 → 命中 Homework 6')

const d8 = decideInboundAction(submittedAs('  homework   6 '), candidates)
assert(d8.action === 'mark_done' && d8.taskId === 'a', '大小写/空白等价：homework 6 → 命中')

// 🔴 核心边界：不存在的作业**绝不能**猜
const d9 = decideInboundAction(submittedAs('Homework 9999'), candidates)
assert(d9.action === 'none' && d9.reason === 'no_match', '不存在的作业名 → none/no_match（0.84 误命中已封）')

// 🔴 旧行为：`Homework 6: 1D Kinematics` 会以 0.9091 命中 `Homework 01 - 1D Kinematics`
const d10 = decideInboundAction(submittedAs('Homework 6: 1D Kinematics'), candidates)
assert(d10.action === 'none' && d10.reason === 'no_match', '带后缀的长标题 → none/no_match（不再模糊命中）')

// 同名多条：挑「未完成」的那条
const d11 = decideInboundAction(submittedAs('Homework 7'), candidates)
assert(d11.action === 'mark_done' && d11.taskId === 'c-pending', '同名两条(一完成一未完成) → 挑未完成的 c-pending')

// 同名多条且都未完成 → 放弃落写
const d12 = decideInboundAction(submittedAs('Homework 8'), candidates)
assert(
  d12.action === 'none' && d12.reason === 'ambiguous_title' &&
    (d12.candidates ?? []).length === 2,
  '同名两条都未完成 → none/ambiguous_title（列出 2 条候选）',
)

// 同名多条且都已完成 → 无事可做（写 done 是空操作，不该随便挑一条写）
const d13 = decideInboundAction(submittedAs('Homework 9'), candidates)
assert(d13.action === 'none' && d13.reason === 'already_done', '同名两条都已完成 → none/already_done')

// fail safe：候选不带 status（旧调用方）时，唯一命中仍可落写
const legacy: TaskCandidate[] = [
  { id: 'x', title: 'Lab 1', dueDate: null, taskType: 'assignment', source: 'manual', isDerived: false },
]
const d14 = decideInboundAction(submittedAs('Lab 1'), legacy)
assert(d14.action === 'mark_done' && d14.taskId === 'x', '候选无 status：唯一命中仍 mark_done（fail safe）')

const legacyDup: TaskCandidate[] = [
  { id: 'y1', title: 'Lab 1', dueDate: null, taskType: 'assignment', source: 'manual', isDerived: false },
  { id: 'y2', title: 'Lab 1', dueDate: null, taskType: 'assignment', source: 'manual', isDerived: false },
]
const d15 = decideInboundAction(submittedAs('Lab 1'), legacyDup)
assert(
  d15.action === 'none' && d15.reason === 'ambiguous_title',
  '候选无 status + 同名两条 → 仍判歧义（绝不按返回顺序随便挑）',
)

console.log(`\nregress:inbound — ${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
