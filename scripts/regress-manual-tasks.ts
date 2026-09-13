/**
 * 手动任务纯函数口径回归（P0-3-8）。
 *
 * 直接 import 真函数（`lib/tasks/manual.ts`），跑口径断言。**不连数据库、不调 LLM**，
 * 所以能且无副作用地在本地反复跑。这正是对付「口径算错、页面照常渲染」那类 bug 的武器
 * （CodingRules：「验证纯函数口径类逻辑，别复刻」）。
 *
 * 运行：npx tsx scripts/regress-manual-tasks.ts
 */

import {
  MANUAL_TASK_TYPES,
  normalizeDueDate,
  toInsertRow,
  validateManualTaskInput,
} from "../lib/tasks/manual"

let passed = 0
let failed = 0

function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`, detail ?? "")
  }
}

function assertOk<T>(name: string, r: { ok: true; value: T } | { ok: false; message: string }) {
  if (r.ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}: ${r.message}`)
  }
}

function assertErr(name: string, r: { ok: true } | { ok: false; message: string }) {
  if (!r.ok) {
    passed += 1
    console.log(`  ✓ ${name}（被正确拒绝：${r.message}）`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}：期望被拒绝，但通过了`)
  }
}

const COURSE_ID = "11111111-1111-1111-1111-111111111111"

console.log("normalizeDueDate")
{
  const r = normalizeDueDate(null)
  assertOk("null → TBD", r)
  if (r.ok) assert("null 值为 null", r.value === null)

  const e = normalizeDueDate("")
  assertOk("空串 → TBD", e)
  if (e.ok) assert("空串值为 null", e.value === null)

  const d = normalizeDueDate("2026-12-10")
  assertOk("YYYY-MM-DD → 当日 23:59:59Z", d)
  if (d.ok) assert("尾随 Z", d.value === "2026-12-10T23:59:59Z", d.value)

  const bad = normalizeDueDate("2026-13-40")
  assertErr("非法日期被拒", bad)

  const iso = normalizeDueDate("2026-12-10T15:00:00-08:00")
  assertOk("含时区 ISO 原样保留", iso)
  if (iso.ok) assert("ISO 转 UTC", iso.value === "2026-12-10T23:00:00.000Z", iso.value)

  const junk = normalizeDueDate("下周三")
  assertErr("无法识别的日期被拒", junk)
}

console.log("validateManualTaskInput")
{
  const ok = validateManualTaskInput({
    courseId: COURSE_ID,
    title: "  论文初稿  ",
    taskType: "assignment",
    dueDate: "2026-12-10",
  })
  assertOk("合法输入通过", ok)
  if (ok.ok) {
    assert("title 被 trim", ok.value.title === "论文初稿", ok.value.title)
    assert("dueDate 归一化", ok.value.dueDate === "2026-12-10T23:59:59Z", ok.value.dueDate)
  }

  assertErr("缺 courseId 被拒", validateManualTaskInput({ title: "x", taskType: "assignment", dueDate: null }))
  assertErr("非法 courseId 被拒", validateManualTaskInput({ courseId: "abc", title: "x", taskType: "assignment", dueDate: null }))
  assertErr("空 title 被拒", validateManualTaskInput({ courseId: COURSE_ID, title: "  ", taskType: "assignment", dueDate: null }))
  assertErr("exam 类型被拒", validateManualTaskInput({ courseId: COURSE_ID, title: "期中", taskType: "exam", dueDate: "2026-12-10" }))
  assertErr("非法 taskType 被拒", validateManualTaskInput({ courseId: COURSE_ID, title: "x", taskType: "quiz", dueDate: null }))
  assertErr("非对象被拒", validateManualTaskInput("nope"))

  const tbd = validateManualTaskInput({ courseId: COURSE_ID, title: "阅读 ch3", taskType: "reading", dueDate: null })
  assertOk("dueDate=null 通过", tbd)
  if (tbd.ok) assert("TBD 值为 null", tbd.value.dueDate === null)
}

console.log("toInsertRow 闭环取值")
{
  const ok = validateManualTaskInput({
    courseId: COURSE_ID,
    title: "项目",
    taskType: "other",
    dueDate: "2026-12-10",
    notes: "分组",
  })
  if (ok.ok) {
    const row = toInsertRow(ok.value)
    assert("source 强制 manual", row.source === "manual")
    assert("status 强制 pending", row.status === "pending")
    assert("is_derived 强制 false", row.is_derived === false)
    assert("submission_state 强制 null", row.submission_state === null)
    assert("submitted_at 强制 null", row.submitted_at === null)
    assert("notes 不进插入行（不污染 tasks）", !("notes" in row))
  } else {
    failed += 1
    console.error("  ✗ 前置校验失败")
  }
}

console.log(`\nMANUAL_TASK_TYPES = ${MANUAL_TASK_TYPES.join(", ")}`)
assert("不含 exam", !MANUAL_TASK_TYPES.includes("exam" as never))

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
