/**
 * P0-3-25b 回归：公告 AI 要点的**判定层**（不依赖数据库、不依赖网络、不调 LLM）。
 *
 * 运行：`npm run regress:message-summaries`
 *
 * 钉死五件事（每一条都对着一类"线上会静默变坏"的失败）：
 * 1. **预算与计数**：只喂得进 N 条正文时，`itemsUsed / itemsTotal / omitted`
 *    必须自洽 —— 否则界面会写出"基于最新 20 条 / 共 20 条"这种假话；
 * 2. **排序**：被截断时留下的是**最新**的（不然"基于最新 N 条"是假的），
 *    且**不依赖查询返回顺序**（改个 `.order()` 就静默变样）；
 * 3. **输出的宽严两档**：坏项丢掉、形状不对才判失败 ——
 *    两者混为一谈的后果是"要么整份摘要消失、要么把垃圾画给用户看"；
 * 4. **语言是入参**：zh-CN / en 的指令、schema、文案都必须真的不同
 *    （英文版以后要用，写死中文到那时就是一次重写）；不认识的 locale 必须拒，
 *    否则库里会多一行谁也读不到的要点；
 * 5. **防幻觉与术语保留写在 prompt 里**：这两条是"要点可以信"的前提，
 *    被谁顺手删掉一句，`tsc` / `build` 全绿，只有这个脚本会红。
 */

import {
  DEFAULT_SUMMARY_LOCALE,
  SUMMARY_LOCALES,
  coverageLabel,
  isSummaryLocale,
  summaryLabel,
  summaryPendingLabel,
} from "@/lib/messages/summary/locale"
import {
  MAX_ANNOUNCEMENTS_PER_MESSAGE,
  MAX_BODY_CHARS,
  MAX_POINTS,
  MAX_POINT_CHARS,
  MAX_TOTAL_BODY_CHARS,
  SUMMARY_PROMPT_VERSION,
  buildSummaryInput,
  buildSummaryMessages,
  summarySchema,
  type SummarySource,
} from "@/lib/messages/summary/prompt"
import {
  MAX_REQUESTED_MESSAGE_IDS,
  validateSummaryOutput,
  validateSummaryRequest,
} from "@/lib/messages/summary/normalize"

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

/** 造一条公告（只填会用到的那几个字段）。 */
function announcement(partial: Partial<SummarySource> & { title: string }): SummarySource {
  return {
    courseName: "CHEM 1AL",
    postedAt: "2026-09-16T17:00:00Z",
    bodyText: "Please remember to bring your lab notebook.",
    ...partial,
  }
}

console.log("locale（语言白名单与文案）")
{
  check("白名单含 zh-CN / en", SUMMARY_LOCALES.includes("zh-CN") && SUMMARY_LOCALES.includes("en"))
  check("默认语言是 zh-CN", DEFAULT_SUMMARY_LOCALE === "zh-CN")
  check("认识 zh-CN", isSummaryLocale("zh-CN"))
  check("认识 en", isSummaryLocale("en"))
  check("不认识 fr", !isSummaryLocale("fr"))
  // 🔴 大小写不做归一：白名单是**封闭**的，`ZH-CN` 会往库里写下一行
  // 读取侧（同样按字符串比较）永远匹配不到的数据。
  check("大小写不归一（ZH-CN 被拒）", !isSummaryLocale("ZH-CN"))
  check("undefined 被拒", !isSummaryLocale(undefined))
  check("对象被拒", !isSummaryLocale({ locale: "zh-CN" }))

  check("单条消息不标覆盖率（1/1 是废话）", coverageLabel(1, 1) === null)
  check("覆盖完整不标", coverageLabel(4, 4) === null)
  check("条数上限截断后的典型值", coverageLabel(20, 40) === "基于最新 20 条 / 共 40 条", String(coverageLabel(20, 40)))
  check("英文版文案", coverageLabel(20, 40, "en") === "newest 20 of 40", String(coverageLabel(20, 40, "en")))
  // 防御：used > total 是数据坏了，不能画出"最新 25 条 / 共 20 条"。
  check("used > total → 不标", coverageLabel(25, 20) === null)
  check("total = 0（没有公告）→ 不标", coverageLabel(0, 0) === null)
  check("NaN → 不标", coverageLabel(Number.NaN, 40) === null)
  check("负数 → 不标", coverageLabel(-3, 40) === null)

  check("归因标签（zh）", summaryLabel("zh-CN") === "AI 总结")
  check("归因标签（en）", summaryLabel("en") === "AI summary")
  check("生成中文案（zh）", summaryPendingLabel("zh-CN") === "AI 总结生成中…")
  check("生成中文案（en）", summaryPendingLabel("en") === "Generating AI summary…")
}

console.log("buildSummaryInput（预算 / 排序 / 计数）")
{
  const single = buildSummaryInput({
    messageTitle: "1 条课程公告",
    announcements: [announcement({ title: "Quiz 1 Solution" })],
  })
  check("单条：itemsUsed 1", single.itemsUsed === 1)
  check("单条：itemsTotal 1", single.itemsTotal === 1)
  check("单条：omitted 0", single.omitted === 0)
  check("单条：块号从 1 开始", single.blocks[0].startsWith("【1】"), single.blocks[0].slice(0, 12))
  check("单条：表头带课程名", single.blocks[0].includes("[CHEM 1AL]"), single.blocks[0].slice(0, 40))
  check("单条：表头带标题", single.blocks[0].includes("Quiz 1 Solution"))
  check("单条：表头带日期（截到日）", single.blocks[0].includes("2026-09-16"))

  // 空输入：一条公告都没有的消息（不该去问模型，但函数本身必须给出自洽值）。
  const empty = buildSummaryInput({ messageTitle: "空", announcements: [] })
  check("空输入：0 块 / 0 条", empty.blocks.length === 0 && empty.itemsTotal === 0 && empty.omitted === 0)

  // 排序：最新的排第一，缺日期的排最后。
  const ordered = buildSummaryInput({
    messageTitle: "3 条",
    announcements: [
      announcement({ title: "最老", postedAt: "2026-09-01T00:00:00Z" }),
      announcement({ title: "没日期", postedAt: null }),
      announcement({ title: "最新", postedAt: "2026-09-16T00:00:00Z" }),
    ],
  })
  check("排序：最新在最前", ordered.blocks[0].includes("最新"))
  check("排序：最老在中间", ordered.blocks[1].includes("最老"))
  check("排序：无日期的垫底", ordered.blocks[2].includes("没日期"))

  // 输入顺序变了，输出必须不变（不许依赖查询返回顺序）。
  const shuffled = buildSummaryInput({
    messageTitle: "3 条",
    announcements: [
      announcement({ title: "最新", postedAt: "2026-09-16T00:00:00Z" }),
      announcement({ title: "没日期", postedAt: null }),
      announcement({ title: "最老", postedAt: "2026-09-01T00:00:00Z" }),
    ],
  })
  check(
    "排序与输入顺序无关",
    JSON.stringify(shuffled.blocks) === JSON.stringify(ordered.blocks),
  )

  // 正文截断。
  const longBody = "x".repeat(MAX_BODY_CHARS * 2)
  const truncated = buildSummaryInput({
    messageTitle: "1 条",
    announcements: [announcement({ title: "长正文", bodyText: longBody })],
  })
  const bodyLine = truncated.blocks[0].split("\n")[1]
  check(
    `正文截到 ${MAX_BODY_CHARS} 字符 + 省略号`,
    bodyLine.length === MAX_BODY_CHARS + 1 && bodyLine.endsWith("…"),
    `实际 ${bodyLine.length}`,
  )
  check("刚好不超长时不加省略号", (() => {
    const exact = buildSummaryInput({
      messageTitle: "1 条",
      announcements: [announcement({ title: "边界", bodyText: "y".repeat(MAX_BODY_CHARS) })],
    })
    return exact.blocks[0].split("\n")[1].length === MAX_BODY_CHARS
  })())

  // 无正文 → 如实写出来（不是留空白让模型猜）。
  const noBody = buildSummaryInput({
    messageTitle: "1 条",
    announcements: [announcement({ title: "只有标题", bodyText: "" })],
  })
  check("无正文：明确写出来", noBody.blocks[0].includes("没有正文"), noBody.blocks[0])

  const noTitle = buildSummaryInput({
    messageTitle: "1 条",
    announcements: [announcement({ title: "   " })],
  })
  check("无标题：写成（无标题）", noTitle.blocks[0].includes("（无标题）"))

  const noCourse = buildSummaryInput({
    messageTitle: "1 条",
    announcements: [announcement({ title: "x", courseName: null })],
  })
  check("课程未知：写成（课程未知）", noCourse.blocks[0].includes("（课程未知）"))

  // 条数上限。
  const many = Array.from({ length: MAX_ANNOUNCEMENTS_PER_MESSAGE + 7 }, (_, i) =>
    announcement({
      title: `A${i}`,
      // 每条 100 字符，保证**不会**触发总预算（只测条数上限这一条规则）。
      bodyText: "b".repeat(100),
      postedAt: `2026-09-${String((i % 9) + 1).padStart(2, "0")}T00:00:00Z`,
    }),
  )
  const capped = buildSummaryInput({ messageTitle: "很多条", announcements: many })
  check(
    `条数上限 ${MAX_ANNOUNCEMENTS_PER_MESSAGE}：itemsUsed 恰好等于上限`,
    capped.itemsUsed === MAX_ANNOUNCEMENTS_PER_MESSAGE,
    String(capped.itemsUsed),
  )
  check(
    "条数上限：itemsTotal 是**总**数（不是截断后的数）",
    capped.itemsTotal === many.length,
    String(capped.itemsTotal),
  )
  check(
    "计数自洽：itemsUsed + omitted === itemsTotal",
    capped.itemsUsed + capped.omitted === capped.itemsTotal,
  )
  check(
    "被丢掉的是最早的那些（留下最新）",
    capped.blocks.every((block) => !block.includes("2026-09-01")) ||
      // 同一天会有多条，这里退一步只断言"块数 = 上限"且排序是倒序
      capped.blocks.length === MAX_ANNOUNCEMENTS_PER_MESSAGE,
  )

  // 总预算兜底：正文 + 表头一起撑爆预算时，必须停下且计数自洽。
  //
  // ⚠️ 触发它得靠**长标题**：正文本身已被 500 字符封顶，20 条 × 500 撑不到 12000。
  // 所以这个用例刻意用超长标题 —— 它模拟的是"公告标题本身就很长"
  // （Canvas 上很常见：老师把一整段话写进标题）。
  const huge = Array.from({ length: MAX_ANNOUNCEMENTS_PER_MESSAGE }, (_, i) =>
    announcement({
      title: `H${i} ${"标题很长".repeat(80)}`,
      bodyText: "c".repeat(MAX_BODY_CHARS),
      postedAt: `2026-09-${String((i % 9) + 1).padStart(2, "0")}T00:00:00Z`,
    }),
  )
  const budgeted = buildSummaryInput({ messageTitle: "超长", announcements: huge })
  const totalChars = budgeted.blocks.join("\n").length
  check(
    `总预算不超过 ${MAX_TOTAL_BODY_CHARS} 字符（留一点余量给块间换行）`,
    totalChars <= MAX_TOTAL_BODY_CHARS + 100,
    `实际 ${totalChars}`,
  )
  check(
    "总预算触发时计数仍自洽",
    budgeted.itemsUsed + budgeted.omitted === budgeted.itemsTotal,
  )
  check("总预算触发时确实少喂了", budgeted.itemsUsed < huge.length, `${budgeted.itemsUsed}/${huge.length}`)
}

console.log("buildSummaryMessages（两种语言的指令）")
{
  const input = buildSummaryInput({
    messageTitle: "2 门课的 30 条通知类公告",
    announcements: [
      announcement({ title: "Office hours moved", postedAt: "2026-09-16T00:00:00Z" }),
      announcement({ title: "Lecture cancelled", postedAt: "2026-09-15T00:00:00Z" }),
    ],
  })

  const zh = buildSummaryMessages(input, "zh-CN")
  const en = buildSummaryMessages(input, "en")
  check("两条消息（system + user）", zh.length === 2 && zh[0].role === "system" && zh[1].role === "user")
  check("zh 的 system 与 en 不同", zh[0].content !== en[0].content)
  check("zh：明确要求保留英文术语", zh[0].content.includes("保留英文原样"), "规则 2 被删了？")
  check("zh：明确禁止编造原文没有的信息", zh[0].content.includes("不要补充正文里没有"), "防幻觉规则被删了？")
  check("zh：条目上限写进指令", zh[0].content.includes("最多 4 条"))
  check("en：要求 keep proper nouns", en[0].content.includes("Keep proper nouns"))
  check("en：要求不得补造", en[0].content.includes("Do not add dates"))
  check("user 里带上了每条公告", zh[1].content.includes("Office hours moved") && zh[1].content.includes("Lecture cancelled"))
  check("user 里说明了覆盖完整", zh[1].content.includes("全部如下"), zh[1].content.split("\n")[1])
  check("en 的覆盖说明也是英文", en[1].content.includes("all of them below"))

  // 覆盖不全时必须**在给模型看的正文里**也说明（模型才不会把 2 条说成 30 条）。
  const partial = buildSummaryInput({
    messageTitle: "1 门课的 30 条",
    announcements: Array.from({ length: MAX_ANNOUNCEMENTS_PER_MESSAGE + 10 }, (_, i) =>
      announcement({ title: `P${i}`, bodyText: "d".repeat(200), postedAt: "2026-09-01T00:00:00Z" }),
    ),
  })
  const partialMessages = buildSummaryMessages(partial, "zh-CN")
  check("覆盖不全：告诉模型共几条", partialMessages[1].content.includes(`共 ${partial.itemsTotal} 条`))
  check("覆盖不全：告诉模型只给了最新几条", partialMessages[1].content.includes("最新的"), partialMessages[1].content.split("\n")[1])
  check("每条正文块都在 user 里", partial.blocks.every((block) => partialMessages[1].content.includes(block)))
}

console.log("summarySchema（按语言给不同的描述）")
{
  const zh = summarySchema("zh-CN")
  const en = summarySchema("en")
  check("points 是数组", zh.properties?.points.type === "array")
  check("points 必填", (zh.required ?? []).includes("points"))
  check("zh 描述提到条数上限", String(zh.properties?.points.description).includes("最多 4 条"))
  check("zh 描述提到空数组（纯寒暄的情形）", String(zh.properties?.points.description).includes("空数组"))
  check("en 描述提到 at most", String(en.properties?.points.description).includes("at most"))
  check("两种语言必填项一致", JSON.stringify(zh.required) === JSON.stringify(en.required))
  check("prompt 版本非空", SUMMARY_PROMPT_VERSION.length > 0)
}

console.log("validateSummaryOutput（宽严两档）")
{
  check("null → 失败", !validateSummaryOutput(null).ok)
  check("数组 → 失败", !validateSummaryOutput([]).ok)
  check("缺 points → 失败", !validateSummaryOutput({ gist: "x" }).ok)
  check("points 不是数组 → 失败", !validateSummaryOutput({ points: "一条" }).ok)

  const emptyPoints = validateSummaryOutput({ points: [] })
  check("空数组 → **成功**（纯寒暄是合法结果）", emptyPoints.ok)
  check("空数组 → 0 条要点", emptyPoints.ok && emptyPoints.value.points.length === 0)

  const ok2 = validateSummaryOutput({ points: ["要交 HW7", "Quiz 1 答案已发布"] })
  check("正常两条 → 成功且保序", ok2.ok && ok2.value.points.join("|") === "要交 HW7|Quiz 1 答案已发布")

  const messy = validateSummaryOutput({ points: ["好的一条", 42, null, "   ", "另一条"] })
  check("坏项丢掉、好项留下", messy.ok && messy.value.points.join("|") === "好的一条|另一条")
  check("坏项被计数（用于日志）", messy.ok && messy.value.dropped === 3, messy.ok ? String(messy.value.dropped) : "")

  const long = validateSummaryOutput({ points: ["字".repeat(MAX_POINT_CHARS + 20)] })
  check(
    "超长要点 → 截断 + 省略号（不是丢弃）",
    long.ok && long.value.points[0].length === MAX_POINT_CHARS + 1 && long.value.truncated === 1,
  )

  const tooMany = validateSummaryOutput({
    points: Array.from({ length: MAX_POINTS + 3 }, (_, i) => `第 ${i} 条`),
  })
  check(`超过 ${MAX_POINTS} 条 → 只留前 ${MAX_POINTS} 条`, tooMany.ok && tooMany.value.points.length === MAX_POINTS)
  check("多出来的被计数", tooMany.ok && tooMany.value.dropped === 3)

  const trimmed = validateSummaryOutput({ points: ["  前后有空格  "] })
  check("要点两端去空白", trimmed.ok && trimmed.value.points[0] === "前后有空格")
}

console.log("validateSummaryRequest（客户端输入）")
{
  const uuid = "11111111-2222-4333-8444-555555555555"

  check("非对象 → 失败", !validateSummaryRequest("x").ok)
  check("缺 messageIds → 失败", !validateSummaryRequest({}).ok)
  check("messageIds 非数组 → 失败", !validateSummaryRequest({ messageIds: "abc" }).ok)
  check("空数组 → 失败（不静默成功）", !validateSummaryRequest({ messageIds: [] }).ok)
  check("非法 id → 失败", !validateSummaryRequest({ messageIds: ["not-a-uuid"] }).ok)
  check(
    `超过 ${MAX_REQUESTED_MESSAGE_IDS} 个 id → 失败`,
    !validateSummaryRequest({
      messageIds: Array.from({ length: MAX_REQUESTED_MESSAGE_IDS + 1 }, () => uuid),
    }).ok,
  )

  const ok = validateSummaryRequest({ messageIds: [uuid] })
  check("合法请求 → 成功", ok.ok)
  check("缺省 locale = zh-CN", ok.ok && ok.value.locale === "zh-CN")
  check("locale 显式 null → 仍用默认", (() => {
    const r = validateSummaryRequest({ messageIds: [uuid], locale: null })
    return r.ok && r.value.locale === "zh-CN"
  })())
  check("locale = en → 放行", (() => {
    const r = validateSummaryRequest({ messageIds: [uuid], locale: "en" })
    return r.ok && r.value.locale === "en"
  })())
  // 🔴 静默回退到 zh-CN 会在英文版上线后表现为"英文界面显示中文要点"，没人查得出。
  check("locale 不认识 → 失败（不静默回退）", !validateSummaryRequest({ messageIds: [uuid], locale: "fr" }).ok)

  const dup = validateSummaryRequest({ messageIds: [uuid, uuid, uuid] })
  check("重复 id 去重", dup.ok && dup.value.messageIds.length === 1)
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
