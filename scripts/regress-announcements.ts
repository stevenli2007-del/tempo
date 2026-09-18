/**
 * P0-3-25 回归：公告同步的**判定层**（不依赖数据库、不依赖网络、不调 LLM）。
 *
 * 运行：`npm run regress:announcements`
 *
 * 钉死四件事：
 * 1. **HTML 清洗的顺序**（先剥标签、后解实体）—— 顺序反了就是把消毒做成"先开门再上锁"；
 * 2. **两端日期都进查询串** —— 只传 start_date 会静默漏掉最近一个月（实测 2 条 vs 71 条）；
 * 3. **落点判定的宽窄** —— 判窄了能力被藏起来，判宽了最多多点一次确认；
 * 4. **消息载荷**：原文链接、落点标记、「知道了」文案的触发条件。
 */

import {
  ANNOUNCEMENT_WINDOW_DAYS,
  announcementCourseExternalId,
  announcementWindow,
  announcementsPath,
  decodeHtmlEntities,
  stripHtml,
  toCanvasAnnouncements,
} from "@/lib/canvas/announcements"
import { hasStructuredLanding } from "@/lib/course-update/landing"
import { bodyLines, buildAnnouncementPayload } from "@/lib/sync/announcements"

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

console.log("stripHtml（HTML → 纯文本）")
{
  // 1. 段落边界必须变成换行：否则 <p>a</p><p>b</p> 会粘成 "ab"，读起来是两个词。
  check(
    "段落边界 → 换行",
    stripHtml("<p>Hello</p><p>World</p>") === "Hello\nWorld",
    JSON.stringify(stripHtml("<p>Hello</p><p>World</p>")),
  )
  check(
    "<br> → 换行",
    stripHtml("line one<br/>line two") === "line one\nline two",
    JSON.stringify(stripHtml("line one<br/>line two")),
  )

  // 2. script / style 要**连内容一起**丢 —— 只剥标签会把脚本源码当正文留着。
  check(
    "script 连内容一起丢",
    stripHtml("<script>alert('xss')</script>Reminder") === "Reminder",
    JSON.stringify(stripHtml("<script>alert('xss')</script>Reminder")),
  )
  check(
    "style 连内容一起丢",
    stripHtml("<style>p{color:red}</style>Text") === "Text",
    JSON.stringify(stripHtml("<style>p{color:red}</style>Text")),
  )

  // 3. 事件属性随标签一起消失。
  const img = stripHtml('<img src="x" onerror="alert(1)">Quiz on 9/4')
  check("img / 事件属性被剥掉", !img.includes("<") && !img.includes("onerror"), JSON.stringify(img))
  check("剥完剩正文", img.includes("Quiz on 9/4"), JSON.stringify(img))

  // 4. 🔴 顺序安全点：`&lt;script&gt;` 解出来是**文本**，不是标签。
  //    如果实现先解码再剥标签，这一步之后它就变成真标签了 —— 而那时已经"剥完了"。
  const escaped = stripHtml("&lt;script&gt;alert(1)&lt;/script&gt;")
  check("转义的 script 只当文本留下", escaped === "<script>alert(1)</script>", JSON.stringify(escaped))
  // 上面的输出里确实有 "<script>" 这几个字符 —— 这没问题，因为渲染层禁 dangerouslySetInnerHTML。
  // 这条断言的意义是：它**来自实体解码**，不是漏剥的标签。

  // 5. 常见实体与数字实体。
  check("&amp; 解码", decodeHtmlEntities("Tom &amp; Jerry") === "Tom & Jerry")
  check("&#39; 解码", decodeHtmlEntities("it&#39;s") === "it's")
  check("&#x27; 解码", decodeHtmlEntities("it&#x27;s") === "it's")
  check("&nbsp; → 空格", stripHtml("a&nbsp;b") === "a b", JSON.stringify(stripHtml("a&nbsp;b")))
  // 认不出的实体原样保留（宁可显示 &foo; 也不猜）。
  check("未知实体原样保留", decodeHtmlEntities("&foobar;") === "&foobar;")
  // 越界码点不能抛异常。
  check("越界码点不抛", decodeHtmlEntities("&#1114112;") === "&#1114112;")

  // 6. 空白压缩：连续空行压成**一个空行**（不是全删 —— HTML 源码里的空行是排版，
  //    而 <p> 之间的边界是段落，两者在纯文本里都该留下行结构）。
  //    注意 `<p>a</p><p>b</p>` 相邻时只出一个换行（见上面第一条），
  //    源码里本来就写了空行时留一个空行 —— 这是刻意的，不是 bug。
  check(
    "连续空行压成一个空行",
    stripHtml("<p>a</p>\n\n\n<p>b</p>") === "a\n\nb",
    JSON.stringify(stripHtml("<p>a</p>\n\n\n<p>b</p>")),
  )
  check(
    "行首尾空白去掉",
    stripHtml("   <p>  spaced  </p>   ") === "spaced",
    JSON.stringify(stripHtml("   <p>  spaced  </p>   ")),
  )
  check("空输入 → 空串", stripHtml("") === "")
}

console.log("announcementWindow / announcementsPath（日期陷阱）")
{
  // 固定时刻：LA 时间是 2026-09-17 22:00（UTC 已经 9/18）——
  // 按用户本地日历日算，不是 UTC。
  const now = new Date("2026-09-18T05:00:00Z")
  const w = announcementWindow(now)
  check("终点到明天（防 end_date 为 exclusive 时漏掉今天）", w.endDate === "2026-09-18", w.endDate)
  check(
    `起点是 ${ANNOUNCEMENT_WINDOW_DAYS} 天前`,
    w.startDate === "2026-09-03",
    w.startDate,
  )

  const path = announcementsPath(["111", "222"], w)
  // 🔴 这条是本卡的**核心防御**：两个日期参数缺一个就会静默漏数据。
  check("查询串含 start_date", path.includes("start_date=2026-09-03"), path)
  check("查询串含 end_date", path.includes("end_date=2026-09-18"), path)
  check("两端日期都不是默认值（都显式传了）", /start_date=/.test(path) && /end_date=/.test(path))
  check("context_codes 每门课一个", (path.match(/context_codes%5B%5D=/g) ?? []).length === 2, path)
  check("课程前缀是 course_", path.includes("course_111") && path.includes("course_222"), path)
  check("显式要求 latest_only=false", path.includes("latest_only=false"), path)
  check("路径以 /api/v1 开头", path.startsWith("/api/v1/announcements?"), path)
}

console.log("toCanvasAnnouncements（映射与守卫）")
{
  const raw = [
    {
      id: 9001,
      title: "Quiz dates",
      message: "<p>Quizzes on 9/4 and 9/18.</p>",
      html_url: "https://bcourses.berkeley.edu/courses/1/announcements/9001",
      posted_at: "2026-09-10T17:00:00Z",
      context_code: "course_1234",
    },
    // 学生端看不见的 → 跳过
    { id: 9002, title: "Draft", message: "x", context_code: "course_1234", workflow_state: "unpublished" },
    // 没有 id → 跳过（去重没有依据）
    { title: "No id", message: "x", context_code: "course_1234" },
    // 没有 context_code → 跳过（不知道算谁的课）
    { id: 9003, title: "No course", message: "x" },
    // 小组公告 → 跳过（不是课程上下文）
    { id: 9004, title: "Group", message: "x", context_code: "group_55" },
    // 无标题 → 明确占位，不编
    { id: 9005, message: "<p>Body only</p>", context_code: "course_1234" },
    // 重复 id → 只留一条
    { id: 9001, title: "Dup", message: "x", context_code: "course_1234" },
  ]

  const mapped = toCanvasAnnouncements(raw)
  check("跳过不可见 / 无 id / 无归属 / 非课程 / 重复", mapped.length === 2, `length=${mapped.length}`)
  check("课程外部 id 抽取正确", mapped[0].courseExternalId === "1234", mapped[0].courseExternalId)
  check("正文已剥标签", mapped[0].bodyText === "Quizzes on 9/4 and 9/18.", mapped[0].bodyText)
  check("html_url 保留", mapped[0].htmlUrl?.endsWith("/announcements/9001") === true)
  check("无标题给占位", mapped[1].title === "（无标题公告）", mapped[1].title)
  check("缺 html_url → null", mapped[1].htmlUrl === null)

  check("非数组输入 → 空数组", toCanvasAnnouncements(null).length === 0)

  check("course_1234 → 1234", announcementCourseExternalId("course_1234") === "1234")
  check("group_55 → null", announcementCourseExternalId("group_55") === null)
  check("空 → null", announcementCourseExternalId(null) === null)
}

console.log("bodyLines（气泡里的正文摘要）")
{
  check("最多 3 行", bodyLines("a\nb\nc\nd\ne").length === 3, JSON.stringify(bodyLines("a\nb\nc\nd\ne")))
  check("空行不计入", bodyLines("a\n\n\nb").length === 2, JSON.stringify(bodyLines("a\n\n\nb")))
  check("空正文 → 空数组", bodyLines("").length === 0)
  const long = bodyLines("x".repeat(500))
  check("超长行被截断并加省略号", long[0].endsWith("…") && long[0].length === 201, `len=${long[0].length}`)
}

console.log("hasStructuredLanding（落点判定：宽进）")
{
  // 真样本：Galen 的 quiz 公告（P0-3-24 验收用的同一条）。
  check(
    "Galen quiz 公告 → 有落点",
    hasStructuredLanding(
      "Quiz dates — the quizzes will be held on the following Fridays: 9/4, 9/18, 10/16, 10/30, 11/20, 12/4.",
    ),
  )
  check("成绩构成（有百分比，无日期）→ 有落点", hasStructuredLanding("Final 30%, midterms 40%"))
  check(
    "期中日期变更 → 有落点",
    hasStructuredLanding("Midterm 2 has been moved to November 6."),
  )
  check(
    "作业截止变更 → 有落点（applier 会在回执里说明未写入）",
    hasStructuredLanding("Problem Set 4 is now due 10/12."),
  )

  // 无落点：通知类，没有结构化去处。
  check("office hours 变更 → 无落点", hasStructuredLanding("Office hours moved to Wednesday 2-3pm in 891 Evans.") === false)
  check("停课通知 → 无落点", hasStructuredLanding("Class is cancelled this Friday.") === false)
  check("纯欢迎语 → 无落点", hasStructuredLanding("Welcome to Math 53! Looking forward to the semester.") === false)
  check("空文本 → 无落点", hasStructuredLanding("   ") === false)

  // 关键：有考试词**但没有具体日期** → 不算落点。
  // 判成有落点会引导用户点确认，然后得到一句"没有可写入的内容"——那是无谓的挫败。
  check(
    "只有「周五」没有具体日期 → 无落点",
    hasStructuredLanding("Quizzes will be held on Fridays.") === false,
  )
}

console.log("buildAnnouncementPayload（消息载荷）")
{
  const base = {
    announcement: {
      externalId: "9001",
      courseExternalId: "1234",
      title: "Quiz dates",
      bodyText: "Quiz dates: the quizzes will be held on 9/4 and 9/18.",
      htmlUrl: "https://bcourses.berkeley.edu/courses/1/announcements/9001",
      postedAt: "2026-09-10T17:00:00Z",
    },
    courseId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    courseName: "MATH 53",
    announcementRowId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    postedAtLabel: "发布于 2026-09-10",
  }

  const withLanding = buildAnnouncementPayload(base)
  check("标题用公告原标题", withLanding.title === "Quiz dates", String(withLanding.title))
  check("带 courseId（applier 靠它写入）", withLanding.courseId === base.courseId)
  check("带 courseName（气泡上的课程标签）", withLanding.courseName === "MATH 53")
  check("带 announcementId（applier 回查正文）", withLanding.announcementId === base.announcementRowId)
  check("带 sourceUrl（原文链接）", withLanding.sourceUrl === base.announcement.htmlUrl)
  check("landing = true", withLanding.landing === true)
  check("置信度 high（Canvas 是权威源，低置信度会禁掉「确认」）", withLanding.confidence === "high")
  check(
    "详情里说明了这条能写字段",
    (withLanding.details ?? []).some((line) => line.includes("可能有可写入")),
    JSON.stringify(withLanding.details),
  )
  check(
    "正文进了详情",
    (withLanding.details ?? [])[0]?.includes("9/4") === true,
    JSON.stringify(withLanding.details),
  )

  const noLanding = buildAnnouncementPayload({
    ...base,
    announcement: {
      ...base.announcement,
      externalId: "9002",
      title: "Office hours",
      bodyText: "Office hours moved to Wednesday 2-3pm in 891 Evans.",
    },
  })
  check("无落点 → landing = false", noLanding.landing === false)
  check(
    "无落点详情说明不改字段",
    (noLanding.details ?? []).some((line) => line.includes("不改任何字段")),
    JSON.stringify(noLanding.details),
  )
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
