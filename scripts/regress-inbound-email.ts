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
import { decideInboundAction, type ParsedInbound, type TaskCandidate } from '@/lib/email/plan'

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

const candidates: TaskCandidate[] = [
  { id: 'a', title: 'Homework 6', dueDate: null, taskType: 'assignment', source: 'canvas', isDerived: false },
  { id: 'b', title: 'Lab 1', dueDate: null, taskType: 'assignment', source: 'manual', isDerived: false },
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

console.log(`\nregress:inbound — ${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
