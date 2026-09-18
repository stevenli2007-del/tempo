/**
 * P0-3-20 回归：大纲漂移的**判定层**（不依赖数据库、不依赖网络、不调模型）。
 *
 * 运行：`npm run regress:syllabus-drift`
 *
 * 钉死四件事，它们分叉起来都是"两边都绿、只有肉眼或真机能发现"的那种：
 * 1. `pickSyllabusFile`：这门课的大纲到底是哪一个文件（**必须是全序**）；
 * 2. `decideDrift`：该不该出提案（首次不提案、换文件不诬告、比 epoch 不比字符串）；
 * 3. `validateDriftOutput`：模型输出能信到什么程度（缺摘录的条目不收、编的 id 挡住）；
 * 4. `toMessageView` 的漂移分档：按钮什么时候能点（**差异没算好就不许点**）。
 *
 * 第 4 条与 `regress:messages` 有重叠，但**分工不同**：那边管"通用的可用性规则"，
 * 这里管"漂移这个类型特有的四档状态"。两处都断言是刻意的 —— 这类判定写两遍
 * 都会绿，只有真的有人改坏其中一处才会分叉（P0-3-15 的教训）。
 */

import { isApplierReady, APPLIER_READY_TYPES } from "@/lib/messages/registry"
import { undoMessage } from "@/lib/messages/undo"
import { toMessageView } from "@/lib/messages/view"
import {
  decideDrift,
  pickSyllabusFile,
  toSyllabusFileCandidate,
  type CourseFileDriftRow,
  type SyllabusFileCandidate,
} from "@/lib/syllabus-drift/files"
import {
  MAX_ADDED_EXAMS,
  attachBeforeValues,
  driftSchema,
  formatExamLine,
  validateDriftOutput,
  type CurrentExam,
} from "@/lib/syllabus-drift/prompt"
import { buildDriftPayload } from "@/lib/sync/syllabus-drift"
import type { Message, MessagePayload } from "@/types/message"

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

// ---------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------

function file(overrides: Partial<SyllabusFileCandidate> = {}): SyllabusFileCandidate {
  return {
    id: "f1",
    canvasFileId: "9001",
    displayName: "Syllabus.pdf",
    folderPath: "",
    contentType: "application/pdf",
    sizeBytes: 1024,
    modifiedAt: "2026-09-10T00:00:00Z",
    isDeleted: false,
    fileUrl: "https://bcourses.berkeley.edu/courses/1/files/9001",
    ...overrides,
  }
}

function anchor(overrides: Partial<{ syllabusFileId: string | null; syllabusSeenModifiedAt: string | null }> = {}) {
  return { syllabusFileId: null, syllabusSeenModifiedAt: null, ...overrides }
}

const NOW = "2026-09-10T00:00:00Z"

console.log("pickSyllabusFile（选哪一个是大纲）")
{
  check("空数组 → null", pickSyllabusFile([]) === null)

  // 名字匹配：大小写不敏感 + 中文「大纲」。
  check("SYLLABUS.PDF 大小写不敏感", pickSyllabusFile([file({ displayName: "SYLLABUS.PDF" })]) !== null)
  check("中文「大纲」也认", pickSyllabusFile([file({ displayName: "课程大纲.pdf" })]) !== null)

  // 🔴 刻意不认 outline / schedule：那是"课程安排"，认了会把周计划选成大纲。
  check(
    "不认 outline",
    pickSyllabusFile([file({ displayName: "Course Outline.pdf" })]) === null,
  )
  check(
    "不认 schedule",
    pickSyllabusFile([file({ displayName: "Weekly Schedule.pdf" })]) === null,
  )

  // 🔴 size_bytes 未知 → 不当候选（ADR-026：判不了成本宁可拒绝）。
  check(
    "size_bytes 为 null 不当候选",
    pickSyllabusFile([file({ sizeBytes: null })]) === null,
  )
  // 已软删除 → 不当候选。
  check("已删除不当候选", pickSyllabusFile([file({ isDeleted: true })]) === null)
  // 抽不动（图片）→ 不当候选：选它等于把用户导到一个必然失败的按钮。
  check(
    "图片型不当候选（抽不动）",
    pickSyllabusFile([file({ displayName: "Syllabus.jpg", contentType: "image/jpeg" })]) === null,
  )
  check(
    "压缩包不当候选",
    pickSyllabusFile([file({ displayName: "Syllabus.zip", contentType: "application/zip" })]) === null,
  )
  // 名字带 pdf 字面量但真后缀是 zip（P0-3-19 踩过的同一个坑）。
  check(
    "notes.pdf.zip 不算 PDF",
    pickSyllabusFile([file({ displayName: "Syllabus.pdf.zip", contentType: "application/zip" })]) === null,
  )

  // 排序：根目录优先。
  const root = file({ id: "root", displayName: "Syllabus.pdf", folderPath: "" })
  const archived = file({ id: "arch", displayName: "Syllabus.pdf", folderPath: "Archive" })
  check("根目录优先于子目录", pickSyllabusFile([archived, root])?.id === "root")
  check("顺序反过来也是同一个答案", pickSyllabusFile([root, archived])?.id === "root")

  // 排序：同目录 PDF 优先（docx 多为老师的工作稿）。
  const docx = file({ id: "docx", displayName: "Syllabus.docx", contentType: null })
  check("同目录 PDF 优先", pickSyllabusFile([docx, root])?.id === "root")

  // 排序：名字短优先。
  const short = file({ id: "short", displayName: "Syllabus.pdf" })
  const long = file({ id: "long", displayName: "Syllabus old version 2020 final.pdf" })
  check("短名字优先（越短越像正本）", pickSyllabusFile([long, short])?.id === "short")

  // 🔴 全序：把输入打乱，答案必须完全一样。否则两轮同步可能选中不同文件
  //    → 差量判定永远判"变了" → 每轮都投一份提案（3-20 最贵的 bug）。
  const same = [
    file({ id: "a", displayName: "Syllabus 2026.pdf" }),
    file({ id: "b", displayName: "Syllabus 2026.pdf" }),
    file({ id: "c", displayName: "Syllabus 2026.pdf" }),
  ]
  const p1 = pickSyllabusFile(same)
  const p2 = pickSyllabusFile([...same].reverse())
  const p3 = pickSyllabusFile([same[1], same[2], same[0]])
  check("全序：三个同名同版本 → 每次选同一个", p1?.id === p2?.id && p2?.id === p3?.id, `${p1?.id} / ${p2?.id} / ${p3?.id}`)
  check("全序收尾按 id 升序（确定性）", p1?.id === "a", String(p1?.id))
}

console.log("decideDrift（该不该出提案）")
{
  // 没有候选 → 跳过（常态：没开 Files 区 / 没传大纲）。
  check("无候选 → skip/no_file", decideDrift({ anchor: anchor(), candidate: null }).kind === "skip")

  // 首次核对 → 只记基线，**不提案**（否则 6~13 门课第一轮各塞一条噪音）。
  const first = decideDrift({ anchor: anchor(), candidate: file() })
  check("首次核对 → baseline", first.kind === "baseline", first.kind)
  check(
    "baseline 带回选中的文件（供写锚点）",
    first.kind === "baseline" && first.candidate.id === "f1",
  )

  // 同文件、同版本 → 不动。
  const same = decideDrift({
    anchor: anchor({ syllabusFileId: "f1", syllabusSeenModifiedAt: NOW }),
    candidate: file(),
  })
  check("同文件同版本 → skip/unchanged", same.kind === "skip" && same.reason === "unchanged")

  // 🔴 版本比较必须**按时间值**，不能比字符串：
  //    PostgREST 回 `+00:00`、Canvas 给 `Z`，比字符串会永远判"变了"→ 每轮同步都提案。
  const tz = decideDrift({
    anchor: anchor({ syllabusFileId: "f1", syllabusSeenModifiedAt: "2026-09-10T00:00:00+00:00" }),
    candidate: file({ modifiedAt: "2026-09-10T00:00:00Z" }),
  })
  check("`+00:00` vs `Z` 同一时刻 → unchanged（比 epoch 不比字符串）", tz.kind === "skip", tz.kind)

  // 同文件、版本变了 → 提案。
  const moved = decideDrift({
    anchor: anchor({ syllabusFileId: "f1", syllabusSeenModifiedAt: NOW }),
    candidate: file({ modifiedAt: "2026-09-12T00:00:00Z" }),
  })
  check("同文件版本变了 → propose", moved.kind === "propose", moved.kind)
  check("propose 带回选中的文件", moved.kind === "propose" && moved.candidate.id === "f1")

  // 🔴 换了另一个文件 → 也走 baseline（两份文档之间没有共同锚点，
  //    此刻说"内容变了"是诬告 —— 说不定只是老师重命名了一次）。
  const switched = decideDrift({
    anchor: anchor({ syllabusFileId: "old", syllabusSeenModifiedAt: NOW }),
    candidate: file({ id: "new" }),
  })
  check("换文件 → baseline（不诬告）", switched.kind === "baseline", switched.kind)

  // 🔴 modified_at 缺失：既不报变更（会诬告），也不写成"已核对"（会把这门课永久锁死）。
  const noVersion = decideDrift({
    anchor: anchor({ syllabusFileId: "f1", syllabusSeenModifiedAt: NOW }),
    candidate: file({ modifiedAt: null }),
  })
  check("modified_at 缺失 → 只重记基线", noVersion.kind === "baseline", noVersion.kind)
  const noVersionNoAnchor = decideDrift({
    anchor: anchor({ syllabusFileId: "f1", syllabusSeenModifiedAt: null }),
    candidate: file({ modifiedAt: null }),
  })
  check(
    "modified_at 缺失 + 无基线 → unchanged（别每轮都写库）",
    noVersionNoAnchor.kind === "skip",
    noVersionNoAnchor.kind,
  )

  // 锚点只有一半（迁移前的老行 / 半截写入）→ 一律按"没核对过"处理。
  check(
    "只有 fileId 没有版本 → baseline",
    decideDrift({ anchor: anchor({ syllabusFileId: "f1" }), candidate: file() }).kind === "baseline",
  )
  check(
    "只有版本没有 fileId → baseline",
    decideDrift({ anchor: anchor({ syllabusSeenModifiedAt: NOW }), candidate: file() }).kind === "baseline",
  )
}

console.log("toSyllabusFileCandidate（库行 → 候选，唯一映射点）")
{
  const row: CourseFileDriftRow = {
    id: "f1",
    course_id: "c1",
    canvas_file_id: "9001",
    display_name: "Syllabus.pdf",
    folder_path: "",
    content_type: "application/pdf",
    size_bytes: 2048,
    modified_at: NOW,
    file_url: "https://bcourses.berkeley.edu/courses/1/files/9001",
    is_deleted: false,
  }
  const candidate = toSyllabusFileCandidate(row)
  check("id 映射", candidate.id === "f1")
  check("canvasFileId 映射（下载要用）", candidate.canvasFileId === "9001")
  check("sizeBytes 映射", candidate.sizeBytes === 2048)
  check("modifiedAt 映射（差量唯一依据）", candidate.modifiedAt === NOW)
  check("fileUrl 映射（提案里的原文入口）", candidate.fileUrl.endsWith("/files/9001"))
}

console.log("validateDriftOutput（模型输出能信到什么程度）")
{
  const allowed = ["e1", "e2"]

  const rawExam = {
    examName: "Midterm 2",
    examDate: "2026-10-20",
    examTime: "7-9pm",
    location: "Dwinelle 155",
    sourceExcerpt: "Midterm 2: October 20, 7-9pm",
  }
  const good = validateDriftOutput(
    { examsAdded: [rawExam], examsChanged: [], gradeComponentsAdded: [], notes: [], uncertain: false },
    allowed,
  )
  check("合法输出 → ok", good.ok === true)
  check(
    "新增考试收下",
    good.ok && good.draft.addedExams.length === 1 && good.draft.addedExams[0].examName === "Midterm 2",
  )
  check("uncertain=false 透传", good.ok && good.draft.uncertain === false)

  // 空数组**合法** —— 而且不能因此被当成失败。
  const empty = validateDriftOutput(
    { examsAdded: [], examsChanged: [], gradeComponentsAdded: [], notes: [], uncertain: false },
    allowed,
  )
  check("全空 → ok（不是失败）", empty.ok === true)

  // 🔴 缺键不能崩（老 prompt / 模型漏键）。五个键是 required，
  //    但**校验器要能容忍键缺席**：这是 P0-3-19b 那个 schema_mismatch 的另一面。
  const missingKeys = validateDriftOutput({}, allowed)
  check("五个键全缺 → 仍 ok（按空处理，不崩）", missingKeys.ok === true)
  check(
    "键缺 → uncertain 按 true（更安全）",
    missingKeys.ok && missingKeys.draft.uncertain === true,
  )
  check("键缺 → 各类条目为空数组", missingKeys.ok && missingKeys.draft.addedExams.length === 0)

  // 非对象 → 明确失败。
  check("非对象 → 失败", validateDriftOutput(null, allowed).ok === false)
  check("字符串 → 失败", validateDriftOutput("nope", allowed).ok === false)

  // 🔴 没有摘录的条目**不收**（ADR-021 解禁 exam 产出的前提）。
  const noExcerpt = validateDriftOutput(
    { examsAdded: [{ ...rawExam, sourceExcerpt: "   " }], uncertain: false },
    allowed,
  )
  check("空摘录 → 该条被跳过", noExcerpt.ok && noExcerpt.draft.addedExams.length === 0)
  check("空摘录 → 有跳过说明", noExcerpt.ok && noExcerpt.skipped.length === 1)
  const noExcerptKey = validateDriftOutput(
    { examsAdded: [{ examName: "Quiz 1", examDate: "2026-09-20", examTime: null, location: null }] },
    allowed,
  )
  check("缺 sourceExcerpt 键 → 也被跳过", noExcerptKey.ok && noExcerptKey.draft.addedExams.length === 0)

  // 🔴 变动必须回指**这门课真实存在**的 exam_dates.id（挡模型编 id）。
  const invented = validateDriftOutput(
    { examsChanged: [{ ...rawExam, examDateId: "not-a-real-id" }] },
    allowed,
  )
  check("编的 examDateId → 跳过", invented.ok && invented.draft.changes.length === 0)
  check("编 id → 说清原因", invented.ok && invented.skipped.length === 1)
  const noId = validateDriftOutput({ examsChanged: [rawExam] }, allowed)
  check("没有 examDateId → 跳过", noId.ok && noId.draft.changes.length === 0)
  const realId = validateDriftOutput({ examsChanged: [{ ...rawExam, examDateId: "e2" }] }, allowed)
  check("真实 examDateId → 收下", realId.ok && realId.draft.changes.length === 1)
  check("收下时 id 正确", realId.ok && realId.draft.changes[0].id === "e2")

  // 🔴 超量必须**裁掉并计数**，静默 slice 是降级（用户看到 10 条会以为那就是全部）。
  const flood = validateDriftOutput(
    { examsAdded: Array.from({ length: MAX_ADDED_EXAMS + 4 }, () => rawExam) },
    allowed,
  )
  check(
    `超上限裁到 ${MAX_ADDED_EXAMS} 条`,
    flood.ok && flood.draft.addedExams.length === MAX_ADDED_EXAMS,
    flood.ok ? String(flood.draft.addedExams.length) : "not ok",
  )
  check("超量计数 dropped=4", flood.ok && flood.dropped === 4, flood.ok ? String(flood.dropped) : "not ok")

  // 成绩构成的摘录同样必填（**这条校验器只查类型不查非空**，所以是本文件的闸在挡）。
  const comp = validateDriftOutput(
    {
      gradeComponentsAdded: [
        { name: "Final", weightPercent: 40, notes: null, sourceExcerpt: "Final 40%" },
        { name: "Homework", weightPercent: null, notes: null, sourceExcerpt: "" },
      ],
    },
    allowed,
  )
  check("成绩构成：有摘录的收下", comp.ok && comp.draft.addedComponents.length === 1)
  check("成绩构成：空摘录跳过", comp.ok && comp.draft.addedComponents.length === 1)
  check(
    "成绩构成：没写占比 → null（不是 0）",
    comp.ok && comp.draft.addedComponents[0].weightPercent === 40,
  )
  const noWeight = validateDriftOutput(
    { gradeComponentsAdded: [{ name: "Participation", notes: null, sourceExcerpt: "Participation 10%" }] },
    allowed,
  )
  check("缺 weightPercent → null", noWeight.ok && noWeight.draft.addedComponents[0].weightPercent === null)

  // 占比越界 → 跳该条。
  const badWeight = validateDriftOutput(
    { gradeComponentsAdded: [{ name: "X", weightPercent: 120, notes: null, sourceExcerpt: "X" }] },
    allowed,
  )
  check("占比 120 → 跳过", badWeight.ok && badWeight.draft.addedComponents.length === 0)

  // notes：非字符串丢掉、超上限截断。
  const notes = validateDriftOutput({ notes: ["a", "", 3, null, "b", "c", "d", "e", "f", "g"] }, allowed)
  check("notes 只留非空字符串（上限 5）", notes.ok && notes.draft.notes.length === 5, notes.ok ? String(notes.draft.notes.length) : "not ok")

  // uncertain 显式为 true → 保留（低置信度的来源）。
  const uncertain = validateDriftOutput({ uncertain: true }, allowed)
  check("uncertain=true 透传", uncertain.ok && uncertain.draft.uncertain === true)
  // 非布尔值 → 按不确定处理（宁可让用户多点一次，也不要让读不准的差异被一键接受）。
  const weird = validateDriftOutput({ uncertain: "yes" }, allowed)
  check("uncertain 非布尔 → 按 true", weird.ok && weird.draft.uncertain === true)
}

console.log("attachBeforeValues（旧值必须来自库，不来自模型）")
{
  const current: CurrentExam[] = [
    { id: "e1", examName: "Midterm 1", examDate: "2026-10-20", examTime: "7-9pm", location: null },
  ]
  const changes = [
    {
      id: "e1",
      examName: "Midterm 1",
      examDate: "2026-10-27",
      examTime: "7-9pm",
      location: null,
      sourceExcerpt: "Midterm 1 moved to Oct 27",
      before: "",
      after: formatExamLine("Midterm 1", "2026-10-27", "7-9pm"),
    },
    {
      id: "gone",
      examName: "Ghost",
      examDate: "2026-11-01",
      examTime: null,
      location: null,
      sourceExcerpt: "ghost",
      before: "",
      after: formatExamLine("Ghost", "2026-11-01", null),
    },
  ]
  const { changes: kept, missing } = attachBeforeValues(changes, current)
  check("找到目标 → 收下", kept.length === 1, String(kept.length))
  check("before 来自库里的旧值", kept[0]?.before === formatExamLine("Midterm 1", "2026-10-20", "7-9pm"), String(kept[0]?.before))
  check("找不到目标 → 进 missing 并丢弃", missing.length === 1 && missing[0] === "Ghost")

  // 模型绕了一圈、算完发现"根本没变" → 丢掉，别让用户点一次空确认。
  const noop = attachBeforeValues(
    [{ ...changes[0], examDate: "2026-10-20", after: formatExamLine("Midterm 1", "2026-10-20", "7-9pm") }],
    current,
  )
  check("before == after → 丢弃", noop.changes.length === 0, String(noop.changes.length))
}

console.log("driftSchema ↔ 校验器（两处必须同步改）")
{
  const schema = driftSchema() as {
    required?: string[]
    properties?: Record<string, unknown>
  }
  const required = schema.required ?? []
  check(
    "五个键都是必填（含 uncertain）",
    JSON.stringify([...required].sort()) ===
      JSON.stringify(["examsAdded", "examsChanged", "gradeComponentsAdded", "notes", "uncertain"]),
    `[${required}]`,
  )
  check(
    "required ⊆ properties（不会要求一个 schema 里没定义的键）",
    required.every((key) => key in (schema.properties ?? {})),
  )
  check(
    "properties 与 required 一一对应（没有「多定义却可选」的键）",
    Object.keys(schema.properties ?? {}).length === required.length,
  )
}

console.log("buildDriftPayload（同步侧建提案）")
{
  const target = file()
  const payload = buildDriftPayload({ courseId: "c1", courseName: "MATH 53", file: target })
  check("状态是 pending（差异还没算）", payload.driftStatus === "pending")
  check("带上课程", payload.courseId === "c1" && payload.courseName === "MATH 53")
  check("带上要核对的文件 id", payload.syllabusFileId === "f1")
  check("带上文件版本（这是「哪一版」的凭据）", payload.syllabusModifiedAt === NOW)
  // 🔴 原文入口必须是**拼出来的预览页**，不是 Canvas 返回的能力凭据 URL（ADR-026 第 3 条）。
  check("原文链接 = 自己拼的预览页", payload.sourceUrl === target.fileUrl)
  check("原文链接不含能力凭据参数", !String(payload.sourceUrl).includes("verifier"))
  check("此刻不标低置信度（差异还没算）", payload.confidence === "high")
  // 🔴 标题**不含结论**：此刻只知道"文件变了"，猜一个"改期了"就是诬告。
  check(
    "标题只说「有更新」，不说改了什么",
    payload.title.includes("有更新") && !payload.title.includes("改"),
    String(payload.title),
  )
  check(
    "占位文案告诉用户「一直不动怎么办」",
    (payload.details ?? []).some((line) => line.includes("原文")),
  )
}

console.log("toMessageView（漂移四档状态，P0-3-20）")
{
  function driftMessage(payload: Partial<MessagePayload>, status: Message["status"] = "pending"): Message {
    return {
      id: "d1",
      type: "syllabus_drift",
      status,
      createdAt: "2026-09-18T00:00:00Z",
      decidedAt: null,
      payload: {
        title: "MATH 53 的大纲文件有更新",
        courseId: "c1",
        courseName: "MATH 53",
        syllabusFileId: "f1",
        ...payload,
      },
    }
  }

  // 1. pending（差异还没算）→ 不可确认，且**要说清是在等核对**。
  const pending = toMessageView(driftMessage({ driftStatus: "pending" }))
  check("pending → 不可确认", pending.canAccept === false)
  check(
    "pending → 原因提到「核对」",
    !!pending.blockReason && pending.blockReason.includes("核对"),
    String(pending.blockReason),
  )
  check("pending → 需要请求核对", pending.needsDrift === true)

  // 2. ready（差异算好了）→ 可确认。
  const ready = toMessageView(driftMessage({ driftStatus: "ready" }))
  check("ready → 可确认", ready.canAccept === true)
  check("ready → 不再请求", ready.needsDrift === false)
  check("ready → 按钮叫「确认」", ready.confirmLabel === "确认", ready.confirmLabel)

  // 3. ready + low → 不许一键接受（卡片要求：低置信度不许一键接受）。
  const low = toMessageView(driftMessage({ driftStatus: "ready", confidence: "low" }))
  check("ready + 低置信度 → 不可确认", low.canAccept === false)
  check("低置信度 → 原因说置信度", !!low.blockReason && low.blockReason.includes("置信度低"), String(low.blockReason))

  // 4. failed → 不可确认，且原因**就是那句具体的失败**（比"置信度低"更该看见）。
  const failed = toMessageView(
    driftMessage({ driftStatus: "failed", confidence: "low", driftError: "这份文件抽不出文字" }),
  )
  check("failed → 不可确认", failed.canAccept === false)
  check("failed → 原因是具体原因（不是泛泛的置信度）", failed.blockReason === "这份文件抽不出文字", String(failed.blockReason))
  check("failed → 不再请求", failed.needsDrift === false)
  const failedNoReason = toMessageView(driftMessage({ driftStatus: "failed" }))
  check("failed 缺原因 → 有兜底文案", !!failedNoReason.blockReason)

  // 5. clean（核对完没差异）→ **可以"知道了"**（空写入），但不再请求核对。
  const clean = toMessageView(driftMessage({ driftStatus: "clean" }))
  check("clean → 可确认（走空写入）", clean.canAccept === true)
  check("clean → 按钮叫「知道了」", clean.confirmLabel === "知道了", clean.confirmLabel)
  check("clean → 不再请求", clean.needsDrift === false)
  // 低置信度的 clean 也要能"知道了"：它一个字段都不写，禁掉只会让人没法清掉它。
  const cleanLow = toMessageView(driftMessage({ driftStatus: "clean", confidence: "low" }))
  check("clean + 低置信度 → 仍可「知道了」", cleanLow.canAccept === true)

  // 6. driftStatus **缺失**（老数据 / 半截写入 / 手工改库）→ 不可确认。
  //    不能放行：放了 applier 只能回一句"还没核对出来"，就是"按钮说能点、点了报错"。
  const noStatus = toMessageView(driftMessage({}))
  check("缺 driftStatus → 不可确认", noStatus.canAccept === false)
  check("缺 driftStatus → 原因说缺少核对信息", !!noStatus.blockReason && noStatus.blockReason.includes("缺少核对"), String(noStatus.blockReason))
  check("缺 driftStatus → 不请求核对（定位字段也可能缺）", noStatus.needsDrift === false)

  // 7. needsDrift 的三个前提：message 仍 pending / 有 courseId / 有 syllabusFileId。
  check("已处理（accepted）→ 不再请求核对", toMessageView(driftMessage({ driftStatus: "pending" }, "accepted")).needsDrift === false)
  check(
    "缺 courseId → 不请求（请求过去也只会失败）",
    toMessageView({
      ...driftMessage({ driftStatus: "pending" }),
      payload: { title: "x", syllabusFileId: "f1", driftStatus: "pending" },
    }).needsDrift === false,
  )
  check(
    "缺 syllabusFileId → 不请求",
    toMessageView({
      ...driftMessage({ driftStatus: "pending" }),
      payload: { title: "x", courseId: "c1", driftStatus: "pending" },
    }).needsDrift === false,
  )

  // 8. 别的类型不受漂移逻辑影响（`driftStatus` 只对 syllabus_drift 生效）。
  const other = toMessageView({
    id: "m1",
    type: "material",
    status: "pending",
    createdAt: "2026-09-18T00:00:00Z",
    decidedAt: null,
    payload: { title: "资料更新", driftStatus: "pending" },
  })
  check("material 不会被 driftStatus 卡住", other.canAccept === true)
  check("material 不请求核对", other.needsDrift === false)

  // 9. 🔴 appliedCount 必须把**更正过的行**算进来（P0-3-20）。
  //    漂移最常见的形态就是"只更正了 1 条日期、没新增任何东西" ——
  //    漏掉它，用户会看到「✓ 已确认」却找不到撤销按钮。
  const restored = toMessageView(
    driftMessage(
      {
        driftStatus: "ready",
        applied: {
          examDateIds: [],
          gradeComponentIds: [],
          examRestores: [
            { id: "e1", examName: "Midterm 1", examDate: "2026-10-20", examTime: null, location: null, sourceExcerpt: null },
          ],
        },
      },
      "accepted",
    ),
  )
  check("只更正不新增 → appliedCount=1（撤销按钮要出来）", restored.appliedCount === 1, String(restored.appliedCount))
  check("appliedCount 不会把三种数组重复计", restored.appliedCount === 1, String(restored.appliedCount))
}

// 撤消散的断言需要 `await`（`undoMessage` 是异步的），所以这一块收在一个自执行的
// 异步函数里；**汇总输出也搬进来** —— 否则它会在上面的断言之前打印，
// 而且 `process.exit(1)` 会在异步断言跑完之前就把进程收掉（退出码看着是对的，实际漏测）。
void (async () => {
  console.log("注册表对称（能写就能撤）")
  {
    check("syllabus_drift 在 APPLIER_READY_TYPES 里", APPLIER_READY_TYPES.includes("syllabus_drift"))
    check("isApplierReady('syllabus_drift')", isApplierReady("syllabus_drift") === true)

    // 🔴 端到端验一次撤销器**真的注册上了**：没有 `applied` 的载荷会走"空操作 ok"分支
    //    （在碰 supabase 之前就返回），所以这里不需要真数据库。
    //    万一 `undo.ts` 的 UNDOERS 漏了这个键，会走 `undo_not_implemented` → 断言红。
    const empty = await undoMessage({
      type: "syllabus_drift",
      payload: { title: "x" },
      supabase: null as never,
      userId: "u1",
    })
    check("撤销器已注册（空写入 → 空操作 ok）", empty.ok === true, JSON.stringify(empty))

    // 没有任何可撤内容的漂移同样走空操作（`clean` / 「知道了」那类）。
    const noApplied = await undoMessage({
      type: "syllabus_drift",
      payload: { title: "x", applied: { examDateIds: [], gradeComponentIds: [], examRestores: [] } },
      supabase: null as never,
      userId: "u1",
    })
    check("三个数组全空 → 空操作 ok", noApplied.ok === true, JSON.stringify(noApplied))
  }

  console.log("")
  console.log(`结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) {
    process.exit(1)
  }
})()
