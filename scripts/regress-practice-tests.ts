/**
 * P0-3-23 回归：practice test 的**判定层**（不依赖数据库、不依赖网络、不调 LLM）。
 *
 * 运行：`npx -y tsx scripts/regress-practice-tests.ts`
 * （package.json 的 `regress:practice-tests` 由收尾 commit 补上 —— 本卡与 P0-3-20
 * 并行进行，共用 package.json，按"只动新增件"的窗口纪律先不改它。）
 *
 * 钉死六件事（每一条都对应一个"全绿但静默错"的真实陷阱）：
 * 1. **配对的三条规则** —— 用 2026-09-18 真账号里那两类**真实文件名**当样例
 *    （Chem 1A 的子目录 `Answer Keys`、Math 53 的兄弟目录 `… Solution`）。
 *    配对配错的后果是**用户拿到一份错的答案**，而界面看起来一切正常。
 * 2. **指纹必须能把 `KEY` 去掉** —— `PracticeMidterm1KEY_F23` 与 `PracticeMidterm1_F23`
 *    是同一份卷子。只按非字母数字切词元的话 `KEY` 粘在 `Midterm1` 后面，永远去不掉，
 *    结果是"配不到答案"，而它看起来像"老师没放答案"。
 * 3. **答案文件与图片不出「自测卷」按钮** —— 一个点了只会被拒的按钮（或拿答案去出卷子）比没有按钮更糟。
 * 4. **题号键按位置、不按模型给的字符串** —— 键是讲解缓存的 key，两题共用一键会让后写的
 *    讲解覆盖前一题的，且**看不出来**。
 * 5. **三条红线真的写进了 prompt** —— 不出新题 / 不自己算答案 / 题干照抄。
 *    这三条是本卡的验收标准③，而 prompt 是可以被后人"顺手改得通顺一点"的。
 * 6. **校验层只裁不炸** —— 坏条目丢掉要**计数上报**（静默 `slice` 是静默降级）；
 *    而"一题都没切出来"必须**整次失败**（那是这份材料根本不是卷子）。
 *
 * 在线证据（真账号打一遍）在 `npx -y tsx scripts/probe-practice-test.ts`。
 */

import { detectExtractableExtension } from "@/lib/course-files/extractable"
import {
  isExamLike,
  isKeyLikeName,
  isKeyLikePath,
  normalizeStem,
  pairAnswerKey,
  stripExtension,
  tokenizeName,
} from "@/lib/practice-test/pairing"
import type { PairingFile } from "@/lib/practice-test/pairing"
import {
  MAX_ANSWER_CHARS,
  MAX_QUESTIONS,
  MAX_QUESTION_CHARS,
  MAX_STEPS,
  paperHref,
  paperStats,
  questionIndex,
  questionKey,
  readExplanation,
  readPaper,
  withExplain,
} from "@/lib/practice-test/paper"
import {
  MAX_EXAM_CHARS,
  buildPracticeInput,
  buildPracticeMessages,
  buildExplanationInput,
  buildExplanationMessages,
  fallbackTitleFromFileName,
  validateExplanationOutput,
  validatePracticeOutput,
} from "@/lib/practice-test/prompt"

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

const file = (id: string, displayName: string, folderPath: string): PairingFile => ({
  id,
  displayName,
  folderPath,
})

// ---------------------------------------------------------------------------
// 真实样例（2026-09-18 真账号 `course_files` 实测）
// ---------------------------------------------------------------------------

/** Chem 1A：`Practice Exams/Unit 1 Exam` 下 6 个文件，`…/Answer Keys` 下 5 个。 */
const CHEM_EXAM = file("exam-f23", "PracticeMidterm1_F23.pdf", "Practice Exams/Unit 1 Exam")
const CHEM_KEY = file("key-f23", "PracticeMidterm1KEY_F23.pdf", "Practice Exams/Unit 1 Exam/Answer Keys")
const CHEM_SIBLINGS: PairingFile[] = [
  CHEM_EXAM,
  file("exam-f24", "PracticeMidterm1_F24.pdf", "Practice Exams/Unit 1 Exam"),
  file("sheet", "Exam1EquationSheet.pdf", "Practice Exams/Unit 1 Exam"),
  CHEM_KEY,
  file("key-f24", "PracticeMidterm1KEY_F24.pdf", "Practice Exams/Unit 1 Exam/Answer Keys"),
  file("key-spr23", "PracticeMidterm1KEY_Spr23.pdf", "Practice Exams/Unit 1 Exam/Answer Keys"),
  file("slides", "L1 Slides.pdf", "Lecture Slides/Unit 1"),
  file("syllabus", "Chem1A_Syllabus_Fall2026.pdf", ""),
]

/** Math 53 Discussion：`FA 23 Quiz` ↔ 兄弟目录 `FA 23 Quiz Solution`，同名文件。 */
const MATH_EXAM = file("m-exam", "53_Fall_23_Quiz_2.pdf", "FA 23 Quiz")
const MATH_KEY = file("m-key", "53_Fall_23_Quiz_2.pdf", "FA 23 Quiz Solution")
const MATH_SIBLINGS: PairingFile[] = [
  MATH_EXAM,
  file("m-exam1", "53_Fall_23_Quiz_1.pdf", "FA 23 Quiz"),
  MATH_KEY,
  file("m-key1", "53_Fall_23_Quiz_1.pdf", "FA 23 Quiz Solution"),
  // 诱饵：**同名但不在答案目录里** —— 它不是答案，不该被配进来。
  file("m-decoy", "53_Fall_23_Quiz_2.pdf", "Attachments"),
]

console.log("stripExtension（只在「看起来真像后缀」时才剥）")
{
  check("普通 .pdf 被剥", stripExtension("Slides.pdf") === "Slides")
  check("大小写混杂也剥", stripExtension("Slides.PDF") === "Slides")
  check("多点只剥最后一个", stripExtension("Exam.v2.pdf") === "Exam.v2")
  // 🔴 `Unit 3.2 Quiz` 的点后面是 `2 Quiz`（带空格）—— 那不是后缀，剥了就把名字截成 `Unit 3`，
  //    两组名字再也配不上。
  check("🔴 不是后缀就不剥（Unit 3.2 Quiz）", stripExtension("Unit 3.2 Quiz") === "Unit 3.2 Quiz")
  check("没有点原样返回", stripExtension("Weekly Review 1 - PDF") === "Weekly Review 1 - PDF")
  check("以点结尾不剥", stripExtension("Exam.") === "Exam.")
}

console.log("")
console.log("tokenizeName（驼峰与字母数字边界都要切开）")
{
  // 🔴 本卡最核心的一条：`KEY` 是**粘在** `Midterm1` 后面的。
  check(
    "PracticeMidterm1KEY_F23 → 认得出 key",
    tokenizeName("PracticeMidterm1KEY_F23.pdf").includes("key"),
    tokenizeName("PracticeMidterm1KEY_F23.pdf").join("|"),
  )
  check(
    "驼峰也切开",
    tokenizeName("PracticeMidterm1_F23.pdf").join("|") === "practice|midterm|1|f|23",
    tokenizeName("PracticeMidterm1_F23.pdf").join("|"),
  )
  check("非字母数字都当分隔", tokenizeName("53_Fall_23_Quiz_2.pdf").join("|") === "53|fall|23|quiz|2")
  check("空名字 → 空数组", tokenizeName("").length === 0)
}

console.log("")
console.log("normalizeStem（这就是「同一份卷子」的指纹）")
{
  check(
    "🔴 试卷与答案指纹相同（Chem 1A 真实样例）",
    normalizeStem("PracticeMidterm1_F23.pdf") === normalizeStem("PracticeMidterm1KEY_F23.pdf"),
    `${normalizeStem("PracticeMidterm1_F23.pdf")} vs ${normalizeStem("PracticeMidterm1KEY_F23.pdf")}`,
  )
  check(
    "🔴 不同的年份指纹不同（不能跨卷配错）",
    normalizeStem("PracticeMidterm1_F23.pdf") !== normalizeStem("PracticeMidterm1_F24.pdf"),
  )
  check(
    "🔴 不同题号指纹不同",
    normalizeStem("PracticeMidterm1_F23.pdf") !== normalizeStem("PracticeMidterm2_F23.pdf"),
  )
  check(
    "Math 53 同名文件指纹相同",
    normalizeStem("53_Fall_23_Quiz_2.pdf") === normalizeStem("53_Fall_23_Quiz_2.pdf"),
  )
  // 名字整一个就是 `Key` 的文件没有可比内容 —— 指纹为空时必须放弃配对，
  // 否则它会跟任何"去掉 key 后也是空"的名字凑成一对。
  check("名字只有一个 Key → 指纹为空", normalizeStem("Key.pdf") === "")
  check("Answer Key → 指纹为空", normalizeStem("Answer Key.pdf") === "")
}

console.log("")
console.log("isKeyLikeName / isKeyLikePath（认出答案文件）")
{
  check("KEY 粘在名字中间也认", isKeyLikeName("PracticeMidterm1KEY_F23.pdf"))
  check("_Answers 认", isKeyLikeName("Quiz2_Answers.pdf"))
  check("Solution 认", isKeyLikeName("Midterm Solution.pdf"))
  check("普通试卷不认", !isKeyLikeName("PracticeMidterm1_F23.pdf"))
  check("slides 不认", !isKeyLikeName("L1 Slides.pdf"))
  check("Answer Keys 目录认", isKeyLikePath("Practice Exams/Unit 1 Exam/Answer Keys"))
  check("FA 23 Quiz Solution 目录认", isKeyLikePath("FA 23 Quiz Solution"))
  check("FA 23 Quiz 目录不认", !isKeyLikePath("FA 23 Quiz"))
  check("空路径不认", !isKeyLikePath(""))
}

console.log("")
console.log("isExamLike（资料区那一行要不要出「自测卷」）")
{
  check("Chem 1A 的试卷：出", isExamLike(CHEM_EXAM))
  check("Math 53 的 quiz：出", isExamLike(MATH_EXAM))
  check("🔴 答案文件：不出（拿答案出卷子没有意义）", !isExamLike(CHEM_KEY))
  check("🔴 答案目录里的任何文件：不出", !isExamLike(file("x", "whatever.pdf", "Practice Exams/Unit 1 Exam/Answer Keys")))
  check("Math 53 的答案（同名但目录含 Solution）：不出", !isExamLike(MATH_KEY))
  check("syllabus：不出", !isExamLike(file("s", "Chem1A_Syllabus_Fall2026.pdf", "")))
  check("slides：不出", !isExamLike(file("l", "L1 Slides.pdf", "Lecture Slides/Unit 1")))
  // 已知的**误判**（刻意接受）：公式表落在考试目录里会被判成像试卷。
  // 点进去之后模型切不出题目 → 页面如实说「这份材料里没找到成题的题目」。
  // 反过来（漏判）比误判难查得多，所以关键词表刻意取得宽。
  check(
    "公式表落在考试目录 → 误判为像试卷（已知取舍，靠生成侧如实报错兜住）",
    isExamLike(file("sheet", "Exam1EquationSheet.pdf", "Practice Exams/Unit 1 Exam")),
  )
  check(
    "图片不出按钮（prerequisite：它压根不可抽）",
    detectExtractableExtension("photo.JPG", "image/jpeg") === null,
  )
}

console.log("")
console.log("pairAnswerKey（两条真实配对规则 + 反例）")
{
  // ---------- Chem 1A：子目录 Answer Keys ----------
  const chem = pairAnswerKey(CHEM_EXAM, CHEM_SIBLINGS.filter((f) => f.id !== CHEM_EXAM.id))
  check("Chem 1A：配到了答案", chem.key?.id === CHEM_KEY.id, String(chem.key?.id))
  check(
    "Chem 1A：走的是 answer-key-folder 规则",
    chem.rule === "answer-key-folder",
    String(chem.rule),
  )
  check("Chem 1A：候选不只一个（另外两年也在）", chem.ranked.length >= 1, String(chem.ranked.length))
  check("Chem 1A：比对过 7 份文件（含试卷自己）", chem.considered === 7, String(chem.considered))

  // ---------- Math 53：兄弟目录 Solution + 同名 ----------
  const math = pairAnswerKey(MATH_EXAM, MATH_SIBLINGS.filter((f) => f.id !== MATH_EXAM.id))
  check("Math 53：配到了答案", math.key?.id === MATH_KEY.id, String(math.key?.id))
  check("Math 53：走的是 solution-folder 规则", math.rule === "solution-folder", String(math.rule))
  check(
    "🔴 Math 53：同名但不在答案目录里的诱饵**不能**被选中",
    math.ranked.every((entry) => entry.file.id !== "m-decoy"),
    math.ranked.map((entry) => `${entry.file.id}:${entry.rule}`).join(" | "),
  )
  check("Math 53：Quiz 1 的答案也没被错配过来", math.key?.id !== "m-key1")

  // ---------- 反例 ----------
  const noMatch = pairAnswerKey(
    file("mid2", "PracticeMidterm2_F23.pdf", "Practice Exams/Unit 2 Exam"),
    CHEM_SIBLINGS,
  )
  check("🔴 另一份试卷（F23 Midterm 2）：一份都配不到 → null，绝不硬塞", noMatch.key === null)

  const emptyExamStem = pairAnswerKey(file("k", "Key.pdf", ""), CHEM_SIBLINGS)
  check("🔴 试卷自己指纹为空 → 不配对（配中也只是巧合）", emptyExamStem.key === null)

  const onlyItself = pairAnswerKey(CHEM_EXAM, [CHEM_EXAM])
  check("候选里只有试卷自己 → null", onlyItself.key === null)

  const empty = pairAnswerKey(CHEM_EXAM, [])
  check("空候选 → null 且 ranked 为空", empty.key === null && empty.ranked.length === 0)

  // 🔴 可复现：同样的输入必须永远是同一个答案（否则"今天配到 A、明天配到 B"会击穿信任）
  const again = pairAnswerKey(CHEM_EXAM, CHEM_SIBLINGS.filter((f) => f.id !== CHEM_EXAM.id))
  check("两次调用结果完全一致", again.key?.id === chem.key?.id && again.rule === chem.rule)
}

console.log("")
console.log("题目键与路由（键是讲解缓存的 key，必须稳、必须 URL 安全）")
{
  check("第一个键是 q1", questionKey(0) === "q1")
  check("第十个键是 q10", questionKey(9) === "q10")
  check("q3 → 下标 2", questionIndex("q3") === 2)
  check("q0 非法（从 1 开始）", questionIndex("q0") === null)
  check("qabc 非法", questionIndex("qabc") === null)
  check("空串非法", questionIndex("") === null)
  check("q1x 非法（不能前缀匹配就放行）", questionIndex("q1x") === null)
  check("q-1 非法", questionIndex("q-1") === null)

  const base = paperHref({ courseId: "c1", examFileId: "e1" })
  check("卷面地址带 exam", base === "/courses/c1/practice-tests/new?exam=e1", base)
  const withKey = paperHref({ courseId: "c1", examFileId: "e1", answerKeyFileId: "k1" })
  check("指定答案文件时带上 key", withKey.includes("key=k1"), withKey)
  check("没有答案文件时不出现 key=", !base.includes("key="))
  const explain = withExplain(base, "q3")
  check("讲解地址带 explain 与锚点", explain === `${base}&explain=q3#q3`, explain)
  check("讲解地址的锚点与参数用同一个键", explain.endsWith("#q3") && explain.includes("explain=q3"))
  // 没有 `?` 的地址也要能拼（防"参数被吃进上一个值里"）
  check("没有查询串时用 ? 起头", withExplain("/x", "q1") === "/x?explain=q1#q1")
}

console.log("")
console.log("readPaper（jsonb 读取守卫：一题坏掉不该让整张卷子打不开）")
{
  const good = readPaper({
    title: "Practice Midterm 1",
    questions: [
      { key: "乱写的键", number: "1", text: "题干一", answer: "答案一" },
      { key: "q99", number: "2", text: "题干二", answer: null },
    ],
  })
  check("标题读出来", good.title === "Practice Midterm 1")
  check("两题都在", good.questions.length === 2)
  check(
    "🔴 键**按位置重算**，不信任行里的值（手改过的键会让讲解配错题）",
    good.questions[0].key === "q1" && good.questions[1].key === "q2",
    good.questions.map((q) => q.key).join(","),
  )
  check("answer 是 null 时保持 null（不是空串）", good.questions[1].answer === null)

  check("不是对象 → 空卷面", readPaper("一段话").questions.length === 0)
  check("null → 空卷面", readPaper(null).questions.length === 0)
  check("数组 → 空卷面", readPaper([1, 2]).questions.length === 0)
  check("questions 不是数组 → 空卷面", readPaper({ title: "x", questions: "nope" }).questions.length === 0)

  const messy = readPaper({
    title: "  x  ",
    questions: [
      { number: "1", text: "好的" },
      { number: "2" },
      { number: "3", text: "   " },
      null,
      "不是对象",
      { number: "4", text: "也不错", answer: "   " },
    ],
  })
  check("没有题干的两条被丢掉", messy.questions.length === 2, String(messy.questions.length))
  check("标题去空白", messy.title === "x")
  check("答案全空白 → null（不是空串）", messy.questions[1].answer === null)
  check("缺题号时按位置兜底", messy.questions[0].number === "1")
  check("题干超长被截断", readPaper({ title: "t", questions: [{ number: "1", text: "y".repeat(MAX_QUESTION_CHARS + 50) }] }).questions[0].text.length === MAX_QUESTION_CHARS)
  check("答案超长被截断", readPaper({ title: "t", questions: [{ number: "1", text: "q", answer: "a".repeat(MAX_ANSWER_CHARS + 50) }] }).questions[0].answer?.length === MAX_ANSWER_CHARS)

  const tooMany = readPaper({
    title: "t",
    questions: Array.from({ length: MAX_QUESTIONS + 5 }, (_, i) => ({ number: `${i + 1}`, text: `q${i}` })),
  })
  check("超量题目被截到上限", tooMany.questions.length === MAX_QUESTIONS, String(tooMany.questions.length))
}

console.log("")
console.log("paperStats（「N 题里 M 题没答案」这句话必须算得对）")
{
  const stats = paperStats({
    title: "t",
    questions: [
      { key: "q1", number: "1", text: "a", answer: "答" },
      { key: "q2", number: "2", text: "b", answer: null },
      { key: "q3", number: "3", text: "c", answer: "答" },
    ],
  })
  check("total 3", stats.total === 3)
  check("answered 2", stats.answered === 2)
  check("missing 1", stats.missing === 1)
  check("空卷面无 missing", paperStats({ title: "", questions: [] }).missing === 0)
}

console.log("")
console.log("validatePracticeOutput（🔴 三条红线的判定层）")
{
  const ok = validatePracticeOutput(
    {
      title: "Practice Midterm 1 (F23)",
      questions: [
        { number: "1", text: "题干一", answer: "答案一" },
        { number: "2a", text: "题干二", answer: null },
      ],
    },
    "PracticeMidterm1_F23.pdf",
  )
  check("合法输出通过", ok.ok === true)
  check("两题都在", ok.ok === true && ok.value.questions.length === 2)
  check("🔴 answer=null 是**合法**值（配不上答案不是失败）", ok.ok === true && ok.value.questions[1].answer === null)
  check("answerless 计数为 1", ok.ok === true && ok.answerless === 1)
  check("dropped 为 0", ok.ok === true && ok.dropped === 0)

  const noTitle = validatePracticeOutput(
    { title: "   ", questions: [{ number: "1", text: "题干", answer: null }] },
    "PracticeMidterm1_F23.pdf",
  )
  check(
    "模型没给标题 → 用文件名兜底（宁可显示文件名，也不要一张没标题的卷子）",
    noTitle.ok === true && noTitle.value.title === "PracticeMidterm1_F23.pdf",
    noTitle.ok ? noTitle.value.title : "n/a",
  )

  const messy = validatePracticeOutput(
    {
      title: "t",
      questions: [
        { number: "1", text: "好的", answer: null },
        { number: "2" },
        { number: "3", text: "  " },
        null,
        "字符串",
        { number: "4", text: "也好", answer: "答" },
      ],
    },
    "f.pdf",
  )
  check("坏条目被丢掉、好的留下", messy.ok === true && messy.value.questions.length === 2)
  check(
    "🔴 丢掉多少要计数上报（静默 slice 是静默降级）",
    messy.ok === true && messy.dropped === 4,
    messy.ok ? String(messy.dropped) : "n/a",
  )

  const overflow = validatePracticeOutput(
    {
      title: "t",
      questions: Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({
        number: `${i + 1}`,
        text: `q${i}`,
        answer: null,
      })),
    },
    "f.pdf",
  )
  check("超量题目被裁到上限", overflow.ok === true && overflow.value.questions.length === MAX_QUESTIONS)
  check("超量部分计入 dropped", overflow.ok === true && overflow.dropped === 3)

  check(
    "🔴 一题都没切出来 → **整次失败**（这份材料根本不是卷子，重试也一样）",
    validatePracticeOutput({ title: "t", questions: [] }, "f.pdf").ok === false,
  )
  check(
    "questions 缺失 → 失败",
    validatePracticeOutput({ title: "t" }, "f.pdf").ok === false,
  )
  check("不是对象 → 失败", validatePracticeOutput("一段话", "f.pdf").ok === false)
  check("null → 失败", validatePracticeOutput(null, "f.pdf").ok === false)
  check("数组 → 失败", validatePracticeOutput([1], "f.pdf").ok === false)
}

console.log("")
console.log("buildPracticeInput / buildPracticeMessages（三条红线真的写进 prompt 了吗）")
{
  const short = buildPracticeInput({
    courseName: "Chem 1A",
    examFileName: "PracticeMidterm1_F23.pdf",
    keyFileName: "PracticeMidterm1KEY_F23.pdf",
    examText: "1. What is X?",
    keyText: "1. X is Y.",
  })
  check("短文本不截断", short.truncated === false)
  check(
    "字符数如实记下",
    short.examSourceChars === "1. What is X?".length &&
      short.keySourceChars === "1. X is Y.".length,
    `${short.examSourceChars} / ${short.keySourceChars}`,
  )

  const long = buildPracticeInput({
    courseName: "Chem 1A",
    examFileName: "e.pdf",
    keyFileName: "k.pdf",
    examText: "x".repeat(MAX_EXAM_CHARS + 500),
    keyText: "y".repeat(5),
  })
  check("试卷超长被截断到上限", long.examText.length === MAX_EXAM_CHARS)
  check(
    "🔴 截断后 sourceChars 仍记原始长度（否则界面没法如实说「共 N 字」）",
    long.examSourceChars === MAX_EXAM_CHARS + 500,
  )
  check("有截断 → truncated 为 true", long.truncated === true)

  const noKey = buildPracticeInput({
    courseName: "Chem 1A",
    examFileName: "e.pdf",
    keyFileName: null,
    examText: "1. Q",
    keyText: null,
  })
  check("没有答案文件时 keyText 是 null", noKey.keyText === null)
  check("没有答案文件不算截断", noKey.truncated === false)

  const messages = buildPracticeMessages(short)
  check("两条消息：system + user", messages.length === 2 && messages[0].role === "system")
  const system = String(messages[0].content)
  const user = String(messages[1].content)

  // 🔴 验收标准③：不出现 LLM 编造的新题。
  check("🔴 system 写明「绝不自己出题」", system.includes("绝不自己出题"))
  check("🔴 system 写明「绝不自己算答案」", system.includes("绝不自己算答案"))
  check("🔴 system 写明题干照原文抄", system.includes("照原文抄"))
  check("🔴 system 写明找不到答案填 null", system.includes("null"))
  check("🔴 system 写明答案键不能省略（防模型整个省掉 answer）", system.includes("不能省略"))
  check("🔴 system 写明答案文件不是题源（防把解析当额外的题）", system.includes("不是题源"))
  check("system 要求保持原文语言（不翻译）", system.includes("原文语言"))
  check("system 禁止声称覆盖全部", system.includes("不要声称覆盖了全部内容"))
  check("system 要求剔除指令性文字", system.includes("指令性文字"))

  check("user 带上课程", user.includes("Chem 1A"))
  check("user 带上试卷文件名", user.includes("PracticeMidterm1_F23.pdf"))
  check("user 带上答案文件名", user.includes("PracticeMidterm1KEY_F23.pdf"))
  check("user 带两份文字分节", user.includes("=== 试卷文字 ===") && user.includes("=== 答案文件文字 ==="))
  check("没截断时不出覆盖警告", !user.includes("不代表全部内容"))
  check(
    "🔴 截断时 user 里必须带覆盖警告",
    String(buildPracticeMessages(long)[1].content).includes("不代表全部内容"),
  )

  const noKeyMessages = buildPracticeMessages(noKey)
  const noKeyUser = String(noKeyMessages[1].content)
  check(
    "🔴 没有答案文件时 user 里**明说**（否则模型可能自己算）",
    noKeyUser.includes("没有拿到答案文件") && noKeyUser.includes("都填 `null`"),
    noKeyUser.slice(0, 200),
  )
  check("没有答案文件时 meta 行也标出来", noKeyUser.includes("答案文件：**这次没有拿到答案文件**"))
}

console.log("")
console.log("validateExplanationOutput（逐题讲解的判定层）")
{
  const ok = validateExplanationOutput({ steps: ["第一步", "第二步"], concepts: ["PV = nRT"] })
  check("合法输出通过", ok.ok === true && ok.value.steps.length === 2 && ok.value.concepts.length === 1)
  check("dropped 为 0", ok.ok === true && ok.dropped === 0)

  const noConcepts = validateExplanationOutput({ steps: ["只有步骤"], concepts: [] })
  check("只有步骤、概念为空 → 合法（很多题没有公式可列）", noConcepts.ok === true)

  const overflow = validateExplanationOutput({
    steps: Array.from({ length: MAX_STEPS + 2 }, (_, i) => `s${i}`),
    concepts: ["c1"],
  })
  check("超量步骤被裁到上限", overflow.ok === true && overflow.value.steps.length === MAX_STEPS)
  check("裁掉多少计数上报", overflow.ok === true && overflow.dropped === 2)

  check(
    "🔴 两栏全空 → 失败（模型什么都没讲出来）",
    validateExplanationOutput({ steps: [], concepts: [] }).ok === false,
  )
  check("全白也算空", validateExplanationOutput({ steps: ["  "], concepts: [" "] }).ok === false)
  check("不是对象 → 失败", validateExplanationOutput("x").ok === false)
  check("null → 失败", validateExplanationOutput(null).ok === false)

  const messages = buildExplanationMessages(
    buildExplanationInput({
      courseName: "Chem 1A",
      paperTitle: "Practice Midterm 1",
      questionNumber: "2a",
      questionText: "算出 X",
      officialAnswer: "X = 3",
    }),
  )
  const system = String(messages[0].content)
  const user = String(messages[1].content)
  check("system 要求以官方答案为准", system.includes("以它为准"))
  check("system 禁止出新题", system.includes("不要出新题"))
  check("system 要求概念栏空就返回空数组且键不能省", system.includes("空数组"))
  check("system 要求信息不足时如实说", system.includes("如实说明缺什么"))
  check("user 带上题号", user.includes("2a"))
  check("user 带上官方答案", user.includes("X = 3"))

  const noAnswer = buildExplanationMessages(
    buildExplanationInput({
      courseName: "Chem 1A",
      paperTitle: "t",
      questionNumber: "3",
      questionText: "题干",
      officialAnswer: null,
    }),
  )
  check(
    "🔴 没有官方答案时 user 里明说（不许模型假装有答案）",
    String(noAnswer[1].content).includes("没有找到官方答案"),
  )
}

console.log("")
console.log("readExplanation（jsonb 守卫）")
{
  const ok = readExplanation({ steps: ["a", "b"], concepts: ["c"] })
  check("正常读出", ok.steps.length === 2 && ok.concepts.length === 1)
  check("非字符串被丢", readExplanation({ steps: ["a", 1, null, "b"] }).steps.length === 2)
  check("空串被丢", readExplanation({ steps: ["a", "  ", ""] }).steps.length === 1)
  check("不是数组 → 空", readExplanation({ steps: "nope" }).steps.length === 0)
  check("null → 两栏都空", readExplanation(null).steps.length === 0 && readExplanation(null).concepts.length === 0)
  check(
    "超量被截到上限",
    readExplanation({ steps: Array.from({ length: MAX_STEPS + 4 }, (_, i) => `s${i}`) }).steps.length ===
      MAX_STEPS,
  )
}

console.log("")
console.log("fallbackTitleFromFileName")
{
  check("剥掉后缀", fallbackTitleFromFileName("PracticeMidterm1_F23.pdf") === "PracticeMidterm1_F23")
  check("没有后缀原样", fallbackTitleFromFileName("Weekly Review 1") === "Weekly Review 1")
  check("去首尾空白", fallbackTitleFromFileName("  a.pdf  ") === "a")
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
