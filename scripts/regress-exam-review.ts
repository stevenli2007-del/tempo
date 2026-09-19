/**
 * P0-3-31 回归：考试复习模式的**判定层**（不依赖数据库、不依赖网络、不调 LLM）。
 *
 * 运行：`npx -y tsx scripts/regress-exam-review.ts`（package.json 的 `regress:exam-review`）。
 *
 * 钉死这几件事（每一条都对应一个"全绿但静默错"的真实陷阱）：
 * 1. **按考试名的推荐**：`Midterm 1` 的词元 `[midterm, 1]` 必须同时命中
 *    `PracticeMidterm1_F23.pdf` —— 但它**不能**命中 `PracticeMidterm2_F23.pdf`
 *    （少一个 `1`）。名字对不上时靠 `isExamLike` 兜底，而不是把整门课的讲义都推出来。
 * 2. **出卷候选只有 past exam**（本卡验收③）：答案 key 与讲义都**不算**卷子；
 *    勾选里没有卷子 ⇒ 候选为空 ⇒ 页面必须禁用「出卷」按钮（绝不降级让 LLM 出新题，ADR-027）。
 * 3. **`ref` 只认给定的编号**：模型编出来的 `f9` 必须被丢掉并计数 ——
 *    否则界面按 ref 去清单里找标签时找不到，会把一段内容挂到空处。
 * 4. **清单差量**：任一份材料的版本变了 / 勾选集合变了 ⇒ 必须重算。
 *    漏判的后果是用户拿着**过期**的（甚至是别的材料的）总结。
 * 5. **上传件校验**：类型 / 大小 / 文件名清理 —— 前端与后端共用同一套规则。
 * 6. **红线写进了 prompt**：不许出题 / 不许给答案 / 要点必须挂回正确的那一份。
 *    这三条是本卡的可信度所在，而 prompt 是会被后人"顺手改得通顺一点"的。
 */

import { normalizeExamName } from "@/lib/course-update/exam-match"
import { isExamLike } from "@/lib/practice-test/pairing"
import {
  buildExamReviewInput,
  buildExamReviewMessages,
  MAX_KEY_TOPICS,
  MAX_POINTS_PER_FILE,
  validateExamReviewOutput,
} from "@/lib/review/prompt"
import { paperCandidates, recommendExamFiles } from "@/lib/review/recommend"
import type { RecommendableFile } from "@/lib/review/recommend"
import { sameManifest } from "@/lib/review/manifest"
import type { ReviewManifestItem } from "@/lib/review/manifest"
import {
  REVIEW_MAX_FILE_SIZE_BYTES,
  buildReviewStoragePath,
  extractExtension,
  isAllowedReviewExtension,
  sanitizeFileName,
  validateReviewUploadInput,
} from "@/lib/review/storage"

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

const file = (id: string, displayName: string, folderPath = ""): RecommendableFile => ({
  id,
  displayName,
  folderPath,
})

// ---------------------------------------------------------------------------
console.log("\n[1] 按考试名推荐资料")
// ---------------------------------------------------------------------------
{
  const examName = "Midterm 1"
  const files: RecommendableFile[] = [
    // 名字同时含 midterm 与 1 → name 命中。
    file("a", "PracticeMidterm1_F23.pdf", "Practice Exams/Unit 1 Exam"),
    // 少一个 `1` → 不是 name 命中；但 isExamLike（含 midterm）→ exam-like 兜底。
    file("b", "PracticeMidterm2_F23.pdf", "Practice Exams/Unit 1 Exam"),
    // 答案 key：名字也含 midterm 与 1 → name 命中（复习时答案是要读的资料）。
    file("c", "PracticeMidterm1KEY_F23.pdf", "Practice Exams/Unit 1 Exam/Answer Keys"),
    // 讲义：既不含考试名词元、也不 exam-like → 不推荐。
    file("d", "Lecture 01 Intro.pdf", "Lectures"),
    // 无后缀但 MIME 是 PDF 的真实情况（3-19b 实测过）：靠 isExamLike 兜底。
    file("e", "Weekly Review 1 - PDF", "Reviews"),
  ]

  const recommended = recommendExamFiles({ examName, files })
  const ids = recommended.map((entry) => entry.file.id)

  check("name 命中的排在最前", ids[0] === "a", `实际首位: ${ids[0]}`)
  check("含 midterm 但不含编号 2 的那份靠 exam-like 兜底", ids.includes("b"))
  check("答案 key 也被推荐（复习要读它）", ids.includes("c"))
  check("讲义不被推荐", !ids.includes("d"))
  check("无后缀但 exam-like 的也能兜底进来", ids.includes("e"))
  check(
    "排序可复现：name 命中的两份都在 exam-like 之前",
    recommended.findIndex((entry) => entry.reason === "exam-like") >
      recommended.filter((entry) => entry.reason === "name").length - 1,
  )

  // 中文考试名：词元会被切成空 ⇒ 全部落到 exam-like 兜底，而不是"一个都不推"。
  const cn = recommendExamFiles({ examName: "期中考试", files })
  check("中文考试名回落到 exam-like 兜底（不空手）", cn.length > 0, `实际 ${cn.length} 份`)
}

// ---------------------------------------------------------------------------
console.log("\n[2] 出卷候选只认 past exam（验收③）")
// ---------------------------------------------------------------------------
{
  const selected: RecommendableFile[] = [
    file("exam", "PracticeMidterm1_F23.pdf", "Practice Exams"),
    file("key", "PracticeMidterm1KEY_F23.pdf", "Practice Exams/Answer Keys"),
    file("lec", "Lecture 05.pdf", "Lectures"),
  ]
  const candidates = paperCandidates(selected)
  check("只有那份试卷进候选", candidates.length === 1 && candidates[0].id === "exam")
  check("答案 key 不算卷子", !candidates.some((c) => c.id === "key"))
  check("讲义不算卷子", !candidates.some((c) => c.id === "lec"))
  check("没有卷子时候选为空（页面据此禁用按钮）", paperCandidates([file("lec", "Lecture 1.pdf")]).length === 0)

  // 与资料区「自测卷」按钮共用同一个 isExamLike —— 两处判定不许分叉。
  check(
    "候选判定与 isExamLike 一致",
    candidates.every((c) => isExamLike(c)) &&
      selected.filter((f) => isExamLike(f)).length === candidates.length,
  )
}

// ---------------------------------------------------------------------------
console.log("\n[3] 复习总结的校验（ref 只认给定的编号）")
// ---------------------------------------------------------------------------
{
  const refs = ["f1", "f2", "f3"]

  const ok = validateExamReviewOutput(
    {
      overview: "覆盖第 1-3 章",
      files: [
        { ref: "f1", points: ["要点 A"] },
        { ref: "f2", points: ["要点 B", "要点 C"] },
      ],
      keyTopics: ["极限", "导数"],
    },
    refs,
  )
  check("正常输出通过", ok.ok === true)
  if (ok.ok) {
    check("没给的 ref 补成空要点（界面仍要画出这一份）", ok.value.files.length === 3)
    check(
      "缺失的 ref 排在它该在的位置（顺序可复现）",
      ok.value.files.map((f) => f.ref).join(",") === "f1,f2,f3",
    )
    check("f3 的要点为空数组", (ok.value.files.find((f) => f.ref === "f3")?.points ?? []).length === 0)
  }

  const fabricated = validateExamReviewOutput(
    { overview: "x", files: [{ ref: "f9", points: ["编的"] }], keyTopics: [] },
    refs,
  )
  check("编造的 ref 被丢掉并计数", fabricated.ok === true && fabricated.ok && fabricated.dropped >= 1)

  const dup = validateExamReviewOutput(
    {
      overview: "x",
      files: [
        { ref: "f1", points: ["first"] },
        { ref: "f1", points: ["second"] },
      ],
      keyTopics: [],
    },
    refs,
  )
  check(
    "同一 ref 出现两次只留第一条",
    dup.ok === true && dup.ok && dup.value.files.filter((f) => f.ref === "f1").length === 1,
  )
  check("重复的那条被计数", dup.ok === true && dup.ok && dup.dropped >= 1)

  const over = validateExamReviewOutput(
    {
      overview: "x",
      files: [{ ref: "f1", points: Array.from({ length: MAX_POINTS_PER_FILE + 3 }, (_, i) => `p${i}`) }],
      keyTopics: Array.from({ length: MAX_KEY_TOPICS + 2 }, (_, i) => `t${i}`),
    },
    refs,
  )
  check(
    "每份材料的要点被压到上限",
    over.ok === true && over.ok && (over.value.files.find((f) => f.ref === "f1")?.points.length ?? 0) === MAX_POINTS_PER_FILE,
  )
  check("重点被压到上限", over.ok === true && over.ok && over.value.keyTopics.length === MAX_KEY_TOPICS)
  check("超量被计数上报（不是静默 slice）", over.ok === true && over.ok && over.dropped >= 5)

  const empty = validateExamReviewOutput({ overview: "", files: [], keyTopics: [] }, refs)
  check("三者全空 ⇒ 判失败（这份总结没有任何内容）", empty.ok === false)

  const notObject = validateExamReviewOutput("字符串", refs)
  check("非对象输出判失败", notObject.ok === false)
}

// ---------------------------------------------------------------------------
console.log("\n[4] 材料清单的差量比对")
// ---------------------------------------------------------------------------
{
  const base: ReviewManifestItem[] = [
    { ref: "f1", kind: "file", id: "a", label: "A.pdf", url: "https://x/1", modifiedAt: "2026-09-01T00:00:00Z" },
    { ref: "f2", kind: "extra", id: "b", label: "B.pdf", url: null, modifiedAt: null },
  ]
  const clone = base.map((item) => ({ ...item }))

  check("完全相同 ⇒ 命中缓存", sameManifest(base, clone))
  check(
    "同一时刻的等价写法视为相同（瞬时比较，不是字符串比较）",
    sameManifest(base, [
      { ...base[0], modifiedAt: "2026-09-01T07:00:00+07:00" },
      { ...base[1] },
    ]),
  )
  check(
    "文件版本变了 ⇒ 必须重算",
    !sameManifest(base, [{ ...base[0], modifiedAt: "2026-09-02T00:00:00Z" }, { ...base[1] }]),
  )
  check("少了/多了一份 ⇒ 必须重算", !sameManifest(base, [base[0]]))
  check(
    "换了另一份文件 ⇒ 必须重算",
    !sameManifest(base, [{ ...base[0], id: "z" }, { ...base[1] }]),
  )
  check(
    "顺序变了 ⇒ 重算（总结与当前勾选严格对应，这个代价是有意的）",
    !sameManifest(base, [base[1], base[0]]),
  )
}

// ---------------------------------------------------------------------------
console.log("\n[5] 上传件的校验（前端与后端共用）")
// ---------------------------------------------------------------------------
{
  check("pdf 通过", validateReviewUploadInput({ fileName: "a.pdf", fileSize: 1024 }).ok === true)
  check("pptx 通过", validateReviewUploadInput({ fileName: "a.pptx", fileSize: 1024 }).ok === true)
  check("png 被拒（415）", (() => {
    const r = validateReviewUploadInput({ fileName: "a.png", fileSize: 1024 })
    return r.ok === false && r.status === 415
  })())
  check("没有文件名被拒", validateReviewUploadInput({ fileSize: 1024 }).ok === false)
  check("没有大小被拒", validateReviewUploadInput({ fileName: "a.pdf" }).ok === false)
  check("超过 20MB 被拒（413）", (() => {
    const r = validateReviewUploadInput({ fileName: "a.pdf", fileSize: REVIEW_MAX_FILE_SIZE_BYTES + 1 })
    return r.ok === false && r.status === 413
  })())
  check("恰好 20MB 通过", validateReviewUploadInput({ fileName: "a.pdf", fileSize: REVIEW_MAX_FILE_SIZE_BYTES }).ok === true)

  check("文件名里的路径分隔符被清掉", sanitizeFileName("../../etc/passwd.pdf") === ".._.._etc_passwd.pdf")
  check("取扩展名（小写）", extractExtension("A.PDF") === "pdf")
  check("无扩展名 → null", extractExtension("noext") === null)
  check("允许的扩展名判定", isAllowedReviewExtension("docx") && !isAllowedReviewExtension("png"))

  const path = buildReviewStoragePath("uid-1", "course-1", "file-1", "pdf")
  check("Storage 路径首段是 uid（RLS 判据）", path.split("/")[0] === "uid-1")
  check("Storage 路径形如 uid/course/file.ext", path === "uid-1/course-1/file-1.pdf")
}

// ---------------------------------------------------------------------------
console.log("\n[6] prompt 里的红线")
// ---------------------------------------------------------------------------
{
  const messages = buildExamReviewMessages({
    courseName: "Physics 7A",
    examLabel: "Midterm 1",
    sources: [{ ref: "f1", label: "A.pdf", text: "内容" }],
    rawChars: 2,
    truncated: false,
  })
  const all = messages.map((m) => m.content).join("\n")

  check("明说不是出题人 / 绝不编写题目", /不是出题人/.test(all) && /编写题目/.test(all))
  check("明说不给答案", /给答案/.test(all))
  check("要求 ref 挂回正确的那一份", /ref/.test(all) && /f1/.test(all))
  check("要求只依据给定文字（不补常识）", /只依据/.test(all))
  check("要求不声称覆盖全部", /覆盖/.test(all))
  check("system 与 user 两条都在", messages.length === 2 && messages[0].role === "system" && messages[1].role === "user")
}

// ---------------------------------------------------------------------------
console.log("\n[7] 总预算截断（多份材料等分额度）")
// ---------------------------------------------------------------------------
{
  const big = "x".repeat(30_000)
  const input = buildExamReviewInput({
    courseName: "C",
    examLabel: "E",
    sources: [
      { ref: "f1", label: "A", text: big },
      { ref: "f2", label: "B", text: big },
    ],
  })
  check("超过总上限 ⇒ 标记截断", input.truncated === true)
  check("原始字符数被如实记下", input.rawChars === 60_000)
  check(
    "等分额度（而不是让后一份一份都进不去）",
    input.sources[0].text.length === 20_000 && input.sources[1].text.length === 20_000,
    `实际 ${input.sources.map((s) => s.text.length).join(" / ")}`,
  )

  const small = buildExamReviewInput({
    courseName: "C",
    examLabel: "E",
    sources: [{ ref: "f1", label: "A", text: "短" }],
  })
  check("没过上限就不标截断", small.truncated === false)
}

// ---------------------------------------------------------------------------
console.log("\n[8] 复习键用的是考试身份（重解析不丢数据）")
// ---------------------------------------------------------------------------
{
  check(
    "Midterm 1 与 Midterm1 是同一个键（重解析换了 uuid 也认得出同一场考试）",
    normalizeExamName("Midterm 1") === normalizeExamName("Midterm1"),
  )
  check(
    "不同场次的考试键不同（不会把 Midterm 2 的数据挂到 Midterm 1 上）",
    normalizeExamName("Midterm 1") !== normalizeExamName("Midterm 2"),
  )
}

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exitCode = 1
}
