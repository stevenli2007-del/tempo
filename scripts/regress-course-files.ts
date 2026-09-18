/**
 * P0-3-19 回归：资料索引的**判定层**（不依赖数据库、不依赖网络、不调 LLM）。
 *
 * 运行：`npm run regress:course-files`
 *
 * 钉死七件事（每一条都对应一个"全绿但静默错"的真实陷阱）：
 * 1. **路径前缀剥离** —— `course files/Lecture Slides/Unit 1` 必须剥成
 *    `Lecture Slides/Unit 1`，根目录剥成空串（空串 ≠ 未知）；
 * 2. **`hidden` 是 `null` 而不是 `false`** —— 实测 Canvas 未隐藏时给 `null`，
 *    写成 `Boolean(item.hidden)` 之外的判据都可能把正常文件夹判成隐藏（整门课的资料消失）；
 * 3. **学生看不见的文件不索引** —— locked / hidden / hidden_for_user / locked_for_user，
 *    以及"落在不可见文件夹里"的（实测 Chem 1AL 55 个文件夹里 24 个 hidden）；
 * 4. **外链形态** —— 必须是 `/courses/:cid/files/:fid`（实测 200），
 *    **不能**是 Canvas 给的 `url`（带 verifier、需 Bearer，浏览器点开 401）；
 * 5. **`modifiedAt` 用 `modified_at` 不是 `updated_at`** —— 实测同一文件两者差 1.5 小时，
 *    拿 `updated_at` 当"内容变了"会让 3-20/3-23 白跑一次解析；
 * 6. **分组**：根目录排最前、其余按路径升序、组内按名字排 —— 验收标准①的结构要能被脚本验；
 * 7. **大小格式化**：null 返回 null（不是 `0 B`，也不是占位符）。
 *
 * 在线证据（真 Canvas 打一遍）在 `npm run probe:course-files`。
 */

import {
  countRestrictedFiles,
  filePreviewUrl,
  filesPath,
  folderPathById,
  foldersPath,
  stripRootPrefix,
  toCanvasFiles,
  toCanvasFolders,
} from "@/lib/canvas/files"
import { detectExtractableExtension, unsupportedReason } from "@/lib/course-files/extractable"
import { buildFileTree, formatFileSize } from "@/lib/course-files/grouping"
import {
  MAX_ITEM_CHARS,
  MAX_POINTS,
  MAX_SOURCE_CHARS,
  buildSummaryInput,
  buildSummaryMessages,
  validateSummaryOutput,
} from "@/lib/course-files/summary/prompt"
import type { CourseFileView } from "@/lib/course-files/grouping"

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

console.log("stripRootPrefix（Canvas full_name → 相对路径）")
{
  check("根目录 → 空串", stripRootPrefix("course files") === "")
  check("一层", stripRootPrefix("course files/Lecture Slides") === "Lecture Slides")
  check(
    "三层（验收标准①要的那种）",
    stripRootPrefix("course files/Practice Exams/Unit 1 Exam/Answer Keys") ===
      "Practice Exams/Unit 1 Exam/Answer Keys",
  )
  check("带空格也剥", stripRootPrefix("  course files/Homework ") === "Homework")
  check("非该前缀原样返回（不猜）", stripRootPrefix("other/Homework") === "other/Homework")
}

console.log("")
console.log("端点路径（翻页必须交给 Link 头，不手工拼 page=2）")
{
  check("folders 带 per_page", foldersPath("1555045").includes("per_page=100"))
  check("files 带 per_page", filesPath("1555045").includes("per_page=100"))
  // ⚠️ 不能写 !includes("page=") —— `per_page=100` 里就含 "page="（本脚本第一版自己踩了）。
  check("folders 不带 page 参数", !/(?:[?&])page=/.test(foldersPath("1555045")))
  check("files 不带 page 参数", !/(?:[?&])page=/.test(filesPath("1555045")))
  check("课程 ID 被编码", foldersPath("a b").includes("a%20b"))
}

console.log("")
console.log("toCanvasFolders（文件夹映射）")
{
  const folders = toCanvasFolders([
    { id: 12332196, name: "course files", full_name: "course files", parent_folder_id: null },
    {
      id: 12332200,
      name: "Lecture Slides",
      full_name: "course files/Lecture Slides",
      parent_folder_id: 12332196,
      hidden: null,
    },
    {
      id: 12332205,
      name: "Unit 1",
      full_name: "course files/Lecture Slides/Unit 1",
      parent_folder_id: 12332200,
      hidden: null,
    },
    {
      id: 12491408,
      name: "Unit 1 Exam",
      full_name: "course files/Practice Exams/Unit 1 Exam",
      parent_folder_id: 12491407,
    },
    // 教师区：实测 Chem 1AL 55 个文件夹里 24 个是这样。
    { id: 999, name: "Teacher Only", full_name: "course files/Teacher Only", hidden: true },
    { id: 998, name: "Locked Folder", full_name: "course files/Locked", locked: true },
    { id: 997, name: "Hidden For User", full_name: "course files/HFU", hidden_for_user: true },
    { id: 996, name: "Locked For User", full_name: "course files/LFU", locked_for_user: true },
    { id: 0, name: "Bad id", full_name: "course files/Bad" },
    { id: 995, name: "Bad id", full_name: "course files/Bad" },
    "not an object",
    null,
  ])

  check("根文件夹在（path 为空串）", folders.some((f) => f.path === "" && f.visible))
  check(
    "三层路径被剥前缀",
    folders.find((f) => f.externalId === "12332205")?.path === "Lecture Slides/Unit 1",
  )
  check("hidden=true → 不可见", folders.find((f) => f.externalId === "999")?.visible === false)
  check("locked=true → 不可见", folders.find((f) => f.externalId === "998")?.visible === false)
  check(
    "hidden_for_user=true → 不可见",
    folders.find((f) => f.externalId === "997")?.visible === false,
  )
  check(
    "locked_for_user=true → 不可见",
    folders.find((f) => f.externalId === "996")?.visible === false,
  )
  // 🔴 这是本卡最险的一条：实测未隐藏时 Canvas 给的是 `null`，不是 `false`。
  check(
    "hidden=null → 可见（实测形态，不是 false）",
    folders.find((f) => f.externalId === "12332200")?.visible === true,
  )
  check("缺省 hidden → 可见", folders.find((f) => f.externalId === "12491408")?.visible === true)
  check("id=0 也被收下（0 是合法 ID）", folders.some((f) => f.externalId === "0"))
  check("重复 id 只留一条", folders.filter((f) => f.externalId === "995").length === 1)
  check("非对象被忽略", folders.length === 10, String(folders.length))
}

console.log("")
console.log("folderPathById（只收可见文件夹）")
{
  const map = folderPathById(
    toCanvasFolders([
      { id: 1, name: "course files", full_name: "course files" },
      { id: 2, name: "Visible", full_name: "course files/Visible", hidden: null },
      { id: 3, name: "Hidden", full_name: "course files/Hidden", hidden: true },
    ]),
  )
  check("可见文件夹在表里", map.get("2") === "Visible")
  check("根目录在表里（散装资料靠它）", map.get("1") === "")
  check("不可见文件夹不在表里", map.get("3") === undefined, String(map.get("3")))
}

console.log("")
console.log("toCanvasFiles（文件映射：只建目录、跳过学生看不见的）")
{
  const files = toCanvasFiles([
    {
      id: 95459083,
      folder_id: 12332196,
      display_name: "Chem 1A Fall 26 - Quiz 4 .pdf",
      "content-type": "application/pdf",
      size: 416448,
      modified_at: "2026-09-18T00:28:05Z",
      updated_at: "2026-09-18T01:56:28Z",
      locked: false,
      hidden: false,
    },
    // 实测 Chem 1AL 有 2 条这类。
    { id: 1, folder_id: 1, display_name: "locked.pdf", locked: true },
    { id: 2, folder_id: 1, display_name: "hidden.pdf", hidden: true },
    { id: 3, folder_id: 1, display_name: "locked_for_user.pdf", locked_for_user: true },
    { id: 4, folder_id: 1, display_name: "hidden_for_user.pdf", hidden_for_user: true },
    // 没有展示名的：不该拿 URL 编码的 filename 去顶替。
    { id: 5, folder_id: 1, display_name: "", filename: "a+b.pdf" },
    { id: 6, folder_id: 1, display_name: "   ", filename: "c.pdf" },
    { id: 7, folder_id: 1, display_name: "dup.pdf" },
    { id: 7, folder_id: 1, display_name: "dup.pdf" },
    { id: null, folder_id: 1, display_name: "no-id.pdf" },
    "not an object",
  ])

  check("正常文件被收下", files.length === 2, String(files.length))
  check("locked 被跳过", !files.some((f) => f.displayName === "locked.pdf"))
  check("hidden 被跳过", !files.some((f) => f.displayName === "hidden.pdf"))
  check("locked_for_user 被跳过", !files.some((f) => f.displayName === "locked_for_user.pdf"))
  check("hidden_for_user 被跳过", !files.some((f) => f.displayName === "hidden_for_user.pdf"))
  check("无展示名被跳过（不拿 filename 顶替）", !files.some((f) => f.displayName === ""))
  check("重复 id 只留一条", files.filter((f) => f.externalId === "7").length === 1)

  const quiz = files.find((f) => f.externalId === "95459083")
  // 🔴 内容变更时间必须取 modified_at；updated_at 差 1.5 小时（改的是元数据）。
  check("modifiedAt 取的是 modified_at", quiz?.modifiedAt === "2026-09-18T00:28:05Z", String(quiz?.modifiedAt))
  check("contentType 带连字符的键名", quiz?.contentType === "application/pdf")
  check("sizeBytes", quiz?.sizeBytes === 416448)
  check("folderId 是字符串", quiz?.folderId === "12332196")

  // 大小是字符串（Canvas 偶有字符串化）时也必须能收窄。
  const stringSize = toCanvasFiles([{ id: 9, folder_id: 1, display_name: "a.pdf", size: "2048" }])
  check("size 是字符串也能收窄", stringSize[0]?.sizeBytes === 2048, String(stringSize[0]?.sizeBytes))
  check("size 缺失 → null（不是 0）", toCanvasFiles([{ id: 10, folder_id: 1, display_name: "b.pdf" }])[0]?.sizeBytes === null)
}

console.log("")
console.log("countRestrictedFiles（被跳过的那批要能数出来）")
{
  const raw = [
    { id: 1, display_name: "a.pdf", locked: true },
    { id: 2, display_name: "b.pdf", hidden: true },
    { id: 3, display_name: "c.pdf", locked: false, hidden: null },
    { id: 4, display_name: "d.pdf" },
  ]
  check("只数真正受限的", countRestrictedFiles(raw) === 2, String(countRestrictedFiles(raw)))
  check("非数组 → 0", countRestrictedFiles(null) === 0)
}

console.log("")
console.log("filePreviewUrl（外链回 Canvas —— 本卡的验收标准②）")
{
  const url = filePreviewUrl("bcourses.berkeley.edu", "1555045", "95459083")
  check(
    "形态是 /courses/:cid/files/:fid",
    url === "https://bcourses.berkeley.edu/courses/1555045/files/95459083",
    url,
  )
  // 🔴 Canvas 给的 url 是 /files/{id}/download?...&verifier=...（需 Bearer，浏览器点开 401）
  check("不是 download 链", !url.includes("/download"))
  check("不带 verifier", !url.includes("verifier"))
  check("ID 被编码", filePreviewUrl("d.io", "a b", "c/d").includes("a%20b"))
}

console.log("")
console.log("buildFileTree（还原 Canvas 的文件夹树 —— 验收标准①，2026-09-18 验收修正）")
{
  const view = (
    id: string,
    displayName: string,
    folderPath: string,
  ): CourseFileView => ({
    id,
    displayName,
    folderPath,
    fileUrl: filePreviewUrl("d.io", "1", id),
    contentType: "application/pdf",
    sizeBytes: null,
    modifiedAt: null,
  })

  // 模拟 Chem 1A 的真实结构（2026-09-18 实测）。
  const files = [
    view("1", "Chem1A_Syllabus_Fall2026.pdf", ""),
    view("2", "Quiz 4.pdf", ""),
    view("3", "L1.pdf", "Lecture Slides/Unit 1"),
    view("4", "L2.pdf", "Lecture Slides/Unit 1"),
    view("5", "L3.pdf", "Lecture Slides/Unit 2"),
    view("6", "Exam1EquationSheet.pdf", "Practice Exams/Unit 1 Exam"),
    view("7", "Key1.pdf", "Practice Exams/Unit 1 Exam/Answer Keys"),
    view("8", "Key2.pdf", "Practice Exams/Unit 1 Exam/Answer Keys"),
    view("9", "HW0.pdf", "Homework"),
  ]

  const root = buildFileTree(files)

  check(
    "根目录的文件直接挂根节点（不套文件夹）",
    root.files.map((f) => f.displayName).join() ===
      "Chem1A_Syllabus_Fall2026.pdf,Quiz 4.pdf",
    root.files.map((f) => f.displayName).join(),
  )
  check(
    "顶层文件夹按名字排序",
    root.children.map((c) => c.name).join() === "Homework,Lecture Slides,Practice Exams",
    root.children.map((c) => c.name).join(),
  )
  check("根节点 totalCount = 全部文件数", root.totalCount === 9, String(root.totalCount))

  const lecture = root.children.find((c) => c.name === "Lecture Slides")
  check(
    "Lecture Slides 下有两个 Unit（一层真实父子）",
    lecture?.children.map((c) => c.name).join() === "Unit 1,Unit 2",
    lecture?.children.map((c) => c.name).join(),
  )
  check(
    "Unit 1 的直属文件是 L1/L2",
    lecture?.children[0].files.map((f) => f.displayName).join() === "L1.pdf,L2.pdf",
  )
  check("子节点的 path 是完整路径", lecture?.children[0].path === "Lecture Slides/Unit 1")

  const practice = root.children.find((c) => c.name === "Practice Exams")
  check("中间层自己没有直属文件（Practice Exams 直挂 0 个）", practice?.files.length === 0)
  check("Practice Exams 有 1 个子文件夹", practice?.children.length === 1)

  const exam = practice?.children[0]
  check("第二层是 Unit 1 Exam", exam?.name === "Unit 1 Exam")
  check(
    "Unit 1 Exam 直属 1 个文件",
    exam?.files.map((f) => f.displayName).join() === "Exam1EquationSheet.pdf",
  )

  const keys = exam?.children[0]
  check(
    "🔴 第三层 Answer Keys 是 Answer Keys 自己的节点（旧版会塌成一行标题）",
    keys?.name === "Answer Keys",
    String(keys?.name),
  )
  check(
    "Answer Keys 里 2 个文件",
    keys?.files.map((f) => f.displayName).join() === "Key1.pdf,Key2.pdf",
  )
  check(
    "三层 path 逐级拼接",
    keys?.path === "Practice Exams/Unit 1 Exam/Answer Keys",
    String(keys?.path),
  )
  check(
    "Practice Exams 的 totalCount 含后代（1 + 2 = 3）",
    practice?.totalCount === 3,
    String(practice?.totalCount),
  )

  // 自然序：换成纯字典序会把 `Unit 10` 排到 `Unit 2` 前面（课件命名里的常态，不是边缘情况）。
  const natural = buildFileTree([
    view("a", "x.pdf", "Unit 10"),
    view("b", "y.pdf", "Unit 2"),
    view("c", "z.pdf", "Unit 1"),
  ])
  check(
    "Unit 2 排在 Unit 10 前面（自然序，不是字典序）",
    natural.children.map((c) => c.name).join() === "Unit 1,Unit 2,Unit 10",
    natural.children.map((c) => c.name).join(),
  )
  check(
    "同一组文件也按自然序（L2 在 L10 前）",
    buildFileTree([view("a", "L10.pdf", "U"), view("b", "L2.pdf", "U")])
      .children[0].files.map((f) => f.displayName)
      .join() === "L2.pdf,L10.pdf",
  )

  // 同名文件夹出现在不同父级下时必须各成节点（按完整路径建节点，只在同一父下复用）。
  const duplicated = buildFileTree([
    view("a", "p.pdf", "A/Unit 1"),
    view("b", "q.pdf", "B/Unit 1"),
  ])
  check(
    "A/Unit 1 与 B/Unit 1 互不干扰",
    duplicated.children.length === 2 && duplicated.children.every((c) => c.children.length === 1),
    duplicated.children.map((c) => c.path).join(" | "),
  )

  const empty = buildFileTree([])
  check(
    "空输入 → 空树（不是 null）",
    empty.files.length === 0 && empty.children.length === 0 && empty.totalCount === 0,
  )
}

console.log("")
console.log("detectExtractableExtension（能不能读 ≠ 名字里有没有后缀）")
{
  check("普通 .pdf", detectExtractableExtension("slides.pdf", "application/pdf") === "pdf")
  check("大小写混杂", detectExtractableExtension("Slides.PPTX", null) === "pptx")
  check("pptx 放行（extract.ts 里有 extractPptx）", detectExtractableExtension("deck.pptx", null) === "pptx")
  check(
    "🔴 没有后缀但 MIME 是 PDF（Chem 1AL 真实存在：`Weekly Review 1 - PDF`）",
    detectExtractableExtension("Weekly Review 1 - PDF", "application/pdf") === "pdf",
  )
  check(
    "MIME 带 charset 参数也认",
    detectExtractableExtension("无名", "application/pdf; charset=utf-8") === "pdf",
  )
  check("MIME 大小写不敏感", detectExtractableExtension("无名", "Application/PDF") === "pdf")
  check(
    "docx 的长 MIME 认得出",
    detectExtractableExtension(
      "x",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) === "docx",
  )
  check(
    "图片 → null（要视觉模型，不在这里硬抽出一个空结果）",
    detectExtractableExtension("photo.JPG", "image/jpeg") === null,
  )
  check("压缩包 → null", detectExtractableExtension("a.zip", null) === null)
  check("完全没有线索 → null", detectExtractableExtension("README", null) === null)
  check(
    "🔴 名字里含 pdf 字面量但真后缀是 zip → null",
    detectExtractableExtension("notes.pdf.zip", "application/zip") === null,
  )
  check(
    "旧版 .doc → null（mammoth 只吃 docx）",
    detectExtractableExtension("old.doc", "application/msword") === null,
  )

  const imageReason = unsupportedReason("photo.jpg", "image/jpeg")
  check(
    "图片的理由点明「是图片、没有文字层」",
    imageReason.includes("图片") && imageReason.includes("文字层"),
    imageReason,
  )
  check("旧版 Office 的理由点名格式", unsupportedReason("old.ppt", null).includes("旧版"))
  check(
    "不认识的后缀也有一句人话（不是空字符串）",
    unsupportedReason("file.pages", null).length > 0,
  )
}

console.log("")
console.log("buildSummaryInput / buildSummaryMessages / validateSummaryOutput（一键总结的判定层）")
{
  const short = buildSummaryInput({
    fileName: "a.pdf",
    folderPath: "Unit 1",
    courseName: "Chem 1A",
    text: "abc",
  })
  check("短文本不截断", short.truncated === false && short.text === "abc" && short.sourceChars === 3)

  const long = buildSummaryInput({
    fileName: "a.pdf",
    folderPath: "",
    courseName: "Chem 1A",
    text: "x".repeat(MAX_SOURCE_CHARS + 500),
  })
  check(
    "超长文本被截断到上限",
    long.truncated === true && long.text.length === MAX_SOURCE_CHARS,
    String(long.text.length),
  )
  check(
    "🔴 截断后 sourceChars 仍记原始长度（否则界面没法如实说「共 N 字」）",
    long.sourceChars === MAX_SOURCE_CHARS + 500,
    String(long.sourceChars),
  )

  const messages = buildSummaryMessages(short)
  check(
    "两条消息：system + user",
    messages.length === 2 && messages[0].role === "system" && messages[1].role === "user",
  )
  const systemText = String(messages[0].content)
  check("system 写了「只依据给出的文字」（防补常识）", systemText.includes("只依据给出的文字"))
  check("system 禁止声称覆盖全部", systemText.includes("不要声称覆盖了全部内容"))
  check("system 要求术语/公式照抄", systemText.includes("照原文抄写"))

  const userText = String(messages[1].content)
  check("user 带上文件名与课程", userText.includes("a.pdf") && userText.includes("Chem 1A"))
  check("user 带上文件夹位置", userText.includes("Unit 1"))
  check("没截断时不出覆盖警告", !userText.includes("不代表全部内容"))
  check(
    "🔴 截断时 user 里必须带覆盖警告",
    String(buildSummaryMessages(long)[1].content).includes("不代表全部内容"),
  )

  const good = validateSummaryOutput({ overview: "讲了 VSEPR", points: ["p1", "p2"], formulas: ["Ksp"] })
  check(
    "合法输出通过并计数为 0",
    good.ok === true && good.value.points.length === 2 && good.value.formulas.length === 1 && good.dropped === 0,
  )

  const messy = validateSummaryOutput({
    overview: "  x  ",
    points: ["a", "", 3, null, "b"],
    formulas: "不是数组",
  })
  check(
    "非字符串与空串被丢掉",
    messy.ok === true && messy.value.points.join() === "a,b",
    messy.ok ? messy.value.points.join() : "n/a",
  )
  check("公式不是数组时降级为空数组（不是整次失败）", messy.ok === true && messy.value.formulas.length === 0)
  check("overview 去首尾空白", messy.ok === true && messy.value.overview === "x")

  const overflow = validateSummaryOutput({
    overview: "x",
    points: Array.from({ length: MAX_POINTS + 3 }, (_, i) => `p${i}`),
    formulas: [],
  })
  check(
    "超量要点被裁到上限",
    overflow.ok === true && overflow.value.points.length === MAX_POINTS,
    overflow.ok ? String(overflow.value.points.length) : "n/a",
  )
  check(
    "🔴 裁掉多少要计数上报（不报就没人发现模型开始写废话）",
    overflow.ok === true && overflow.dropped === 3,
    overflow.ok ? String(overflow.dropped) : "n/a",
  )

  const longItem = validateSummaryOutput({
    overview: "x",
    points: ["y".repeat(MAX_ITEM_CHARS + 50)],
    formulas: [],
  })
  check(
    "单条超长被截到上限",
    longItem.ok === true && longItem.value.points[0].length === MAX_ITEM_CHARS,
  )

  check(
    "🔴 三者全空 → 失败（模型什么都没读出来，落 failed 不再重试）",
    validateSummaryOutput({ overview: "", points: [], formulas: [] }).ok === false,
  )
  check(
    "全空白的字符串也算空",
    validateSummaryOutput({ overview: " ", points: ["  "], formulas: [] }).ok === false,
  )
  check("不是对象 → 失败", validateSummaryOutput("一段话").ok === false)
  check("数组 → 失败", validateSummaryOutput([1, 2]).ok === false)
  check("null → 失败", validateSummaryOutput(null).ok === false)
}

console.log("")
console.log("formatFileSize（null 不是 0）")
{
  check("null → null", formatFileSize(null) === null)
  check("字节", formatFileSize(512) === "512 B")
  check("KB", formatFileSize(416448) === "407 KB", String(formatFileSize(416448)))
  check("MB", formatFileSize(2_200_000) === "2.1 MB", String(formatFileSize(2_200_000)))
  check("0 → 0 B（0 是真实值，不是缺失）", formatFileSize(0) === "0 B")
  check("负数 → null", formatFileSize(-1) === null)
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
