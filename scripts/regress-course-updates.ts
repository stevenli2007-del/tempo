/**
 * P0-3-24 回归：对话框编排 exams / grade_components 的**判定层**（不依赖数据库、不依赖网络、不调 LLM）。
 *
 * 运行：`npm run regress:course-updates`
 *
 * 钉死四件事，每一件出错的后果都是"看起来成功、其实丢了数据"：
 * 1. `normalizeExamDate`：学年推断必须与 `lib/tasks/manual.ts` 同一条规则 ——
 *    两处不一致就会出现"作业在 2026、同一门课的考试在 2027"这种最难查的错。
 * 2. `validateExamInput`：**没有原文摘录的考试一律拒收**（ADR-021 解禁 exam 的对价）。
 * 3. `validateApplyBody`：单条非法 = 整批拒绝（不做"跳过坏的写好的"）。
 * 4. `weights`：按 source 分组、`null` 不计入合计、缺口如实报。
 *
 * 另外断言 schema 与校验器的**字段一致性**：`exams[].required` 里必须有 `sourceExcerpt`——
 * 这一条同时是"模型被要求给摘录"的机器可读证据，改 schema 时忘了这条就等于把红线拆了。
 */

import {
  COURSE_UPDATE_PARSE_SCHEMA,
  normalizeExamDate,
  validateApplyBody,
  validateExamInput,
  validateGradeComponentInput,
} from "@/lib/course-update/normalize"
import { summarizeWeightTotals, weightWarning, weightWarnings } from "@/lib/course-update/weights"

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

/** 固定基准日，保证学年推断的断言可复现（真跑用当前时间）。 */
const NOW = new Date("2026-09-17T12:00:00Z")
const uuid = "11111111-2222-4333-8444-555555555555"

console.log("normalizeExamDate（学年推断）")
{
  const fall = normalizeExamDate("9/4", NOW)
  check("9/4 → 当年（Fall 学期）", fall.ok && fall.value === "2026-09-04", JSON.stringify(fall))

  const spring = normalizeExamDate("1/20", NOW)
  check("1/20 → 次年（Spring 学期）", spring.ok && spring.value === "2027-01-20", JSON.stringify(spring))

  const boundary = normalizeExamDate("8/1", NOW)
  check("8/1 → 当年（月 ≥ 8 归 Fall）", boundary.ok && boundary.value === "2026-08-01", JSON.stringify(boundary))

  const iso = normalizeExamDate("2027-03-05", NOW)
  check("YYYY-MM-DD 原样归一", iso.ok && iso.value === "2027-03-05", JSON.stringify(iso))

  const empty = normalizeExamDate("", NOW)
  check("空串 → null（不编日期）", empty.ok && empty.value === null, JSON.stringify(empty))

  const nul = normalizeExamDate(null, NOW)
  check("null → null", nul.ok && nul.value === null)

  // 2/30 格式对、日历上不存在 —— 必须挡掉，否则会静默写进库（exam_dates.exam_date 是 date 列）。
  const impossible = normalizeExamDate("2/30", NOW)
  check("2/30 被拒（回环校验）", !impossible.ok, JSON.stringify(impossible))

  const garbage = normalizeExamDate("下周三", NOW)
  check("无法识别的写法被拒", !garbage.ok, JSON.stringify(garbage))

  const wrongType = normalizeExamDate(12345, NOW)
  check("非字符串被拒", !wrongType.ok)
}

console.log("validateExamInput（摘录是硬门槛）")
{
  const good = validateExamInput({
    examName: "Quiz 1",
    examDate: "9/4",
    examTime: null,
    location: null,
    sourceExcerpt: "Quiz 1: Sep 4 (in class)",
  })
  check("完整一条 → ok", good.ok, JSON.stringify(good))
  check(
    "日期被归一为 ISO",
    good.ok && good.value.examDate === "2026-09-04",
    good.ok ? String(good.value.examDate) : "-",
  )

  // 🔴 本卡最重要的一条断言：无摘录的考试不能进库。
  const noExcerpt = validateExamInput({
    examName: "Midterm 2",
    examDate: "11/6",
    examTime: null,
    location: null,
    sourceExcerpt: "",
  })
  check("缺 sourceExcerpt → 拒收（不是留空）", !noExcerpt.ok, JSON.stringify(noExcerpt))

  const noName = validateExamInput({ examName: "  ", examDate: "9/4", sourceExcerpt: "x" })
  check("缺 examName → 拒收", !noName.ok)

  const badDate = validateExamInput({ examName: "Final", examDate: "13/40", sourceExcerpt: "x" })
  check("非法日期 → 拒收", !badDate.ok)

  // 2026-09-17 起，「日期待定」是合法状态（tbd），不是错误。
  const tbd = validateExamInput({
    examName: "Final",
    examDate: null,
    examTime: null,
    location: null,
    sourceExcerpt: "Final: TBD",
  })
  check("无日期但有摘录 → ok（落 tbd）", tbd.ok && tbd.value.examDate === null, JSON.stringify(tbd))

  const longExcerpt = validateExamInput({
    examName: "Quiz 1",
    examDate: "9/4",
    sourceExcerpt: "x".repeat(500),
  })
  check(
    "超长摘录截断而不是拒收",
    longExcerpt.ok && longExcerpt.value.sourceExcerpt?.length === 200,
    longExcerpt.ok ? String(longExcerpt.value.sourceExcerpt?.length) : "-",
  )
}

console.log("validateGradeComponentInput（0 与 null 不能混）")
{
  const good = validateGradeComponentInput({
    name: "Each Midterm",
    weightPercent: 30,
    notes: null,
    sourceExcerpt: "Each Midterm 30%",
  })
  check("完整一条 → ok", good.ok && good.value.weightPercent === 30)

  const noWeight = validateGradeComponentInput({ name: "Final", weightPercent: null })
  check("没写占比 → null（不是 0）", noWeight.ok && noWeight.value.weightPercent === null)

  const over = validateGradeComponentInput({ name: "X", weightPercent: 130 })
  check(">100 → 拒收", !over.ok)

  const negative = validateGradeComponentInput({ name: "X", weightPercent: -5 })
  check("<0 → 拒收", !negative.ok)

  const numericString = validateGradeComponentInput({ name: "X", weightPercent: "30" })
  check("数字字符串可接受（模型常见漂移）", numericString.ok && numericString.value.weightPercent === 30)
}

console.log("validateApplyBody（单条非法 = 整批拒绝）")
{
  const ok = validateApplyBody({
    courseId: uuid,
    exams: [{ examName: "Quiz 1", examDate: "9/4", sourceExcerpt: "Quiz 1: Sep 4" }],
    gradeComponents: [{ name: "Final", weightPercent: 40 }],
  })
  check("合法请求体 → ok", ok.ok, JSON.stringify(ok))

  // 第二条坏 → 整批拒（不能写进去一条半）。
  const badSecond = validateApplyBody({
    courseId: uuid,
    exams: [
      { examName: "Quiz 1", examDate: "9/4", sourceExcerpt: "Quiz 1: Sep 4" },
      { examName: "Quiz 2", examDate: "9/18", sourceExcerpt: "" },
    ],
  })
  check("第二条缺摘录 → 整批拒", !badSecond.ok)
  check(
    "错误信息点名第几条",
    !badSecond.ok && badSecond.message.includes("第 2 条"),
    badSecond.ok ? "-" : badSecond.message,
  )

  const empty = validateApplyBody({ courseId: uuid, exams: [], gradeComponents: [] })
  check("空请求 → 拒（不是静默成功）", !empty.ok)

  const badCourse = validateApplyBody({ courseId: "not-a-uuid", exams: [], gradeComponents: [] })
  check("courseId 非法 → 拒", !badCourse.ok)

  const notObject = validateApplyBody("nope")
  check("非对象 → 拒", !notObject.ok)
}

console.log("weights（按 source 分组 / 缺口留灰）")
{
  const groups = summarizeWeightTotals([
    { source: "manual", weightPercent: 30 },
    { source: "manual", weightPercent: 30 },
    { source: "syllabus", weightPercent: 40 },
    { source: "syllabus", weightPercent: null },
  ])
  check("按 source 分成两组", groups.length === 2, String(groups.length))
  check("manual 合计 60 缺口 40", groups[0].total === 60 && groups[0].gap === 40, JSON.stringify(groups[0]))
  check("syllabus 合计 40（null 不计入）", groups[1].total === 40, JSON.stringify(groups[1]))
  check("syllabus 未知项计数 1", groups[1].unknownCount === 1)
  check("两组都不算完整", !groups[0].complete && !groups[1].complete)

  // 关键：三来源混算会得出 160% 这种诬告数字，分组之后各自成话。
  const warnings = weightWarnings([
    { source: "manual", weightPercent: 60 },
    { source: "syllabus", weightPercent: 100 },
  ])
  check("manual 缺口报警", warnings.some((w) => w.includes("60%") && w.includes("还差 40%")), warnings.join(" | "))
  check("syllabus 正好 100 → 不报警", !warnings.some((w) => w.includes("syllabus")), warnings.join(" | "))

  const over = summarizeWeightTotals([{ source: "manual", weightPercent: 110 }])
  check("超额如实报", over[0].gap === -10 && weightWarning(over[0])?.includes("超过 100%") === true)

  const withUnknown = summarizeWeightTotals([
    { source: "manual", weightPercent: 100 },
    { source: "manual", weightPercent: null },
  ])
  check(
    "合计 100 但有未知项 → 仍给一句说明",
    withUnknown[0].complete && withUnknown[0].hasUnknown,
    JSON.stringify(withUnknown[0]),
  )
  check(
    "未知项说明包含条数",
    weightWarning(withUnknown[0])?.includes("1 项") === true,
    String(weightWarning(withUnknown[0])),
  )

  check("空数组 → 空分组（不造假分组）", summarizeWeightTotals([]).length === 0)
  check("source 缺失时归 manual", summarizeWeightTotals([{ weightPercent: 50 }])[0].source === "manual")
}

console.log("schema ↔ 校验器 一致性")
{
  const props = COURSE_UPDATE_PARSE_SCHEMA.properties ?? {}
  check("schema 要求四个顶层字段", (COURSE_UPDATE_PARSE_SCHEMA.required ?? []).length === 4)

  const examProps = props.exams?.items?.properties ?? {}
  const examRequired = props.exams?.items?.required ?? []
  check("exams.required 含 sourceExcerpt", examRequired.includes("sourceExcerpt"))
  check("exams 字段与校验器读的字段同名", examRequired.every((key) => key in examProps))

  const gradeProps = props.gradeComponents?.items?.properties ?? {}
  const gradeRequired = props.gradeComponents?.items?.required ?? []
  check("gradeComponents.required 含 sourceExcerpt", gradeRequired.includes("sourceExcerpt"))
  check("gradeComponents 字段与校验器读的字段同名", gradeRequired.every((key) => key in gradeProps))

  // tasks 里不该再出现 exam —— 解禁是"搬到 exams 字段"，不是"放宽 tasks"。
  const taskTypes = props.tasks?.items?.properties?.taskType?.enum ?? []
  check("tasks.taskType 仍不含 exam", !taskTypes.includes("exam"), taskTypes.join("|"))
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
