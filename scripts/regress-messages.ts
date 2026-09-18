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
import { MESSAGE_TYPE_LABELS, toMessageView } from "@/lib/messages/view"
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
): Message {
  return {
    id: "test-id",
    type,
    status,
    createdAt: "2026-09-17T18:00:00Z",
    payload: {
      title: "测试提案",
      ...payload,
    },
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
    "状态白名单是 pending/accepted/dismissed",
    JSON.stringify([...MESSAGE_STATUSES].sort()) === JSON.stringify(["accepted", "dismissed", "pending"]),
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

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
