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
import {
  examChangeLabel,
  isGenericExamName,
  normalizeExamName,
  resolveExamTargets,
} from "@/lib/course-update/exam-match"
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

console.log("考试匹配（P0-3-29：改期 = 更新提案，不是新增行）")
{
  // ⚠️ 这里刻意用**函数声明**而不是 `const row = (…) => ({ … })`：
  // 箭头 + 圆括号包的对象体 + 紧跟着一个裸块 `{` 会被 TS 解析器误判
  // （报 "Identifier expected. 'null' is a reserved word"，位置还指错行）。
  // 加个分号也能解，但本仓库是无分号风格 —— 换成函数声明最干净。
  function row(id: string, name: string, date: string | null) {
    return { id, examName: name, examDate: date, examTime: null, location: null }
  }

  // ① 卡面验收①：同名不同日期 → 命中那一行，产出 update（绝不新增）。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28")]
    const input = { examName: "Midterm 1", examDate: "2026-09-27", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("同名不同日期 → update", r.kind === "update" && r.target?.id === "e1", JSON.stringify(r))
  }

  // ② 归一：大小写 / 空格 / 标点不算差异（Midterm1 ≡ Midterm 1）。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28")]
    const input = { examName: "MIDTERM1", examDate: "2026-09-27", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("名字归一后仍命中", r.kind === "update", JSON.stringify(r))
  }

  // ③ 名字完全一致、日期也一样 → duplicate（不写第二遍）。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28")]
    const input = { examName: "Midterm 1", examDate: "2026-09-28", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("一模一样 → duplicate", r.kind === "duplicate", JSON.stringify(r))
  }

  // ④ 卡面约束2：多命中不猜。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28"), row("e2", "Midterm 1", "2026-11-02")]
    const input = { examName: "Midterm 1", examDate: "2026-09-27", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("同名多行 → ambiguous", r.kind === "ambiguous" && r.candidates.length === 2, JSON.stringify(r))
    check("ambiguous 不指定 target", r.target === null)
  }

  // ⑤ 卡面约束6：名字不可辨识 + 该课已有考试 → 不许悄悄新增。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28")]
    const input = { examName: "the exam", examDate: "2026-09-27", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("只写「考试」→ unidentifiable", r.kind === "unidentifiable", JSON.stringify(r))
    check("unidentifiable 列出全部候选", r.candidates.length === 1)
  }
  {
    // 一门课一条考试都没有时，「考试」指唯一那一场，新增是安全的。
    const input = { examName: "考试", examDate: "2026-09-27", examTime: null, location: null }
    const [r] = resolveExamTargets([input], [])
    check("空课 + 通称 → create", r.kind === "create", JSON.stringify(r))
  }

  // ⑥ 跨课不串：existing 只给这一门课的行（调用方负责过滤），别的课的行不在里面就不可能命中。
  {
    const existing = [row("e9", "Midterm 1", "2026-09-28")]
    const input = { examName: "Midterm 1", examDate: "2026-09-27", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing.filter((item) => item.id === "e1"))
    check("候选不含别课的行 → create", r.kind === "create")
  }

  // ⑦ 批内占位：两条输入命中同一行 → 第二条 duplicate（否则旧值快照会被覆盖）。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28")]
    const inputs = [
      { examName: "Midterm 1", examDate: "2026-09-27", examTime: null, location: null },
      { examName: "Midterm 1", examDate: "2026-09-26", examTime: null, location: null },
    ]
    const rs = resolveExamTargets(inputs, existing)
    check("批内第二条不重复落同一行", rs[0].kind === "update" && rs[1].kind === "duplicate", JSON.stringify(rs.map((r) => r.kind)))
  }

  // ⑧ 用户显式裁决优先于名字解析。
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28"), row("e2", "Final", "2026-12-10")]
    const picked = {
      examName: "Midterm 1",
      examDate: "2026-09-27",
      examTime: null,
      location: null,
      targetExamId: "e2",
    }
    const [r] = resolveExamTargets([picked], existing)
    check("显式指定 → 照指定的那行", r.kind === "update" && r.target?.id === "e2")
  }
  {
    const existing = [row("e1", "Midterm 1", "2026-09-28")]
    const forced = {
      examName: "Midterm 1",
      examDate: "2026-09-27",
      examTime: null,
      location: null,
      targetExamId: null,
    }
    const [r] = resolveExamTargets([forced], existing)
    check("显式 targetExamId=null → 强制新增", r.kind === "create")
  }
  {
    const stale = {
      examName: "Midterm 1",
      examDate: "2026-09-27",
      examTime: null,
      location: null,
      targetExamId: "00000000-0000-4000-8000-000000000000",
    }
    const [r] = resolveExamTargets([stale], [row("e1", "Midterm 1", "2026-09-28")])
    check("目标行不在 → missing（不退化成新增）", r.kind === "missing", JSON.stringify(r))
  }

  // ⑨' P0-3-36：0 命中但**同一天**已有考试 → 不许静默新增，列出来让人挑。
  //
  // 真案子：Chem 1A 座位公告写「明天晚上的 Chem 1A exam (Sep 22)」，
  // 库里那条叫 `Unit 1 Exam`（同一天）→ 老规则判 create，于是 4 场考试变 5 场。
  {
    const existing = [row("e1", "Unit 1 Exam", "2026-09-22"), row("e2", "Unit 2 Exam", "2026-10-20")]
    const input = { examName: "Chem 1A exam", examDate: "2026-09-22", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check(
      "名字对不上但同日有考试 → ambiguous（不静默新增）",
      r.kind === "ambiguous" && r.target === null,
      JSON.stringify(r.kind),
    )
    check("同日候选只列当天的那一条", r.candidates.length === 1 && r.candidates[0].id === "e1")
    check("候选不带别的日期的行", r.candidates.every((item) => item.examDate === "2026-09-22"))
    check("原因说清是哪一天、哪一场", r.reason?.includes("2026-09-22") === true, String(r.reason))
  }
  {
    // 不同日期 → 与老规则一致，仍然新增（否则「上午 quiz + 晚上 exam」会被误合）。
    const existing = [row("e1", "Unit 1 Exam", "2026-09-22")]
    const input = { examName: "Chem 1A exam", examDate: "2026-10-20", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("同课不同日 → 照旧 create", r.kind === "create", JSON.stringify(r.kind))
  }
  {
    // 用户明确挑了「新增」→ 强制 create，即便同日有考试（不能反过来卡住用户）。
    const existing = [row("e1", "Unit 1 Exam", "2026-09-22")]
    const forced = {
      examName: "Chem 1A exam",
      examDate: "2026-09-22",
      examTime: null,
      location: null,
      targetExamId: null,
    }
    const [r] = resolveExamTargets([forced], existing)
    check("显式「新增」压过同日候选", r.kind === "create")
  }
  {
    // 用户挑了「覆盖这一条」→ 照办。
    const existing = [row("e1", "Unit 1 Exam", "2026-09-22")]
    const picked = {
      examName: "Chem 1A exam",
      examDate: "2026-09-22",
      examTime: null,
      location: null,
      targetExamId: "e1",
    }
    const [r] = resolveExamTargets([picked], existing)
    check("挑选目标 → update 那一条", r.kind === "update" && r.target?.id === "e1")
  }
  {
    // 日期待定（null）无从按日比对 → 保持老行为（新增），不制造假候选。
    const existing = [row("e1", "Unit 1 Exam", null)]
    const tbd = { examName: "Chem 1A exam", examDate: null, examTime: null, location: null }
    const [r] = resolveExamTargets([tbd], existing)
    check("日期待定 → 不按同日捏候选", r.kind === "create", JSON.stringify(r.kind))
  }

  // ⑨ 归一与通称判定的边界：不许把 Exam 1 与 Midterm 1 当成一场。
  check("normalizeExamName 去标点空格", normalizeExamName("Midterm-1 (Exam)") === "midterm1exam")
  check("Midterm 1 与 Exam 1 键不同", normalizeExamName("Midterm 1") !== normalizeExamName("Exam 1"))
  check("isGenericExamName('the exam')", isGenericExamName("the exam"))
  check("isGenericExamName('考试')", isGenericExamName("考试"))
  check("isGenericExamName('Midterm 1') = false", !isGenericExamName("Midterm 1"))

  // ⑩ 改期文案：回执与界面共用同一句（两处各拼一遍就会说法不一）。
  {
    const target = row("e1", "Midterm 1", "2026-09-28")
    const label = examChangeLabel(
      { examName: "Midterm 1", examDate: "2026-09-27", examTime: null, location: null },
      target,
    )
    check("改期文案含 before → after", label.includes("2026-09-28") && label.includes("2026-09-27"), label)
  }

  // ⑪ 词级同义折叠：test ≡ exam（口语同指一场）—— 2026-09-19 Steven 实测：
  // Chem 1A 已有「Unit 1 Exam · 9/22」，输入「Unit 1 test 改期到 9/29」必须落到它，而不是新增。
  {
    const existing = [row("e1", "Unit 1 Exam", "2026-09-22")]
    const input = { examName: "Unit 1 test", examDate: "2026-09-29", examTime: null, location: null }
    const [r] = resolveExamTargets([input], existing)
    check("Unit 1 test ≡ Unit 1 Exam → update", r.kind === "update" && r.target?.id === "e1", JSON.stringify(r))
  }
  {
    // 折叠只限 test ≡ exam 这一对：quiz / midterm / final 与 exam 仍是不同的考试。
    const existing = [row("e1", "Exam 1", "2026-09-22")]
    const quiz = { examName: "Quiz 1", examDate: "2026-09-29", examTime: null, location: null }
    const [rq] = resolveExamTargets([quiz], existing)
    check("Quiz 1 ≠ Exam 1 → create", rq.kind === "create", JSON.stringify(rq))
    const midterm = { examName: "Midterm 1", examDate: "2026-09-29", examTime: null, location: null }
    const [rm] = resolveExamTargets([midterm], existing)
    check("Midterm 1 ≠ Exam 1 → create（红线仍成立）", rm.kind === "create", JSON.stringify(rm))
    const [rd] = resolveExamTargets(
      [{ examName: "Unit 1 test", examDate: "2026-09-22", examTime: null, location: null }],
      [row("e1", "Unit 1 Exam", "2026-09-22")],
    )
    check("折叠后一模一样 → duplicate", rd.kind === "duplicate", JSON.stringify(rd))
  }
}

console.log("schema ↔ 校验器 一致性")
{
  const props = COURSE_UPDATE_PARSE_SCHEMA.properties ?? {}
  check("schema 要求五个顶层字段", (COURSE_UPDATE_PARSE_SCHEMA.required ?? []).length === 5)

  const examProps = props.exams?.items?.properties ?? {}
  const examRequired = props.exams?.items?.required ?? []
  check("exams.required 含 sourceExcerpt", examRequired.includes("sourceExcerpt"))
  check("exams 字段与校验器读的字段同名", examRequired.every((key) => key in examProps))

  const gradeProps = props.gradeComponents?.items?.properties ?? {}
  const gradeRequired = props.gradeComponents?.items?.required ?? []
  check("gradeComponents.required 含 sourceExcerpt", gradeRequired.includes("sourceExcerpt"))
  check("gradeComponents 字段与校验器读的字段同名", gradeRequired.every((key) => key in gradeProps))

  // P0-3-34：scores。这条通道的校验器在 `lib/tasks/score.ts`（不在本文件的 validate* 里），
  // 所以这里只断言"模型必须按形状给"—— 少一个字段模型就得整条不产出，而不是给 null。
  const scoreProps = props.scores?.items?.properties ?? {}
  const scoreRequired = props.scores?.items?.required ?? []
  check("顶层 required 含 scores", (COURSE_UPDATE_PARSE_SCHEMA.required ?? []).includes("scores"))
  check("scores.required 含 sourceExcerpt", scoreRequired.includes("sourceExcerpt"))
  check(
    "scores.required 含 score 与 possible（缺一不可）",
    scoreRequired.includes("score") && scoreRequired.includes("possible"),
    scoreRequired.join("|"),
  )
  check("scores 字段与 properties 同名", scoreRequired.every((key) => key in scoreProps))
  check(
    "scores.score / possible 是 number（不许 null）",
    scoreProps.score?.type === "number" && scoreProps.possible?.type === "number",
    `score=${String(scoreProps.score?.type)} possible=${String(scoreProps.possible?.type)}`,
  )
  check("scores.title 是 string（检索靠它）", scoreProps.title?.type === "string")

  // tasks 里不该再出现 exam —— 解禁是"搬到 exams 字段"，不是"放宽 tasks"。
  const taskTypes = props.tasks?.items?.properties?.taskType?.enum ?? []
  check("tasks.taskType 仍不含 exam", !taskTypes.includes("exam"), taskTypes.join("|"))
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
