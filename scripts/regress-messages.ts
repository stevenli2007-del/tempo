/**
 * P0-3-18 回归：消息栏的**判定层**（不依赖数据库、不依赖网络）。
 *
 * 运行：`npm run regress:messages`
 *
 * 钉死两件事，因为这俩一旦分叉就是 P0-3-15 那种「两边都绿、肉眼才看得出」的 bug：
 * 1. `toMessageView`：UI 的「确认」按钮可用性（`canAccept`）到底按什么算；
 * 2. `planDecision`：API「确认 / 忽略」的写入判定（ADR-015「确认才写」的唯一来源）。
 * 两者必须共用同一份规则（置信度 + applier 就绪），所以这里同时断言两边。
 */

import { isApplierReady } from "@/lib/messages/apply"
import { planDecision } from "@/lib/messages/decide"
import { MESSAGE_STATUSES, MESSAGE_TYPES } from "@/lib/messages/registry"
import {
  COURSE_TONES,
  MESSAGE_TYPE_LABELS,
  courseToneClass,
  toMessageView,
} from "@/lib/messages/view"
import type { Message, MessagePayload, MessageStatus, MessageType } from "@/types/message"

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

function makeMessage(
  type: MessageType,
  status: MessageStatus,
  payload: Partial<MessagePayload> = {},
  summary: Message["summary"] = null,
): Message {
  return {
    id: "test-id",
    type,
    status,
    createdAt: "2026-09-17T18:00:00Z",
    decidedAt: null,
    payload: {
      title: "测试提案",
      ...payload,
    },
    summary,
  }
}

/**
 * 一条载荷**不过类型**的消息构造器。
 *
 * `payload` 是 `jsonb`，库里真的可能存在 `null` / 字符串 / 缺字段 ——
 * 而 `Partial<MessagePayload>` 过不了这些值。所有守卫逻辑都得能被这样测，
 * 否则测的只是"我喂得进类型的东西"，不是"库里可能有的东西"。
 */
function makeRawPayload(payload: Record<string, unknown>): Message {
  return {
    id: "raw-id",
    type: "announcement",
    status: "pending",
    createdAt: "2026-09-17T18:00:00Z",
    decidedAt: null,
    payload: { title: "6 门课的 40 条通知类公告", ...payload } as MessagePayload,
  }
}

console.log("toMessageView（UI 可用性）")
{
  // 1. material + pending + high → 可一键接受（applier 已就绪的只有 material）。
  const v = toMessageView(makeMessage("material", "pending"))
  check("material/pending/high 可确认", v.canAccept === true, `canAccept=${v.canAccept}`)
  check("material/pending/high 无阻止原因", v.blockReason === null)
  check("material applier 就绪", isApplierReady("material") === true)

  // 2. syllabus_drift + pending + high → 不可确认（写入逻辑由 3-20 接入）。
  const v2 = toMessageView(makeMessage("syllabus_drift", "pending"))
  check("syllabus_drift/pending/high 不可确认", v2.canAccept === false, `canAccept=${v2.canAccept}`)
  check(
    "阻止原因提示未接入",
    !!v2.blockReason && v2.blockReason.includes("写入逻辑还没接入"),
    v2.blockReason ?? "null",
  )
  check("syllabus_drift applier 未就绪", isApplierReady("syllabus_drift") === false)

  // 3. 低置信度 → 不许一键接受（无论类型）。
  const v3 = toMessageView(makeMessage("material", "pending", { confidence: "low" }))
  check("低置信度不可确认", v3.canAccept === false)
  check(
    "低置信度阻止原因",
    !!v3.blockReason && v3.blockReason.includes("置信度低"),
    v3.blockReason ?? "null",
  )

  // 4. 已处理（accepted / dismissed）→ 不可确认，原因是已处理。
  const v4 = toMessageView(makeMessage("material", "accepted"))
  check("accepted 非 pending", v4.isPending === false)
  check("accepted 不可确认", v4.canAccept === false)
  check("accepted 阻止原因=已处理", v4.blockReason === "已经处理过了", v4.blockReason ?? "null")
  const v5 = toMessageView(makeMessage("material", "dismissed"))
  check("dismissed 非 pending", v5.isPending === false)
  check("dismissed 不可确认", v5.canAccept === false)
  check("dismissed 状态字段透传", v5.status === "dismissed")
  // 会话版面按 createdAt 排序，这个字段丢了就会静默错排（且构建/类型全绿）。
  check("createdAt 透传", v5.createdAt === "2026-09-17T18:00:00Z", v5.createdAt)

  // 5. 缺标题 → 如实占位，不编假标题。
  const v6 = toMessageView(makeMessage("material", "pending", { title: "" }))
  check("缺标题给占位文案", v6.title === "（这条提案没有摘要）", v6.title)

  // 6. 各类型 applier 就绪状态（单一来源，UI 与 API 都读它）。
  check(
    "applier 就绪：material + announcement",
    isApplierReady("material") && isApplierReady("announcement") &&
      !isApplierReady("syllabus_drift") && !isApplierReady("practice_test") &&
      !isApplierReady("routine"),
  )
}

console.log("枚举白名单（CodingRules §10.1 第 16 条：四处同改）")
{
  // 🔴 这组断言抓的是"四处同改漏了某一处"。
  // 四处是：① types/message.ts ② lib/messages.ts 的运行时白名单
  //       ③ 迁移的 CHECK 约束（**测不到**，靠 `npm run probe:schema` 在真库上验）
  //       ④ 本文件的断言
  //
  // 第 ② 处原先藏在 `lib/messages.ts` 里，那个文件 import 了 `next/headers`，
  // 测试根本 import 不了 —— 于是漏改的表现是"新类型的消息一条都不显示、零报错"。
  // 现在白名单抽到纯模块 `lib/messages/registry.ts`，这里就能钉死它。
  const labelKeys = Object.keys(MESSAGE_TYPE_LABELS).sort()
  const runtimeTypes = [...MESSAGE_TYPES].sort()
  check(
    "类型白名单 == 标签表的键",
    JSON.stringify(labelKeys) === JSON.stringify(runtimeTypes),
    `labels=[${labelKeys}] runtime=[${runtimeTypes}]`,
  )
  check(
    "白名单含 announcement",
    runtimeTypes.includes("announcement"),
    `runtime=[${runtimeTypes}]`,
  )
  // 标签表是 `Record<MessageType, string>`，tsc 会强制穷尽 ——
  // 但"多出一个 tsc 管不到的键"它不会报，所以这里也查反向。
  check("标签表没有多余的键", labelKeys.length === runtimeTypes.length)
  check(
    "状态白名单是 pending/accepted/dismissed/undone",
    JSON.stringify([...MESSAGE_STATUSES].sort()) ===
      JSON.stringify(["accepted", "dismissed", "pending", "undone"]),
    `[${MESSAGE_STATUSES}]`,
  )
}

console.log("公告视图（P0-3-25）")
{
  // 7. 有落点 → 按钮叫「确认」。
  const withLanding = toMessageView(
    makeMessage("announcement", "pending", {
      landing: true,
      sourceUrl: "https://bcourses.berkeley.edu/courses/1/announcements/9001",
    }),
  )
  check("公告类型标签", withLanding.typeLabel === "课程公告", withLanding.typeLabel)
  check("有落点 → 文案「确认」", withLanding.confirmLabel === "确认", withLanding.confirmLabel)
  check("有落点 → 可确认", withLanding.canAccept === true)
  check("原文链接透传", withLanding.sourceUrl?.endsWith("/announcements/9001") === true, String(withLanding.sourceUrl))

  // 8. 无落点 → 按钮叫「知道了」（它确实什么都不会写，不能叫「确认」）。
  const ack = toMessageView(makeMessage("announcement", "pending", { landing: false }))
  check("无落点 → 文案「知道了」", ack.confirmLabel === "知道了", ack.confirmLabel)
  check("无落点 → 仍可确认（走空写入回执）", ack.canAccept === true)

  // 9. landing 字段缺失（老数据 / 别的产出方）→ 按「确认」处理，不含糊其辞。
  const legacy = toMessageView(makeMessage("announcement", "pending"))
  check("缺 landing → 仍是「确认」", legacy.confirmLabel === "确认", legacy.confirmLabel)

  // 10. 非公告类型不受影响。
  check("material 文案仍是「确认」", toMessageView(makeMessage("material", "pending")).confirmLabel === "确认")

  // 11. 🔴 sourceUrl 白名单：payload 是 jsonb，只放行 http(s)。
  //     `javascript:` 如果漏过去，渲染层的 <a href> 就成了"点一下执行"的口子，
  //     而它长得和普通链接一模一样。
  const dangerous = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "  javascript:alert(1)",
    "/relative/path",
    "not a url",
  ]
  for (const url of dangerous) {
    const v = toMessageView(makeMessage("announcement", "pending", { sourceUrl: url }))
    check(`拒绝不安全链接：${url.trim().slice(0, 28)}`, v.sourceUrl === null, String(v.sourceUrl))
  }
  check(
    "放行 http（本地开发也可能用）",
    toMessageView(makeMessage("announcement", "pending", { sourceUrl: "http://x.test/a" })).sourceUrl !== null,
  )
  check(
    "缺 sourceUrl → null",
    toMessageView(makeMessage("announcement", "pending")).sourceUrl === null,
  )
}

console.log("合并摘要视图（P0-3-25 C 口径）")
{
  const v = toMessageView(
    makeRawPayload({
      landing: false,
      digest: [
        {
          title: "Office hours moved",
          courseName: "MATH 53",
          postedAtLabel: "发布于 2026-09-10",
          sourceUrl: "https://bcourses.berkeley.edu/courses/1/announcements/1",
        },
        // 链接是 javascript: → 必须被挡（渲染层要画 <a href>）
        { title: "Class cancelled", courseName: "CHEM 1A", sourceUrl: "javascript:alert(1)" },
        // 没有标题 → 摘要行会是一行空白，丢掉
        { title: "   ", courseName: "PHYSICS 7A" },
        // 压根不是对象
        "not an object",
        { courseName: "No title at all" },
      ],
      digestOverflow: 7,
    }),
  )
  check("只留合法项（丢空标题 / 非对象）", v.digestItems.length === 2, `len=${v.digestItems.length}`)
  check("课程名透传", v.digestItems[0].courseLabel === "MATH 53", String(v.digestItems[0].courseLabel))
  check(
    "摘要项链接放行 https",
    v.digestItems[0].sourceUrl?.endsWith("/announcements/1") === true,
    String(v.digestItems[0].sourceUrl),
  )
  // 🔴 摘要里也有链接，必须走**同一个**白名单函数，不能因为"这是内部数据"就免检。
  check("摘要项拒绝 javascript: 链接", v.digestItems[1].sourceUrl === null, String(v.digestItems[1].sourceUrl))
  check("发布时间透传", v.digestItems[0].postedAtLabel === "发布于 2026-09-10")
  check("缺课程名 → null", toMessageView(makeRawPayload({ digest: [{ title: "x" }] })).digestItems[0].courseLabel === null)
  check("overflow 透传", v.digestOverflow === 7, String(v.digestOverflow))
  check("摘要按钮是「知道了」", v.confirmLabel === "知道了", v.confirmLabel)
  check("摘要仍可确认（走空写入回执）", v.canAccept === true)

  // 13. 非摘要消息不受影响（`digest` 缺失是绝大多数消息的常态）。
  const plainMessage = toMessageView(makeMessage("material", "pending"))
  check("非摘要 → digestItems 为空", plainMessage.digestItems.length === 0)
  check("非摘要 → digestOverflow 为 0", plainMessage.digestOverflow === 0)
  check("digest 非数组 → 空列表", toMessageView(makeRawPayload({ digest: "nope" })).digestItems.length === 0)

  // 14. overflow 守卫：负数 / NaN / 字符串 / Infinity 一律归 0。
  //     显示"还有 -3 条"或"还有 NaN 条"比不显示更糟。
  for (const bad of [-1, 0, Number.NaN, "3", null, undefined, Number.POSITIVE_INFINITY]) {
    const b = toMessageView(makeRawPayload({ digestOverflow: bad }))
    check(`非法 overflow 归 0：${String(bad)}`, b.digestOverflow === 0, String(b.digestOverflow))
  }

  // 15. 渲染侧独立上限：payload 是 jsonb，一次手工改库就能塞进几千项。
  const huge = toMessageView(makeRawPayload({ digest: Array.from({ length: 500 }, (_, i) => ({ title: `N${i}` })) }))
  check("渲染侧上限 100 条", huge.digestItems.length === 100, String(huge.digestItems.length))
}

console.log("课程身份色（P0-3-25 验收反馈：颜色高亮）")
{
  // 2026-09-18 Steven：「课程分类做明显一点，可以给个不同的颜色高亮一下」。
  // 色板见 `lib/messages/view.ts` 的 `COURSE_TONES`。

  check("同名 → 同色（确定性）", courseToneClass("MATH 53") === courseToneClass("MATH 53"))
  check("返回值非空", courseToneClass("MATH 53").length > 0)

  // 🔴 这一条最要紧：**逐条通道与摘要通道必须是同一个颜色**。
  // 逐条通道的载荷里有 `courseId`，摘要通道只有 `courseName` ——
  // 如果哪天有人给逐条通道改用 courseId 当 seed，同一门课在两条通道里就是两个色，
  // 而那正是 P0-3-15「同一个判定写两遍」那类分叉（两处都绿、肉眼才看得出）。
  const perItem = toMessageView(
    makeMessage("announcement", "pending", { courseName: "PHYSICS 7A", landing: true }),
  )
  const inDigest = toMessageView(
    makeRawPayload({ digest: [{ title: "x", courseName: "PHYSICS 7A" }] }),
  )
  check(
    "逐条与摘要同一门课同色",
    perItem.courseTone === inDigest.digestItems[0].courseTone,
    `${perItem.courseTone} vs ${inDigest.digestItems[0].courseTone}`,
  )

  // 分布性：真实课名集合不该全落到同一格（否则"高亮"等于没做）。
  const realCourses = ["CHEM 1A", "CHEM 1AL", "MATH 53", "PHYSICS 7A", "R4A", "CS 61A"]
  const tones = new Set(realCourses.map((name) => courseToneClass(name)))
  check(
    `真实课名分布到 ≥2 种颜色（实际 ${tones.size} 种）`,
    tones.size >= 2,
    [...tones].join(" | "),
  )
  check(
    "每门课的颜色都在合法色板里（没有 undefined）",
    realCourses.every((name) => (COURSE_TONES as readonly string[]).includes(courseToneClass(name))),
  )

  // 没有课程名 → 没有色（渲染层据此决定画不画那个徽标）。
  check(
    "缺课程名 → courseTone 为 null",
    toMessageView(makeMessage("announcement", "pending", { landing: true })).courseTone === null,
  )
  check(
    "摘要项缺课程名 → courseTone 为 null",
    toMessageView(makeRawPayload({ digest: [{ title: "x" }] })).digestItems[0].courseTone === null,
  )

  // 🔴 类名必须是**完整字面量**：Tailwind v4 只扫源码里出现过的完整类名，
  // `bg-${tone}` 这种拼接**扫不到、CSS 不生成** —— 表现是"徽标没颜色"，
  // 而 tsc / eslint / build 全绿。所以每个色板项都必须同时带底色与前景色两段。
  check(
    "色板每项都是完整的 bg-* + text-* 字面量（防被改成拼接）",
    COURSE_TONES.every((tone) => /^bg-\S+ text-\S+$/.test(tone)),
    COURSE_TONES.join(" | "),
  )
  check("色板不重复", new Set(COURSE_TONES).size === COURSE_TONES.length)
}

console.log("planDecision（API 写入判定）")
{
  // 7. 已经处理过 → 拒绝（幂等放过会让 applier 有副作用时执行两次）。
  const r1 = planDecision({ currentStatus: "accepted", decision: "accepted", applierReady: true })
  check("已处理→拒绝", r1.kind === "reject" && r1.status === 409 && r1.code === "already_decided")

  // 8. 忽略 → 改 dismissed，永不动 applier。
  const r2 = planDecision({ currentStatus: "pending", decision: "dismissed", applierReady: false })
  check(
    "忽略→dismissed 不调 applier",
    r2.kind === "update" && r2.nextStatus === "dismissed" && r2.callApplier === false,
  )

  // 9. 确认 + applier 未接入 → 拒绝且不改状态（静默失败红线）。
  const r3 = planDecision({ currentStatus: "pending", decision: "accepted", applierReady: false })
  check(
    "确认未接入→拒绝 501",
    r3.kind === "reject" && r3.status === 501 && r3.code === "applier_not_implemented",
  )

  // 10. 确认 + applier 就绪 → 改 accepted 且调 applier。
  const r4 = planDecision({ currentStatus: "pending", decision: "accepted", applierReady: true })
  check(
    "确认就绪→accepted 调 applier",
    r4.kind === "update" && r4.nextStatus === "accepted" && r4.callApplier === true,
  )

  // 11. 忽略路径 applier 是否就绪都不影响（忽略就是什么都不发生）。
  const r5 = planDecision({ currentStatus: "pending", decision: "dismissed", applierReady: true })
  check("忽略就绪→仍 dismissed 不调 applier", r5.kind === "update" && r5.callApplier === false)
}

console.log("toMessageView（AI 要点，P0-3-25b）")
{
  const okSummary: Message["summary"] = {
    points: ["要交 HW7", "Quiz 1 答案已发布"],
    itemsUsed: 1,
    itemsTotal: 1,
    status: "ok",
    createdAt: "2026-09-18T00:00:00Z",
  }

  // 12. 「该不该去生成」只看一个字段：公告 + 待处理 + 还没问过。
  check(
    "公告 pending 无要点 → needsSummary",
    toMessageView(makeMessage("announcement", "pending")).needsSummary,
  )
  check(
    "非公告类型 → 不请求要点",
    !toMessageView(makeMessage("material", "pending")).needsSummary,
  )
  check(
    "已处理（accepted）→ 不请求要点",
    !toMessageView(makeMessage("announcement", "accepted")).needsSummary,
  )
  check(
    "已有要点 → 不重复请求",
    !toMessageView(makeMessage("announcement", "pending", {}, okSummary)).needsSummary,
  )
  // 🔴 status='failed' 的行必须**终止请求**（否则每次打开消息栏都重打一次模型），
  // 但又不能画任何东西（points 由 store 强制为空）。
  check(
    "failed 行 → 不再请求、也不显示要点",
    (() => {
      const view = toMessageView(
        makeMessage("announcement", "pending", {}, { ...okSummary, points: [], status: "failed" }),
      )
      return !view.needsSummary && view.summaryPoints.length === 0
    })(),
  )

  // 13. 要点的呈现：归因标签 + 覆盖率（两处都来自纯函数，不许组件自己拼）。
  const view = toMessageView(makeMessage("announcement", "pending", {}, okSummary))
  check("要点原样带出来", view.summaryPoints.join("|") === "要交 HW7|Quiz 1 答案已发布")
  check("归因标签是「AI 总结」", view.summaryLabel === "AI 总结", view.summaryLabel)
  check("覆盖完整时不标覆盖率", view.summaryCoverage === null, String(view.summaryCoverage))
  check("生成中文案可读", view.summaryBusyLabel.includes("生成中"), view.summaryBusyLabel)

  const partial = toMessageView(
    makeMessage("announcement", "pending", {}, { ...okSummary, itemsUsed: 20, itemsTotal: 40 }),
  )
  check(
    "覆盖不全 → 如实标出",
    partial.summaryCoverage === "基于最新 20 条 / 共 40 条",
    String(partial.summaryCoverage),
  )

  // 14. 英文版（未来）：同一份数据、同一处判定，只是语言换掉。
  const en = toMessageView(makeMessage("announcement", "pending", {}, okSummary), "en")
  check("en：归因标签", en.summaryLabel === "AI summary", en.summaryLabel)
  const enPartial = toMessageView(
    makeMessage("announcement", "pending", {}, { ...okSummary, itemsUsed: 20, itemsTotal: 40 }),
    "en",
  )
  check("en：覆盖率文案", enPartial.summaryCoverage === "newest 20 of 40", String(enPartial.summaryCoverage))

  // 15. 缺 summary 字段（老数据 / PATCH 返回里没有它）必须等价于"没有要点"，
  //     而不是崩掉 —— 这条走的是 `message.summary === undefined` 的分支。
  const legacy = toMessageView({
    id: "legacy",
    type: "announcement",
    status: "pending",
    createdAt: "2026-09-17T18:00:00Z",
    decidedAt: null,
    payload: { title: "老消息" },
  })
  check("summary 字段缺失 → 当作没有要点", legacy.summaryPoints.length === 0 && legacy.needsSummary)
}

console.log("撤销回执视图（P0-3-26）")
{
  // 1. 已撤销 → isUndone 透传、appliedCount 统计、receiptText 透传。
  const undone = toMessageView(
    makeMessage("announcement", "undone", {
      landing: true,
      receipt: "已写入 2 条考试（该课现在共 7 条）",
      applied: { examDateIds: ["a", "b"], gradeComponentIds: [] },
    }),
  )
  check("undone 状态 → isUndone=true", undone.isUndone === true)
  check("isUndone 透传 status", undone.status === "undone")
  check("appliedCount 统计考试行", undone.appliedCount === 2, `count=${undone.appliedCount}`)
  check(
    "receiptText 透传",
    undone.receiptText === "已写入 2 条考试（该课现在共 7 条）",
    String(undone.receiptText),
  )

  // 2. 已确认但无写入（如"知道了"）→ appliedCount=0，仍不是 undone。
  const ack = toMessageView(
    makeMessage("announcement", "accepted", {
      landing: false,
      receipt: "知道了（3 条通知类公告，没有要写入的字段）",
    }),
  )
  check("accepted 非 undone", ack.isUndone === false)
  check("无落点 → appliedCount=0", ack.appliedCount === 0, `count=${ack.appliedCount}`)

  // 3. 撤销后不再请求要点（needsSummary 只看 pending）。
  const okSummary: Message["summary"] = {
    points: ["要交 HW7"],
    itemsUsed: 1,
    itemsTotal: 1,
    status: "ok",
    createdAt: "2026-09-18T00:00:00Z",
  }
  check(
    "undone → 不再请求要点",
    !toMessageView(makeMessage("announcement", "undone", {}, okSummary)).needsSummary,
  )

  // 4. 缺 receipt / applied → 容错为 null / 0（jsonb 可能任意形状，不能崩）。
  const messy = toMessageView(
    makeMessage("announcement", "accepted", {
      receipt: 123 as unknown as string,
      applied: "nope" as unknown as object,
    }),
  )
  check("receipt 非字符串 → null", messy.receiptText === null)
  check("applied 非对象 → 0", messy.appliedCount === 0, `count=${messy.appliedCount}`)
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
