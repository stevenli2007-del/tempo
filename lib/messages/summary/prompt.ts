/**
 * 公告要点生成的 prompt 与预算（P0-3-25b）。
 *
 * ### 🔴 零 import（除了 type-only）
 * 本文件**刻意不 import 任何运行时代码**：`buildSummaryMessages()` 的返回类型
 * 用结构化的 `PromptMessage` 表达（与 `LLMMessage` 结构兼容，直接可传），
 * 而不是 `import type { LLMMessage } from '@/lib/llm'`。
 * 理由是 P0-3-25 那次构建失败：只要模块链上有一个运行时的重依赖，
 * 谁把它拖进客户端图谁就炸（Turbopack 的动态 import 挡不住模块图）。
 * 这个文件被端点、探针、回归脚本三处引用 —— 一律当"纯函数"对待最省心。
 *
 * ### 为什么要点是「数组」而不是「一段话」
 * 渲染层要逐条画、要能被断言，而且"最好 4 条"这种约束在 schema 里能表达，
 * 在自由文本里只能靠祈祷（CodingRules：禁止"自由描述 + 正则解析"）。
 *
 * ### 三条红线（与 `docs/Security-Privacy.md` 第 8 节、ADR-016 R3 对齐）
 * 1. **只依据原文**：prompt 明写"不要补充正文里没有的日期/分数/地点"，
 *    因为"AI 编一个截止日期"是这类功能最不可原谅的失败；
 * 2. **不塞进程长正文**：单条 500 字符、总计 12000 字符的预算 ——
 *    这不只是省钱，更是让一次调用能在几秒内返回（它是**后台请求**，不该被超时掐掉）；
 * 3. **覆盖不全必须说清**：喂不进去的条数如实记在 `itemsTotal - itemsUsed` 上，
 *    由 `coverageLabel()` 画给用户看，绝不假装"全都总结过了"。
 */

import type { JSONSchema } from '@/lib/llm'

import type { SummaryLocale } from './locale'

/**
 * prompt 版本号。**换 prompt 或换 schema 都要升** ——
 * `llm_runs.prompt_version` 是将来对比"哪版摘要更靠谱"的唯一依据（ADR-003 复审）。
 */
export const SUMMARY_PROMPT_VERSION = 'v1'

/** 一条消息最多喂多少条公告。摘要消息（C 口径）可能挂着 40+ 条，全喂进去又慢又贵。 */
export const MAX_ANNOUNCEMENTS_PER_MESSAGE = 20

/** 单条公告正文最多喂多少字符（超出截断加省略号）。 */
export const MAX_BODY_CHARS = 500

/** 一次调用的正文字符总预算（兜住"20 条都超长"的极端情况）。 */
export const MAX_TOTAL_BODY_CHARS = 12_000

/** 总预算只剩这么点就不塞了 —— 塞半句话进模型只会换回一条瞎猜的要点。 */
const MIN_BLOCK_CHARS = 200

/** 最多几条要点。 */
export const MAX_POINTS = 4

/** 单条要点最多多少字符（中文 40 字 ≈ 80 字符）。 */
export const MAX_POINT_CHARS = 80

/** 结构化 prompt 消息（与 `LLMMessage` 结构兼容，无需 import 即可赋值）。 */
export type PromptMessage = { role: 'system' | 'user'; content: string }

/** 参与摘要的一条公告（从 `course_announcements` 读出来的四列）。 */
export type SummarySource = {
  title: string
  courseName: string | null
  /** ISO；null = Canvas 没给发布时间。 */
  postedAt: string | null
  /** 已剥标签的正文（可能为空 / null）。 */
  bodyText: string | null
}

/** 组装好的调用输入：模型看到的就是 `blocks` 里的东西（探针直接打印它）。 */
export type SummaryInput = {
  messageTitle: string
  /** 逐条正文块（已排序、已截断）。 */
  blocks: string[]
  /** 实际喂进去的条数。 */
  itemsUsed: number
  /** 这条消息一共挂着几条公告。 */
  itemsTotal: number
  /** 因预算没喂进去的条数（`itemsUsed + omitted === itemsTotal`）。 */
  omitted: number
}

/** 截断并加省略号（只在真的截断时加）。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** 公告块的表头：让模型知道这段话属于哪门课、哪天发的。 */
function blockHeader(index: number, item: SummarySource, locale: SummaryLocale): string {
  const course = item.courseName?.trim() ? item.courseName.trim() : locale === 'en' ? '(course?)' : '（课程未知）'
  const title = item.title.trim() === '' ? (locale === 'en' ? '(untitled)' : '（无标题）') : item.title.trim()
  const date = item.postedAt ? item.postedAt.slice(0, 10) : locale === 'en' ? 'date unknown' : '发布日期未知'
  return `【${index + 1}】[${course}] ${title} · ${date}`
}

/**
 * 把一条消息挂着的公告组装成模型输入。
 *
 * ### 排序：最新的在前
 * 断更后一次涌进几十条时，"最近发生了什么"才是用户关心的；而且这样
 * `coverageLabel()` 里的"基于最新 N 条"才是**真话**（否则就是随机截断）。
 * 🔴 不依赖查询返回顺序：那是实现细节，改个 `.order()` 就静默变样。
 *    `postedAt` 是 ISO 字符串，字典序即时间序；缺失的排在最后。
 */
export function buildSummaryInput(input: {
  messageTitle: string
  announcements: SummarySource[]
  locale?: SummaryLocale
}): SummaryInput {
  const locale = input.locale ?? 'zh-CN'
  const ordered = [...input.announcements].sort((a, b) =>
    (b.postedAt ?? '').localeCompare(a.postedAt ?? ''),
  )

  const blocks: string[] = []
  let budget = MAX_TOTAL_BODY_CHARS

  for (const item of ordered) {
    if (blocks.length >= MAX_ANNOUNCEMENTS_PER_MESSAGE) break

    const body =
      truncate((item.bodyText ?? '').trim(), MAX_BODY_CHARS) ||
      (locale === 'en' ? '(no body — title only)' : '（这条公告没有正文，只有标题）')
    const block = `${blockHeader(blocks.length, item, locale)}\n${body}`

    if (block.length > budget) {
      // 预算不够：能塞多少塞多少（塞不下一个有意义的片段就干脆不塞）。
      if (budget < MIN_BLOCK_CHARS) break
      blocks.push(truncate(block, budget))
      budget = 0
      break
    }

    blocks.push(block)
    budget -= block.length
  }

  return {
    messageTitle: input.messageTitle,
    blocks,
    itemsUsed: blocks.length,
    itemsTotal: ordered.length,
    omitted: Math.max(0, ordered.length - blocks.length),
  }
}

/**
 * 系统指令。
 *
 * ⚠️ 规则 2 是"course code 保留英文原样"的来源（Steven 2026-09-18 明确要求）：
 *    把 `CHEM 1AL` 翻成"化学一A"之后，用户拿它去 bCourses 里搜是搜不到的 ——
 *    摘要的作用是"帮他决定要不要点原文"，术语被翻译就等于把这条路断了。
 */
const SYSTEM_PROMPTS: Record<SummaryLocale, string> = {
  'zh-CN': `你是 Tempo 的课程公告摘要器。用户是 Berkeley 的学生，课程公告大多是英文 —— 他需要先看中文要点，再决定要不要点开原文。

规则：
1. 只依据给定正文。**不要补充正文里没有的日期、分数、地点、人名、网址**；正文没说的就不写，不要"合理推测"。
2. 专有名词保留英文原样，不要翻译：课程代码（CHEM 1AL）、考试与作业名（Quiz 1、Midterm 2、HW7）、平台名（Gradescope、bCourses）、人名。
3. 最多 4 条要点，每条 40 字以内，短句、不要客套话。**按"对学生的行动意义"排序**：要交什么、什么时候交、时间或地点变了、要带什么，排在最前面；不要按正文顺序复述。
4. 不要写"老师提醒大家""请注意"这类空话，不要照抄问候语与署名。
5. 多条公告一起摘要时，同一门课的同类事项可以合成一条，**不要逐条复述**，只留最要紧的。
6. 正文没有实质信息（纯寒暄、纯感谢）时 points 返回空数组。
7. 输出必须严格符合 JSON schema，不要输出任何解释文字。`,
  en: `You summarize course announcements for Tempo. The user is a Berkeley student who wants the gist in English before deciding whether to open the original.

Rules:
1. Use only the given text. Do not add dates, scores, locations, names, or URLs that are not in it. No guessing.
2. Keep proper nouns exactly as written: course codes (CHEM 1AL), exam and assignment names (Quiz 1, Midterm 2, HW7), platform names (Gradescope, bCourses), people's names.
3. At most 4 bullets, each under 20 words, no filler. Order them by what matters to the student (what is due, when, schedule or room changes, what to bring) — do not restate the text in its original order.
4. Skip greetings, sign-offs, and generic reminders.
5. When several announcements are summarized together, merge related items of the same course; do not list them one by one.
6. If the text has no substance (pure greetings), return an empty points array.
7. Output must match the JSON schema exactly. No explanation text.`,
}

/** 组装一次摘要调用所需的 messages（端点与探针脚本共用）。 */
export function buildSummaryMessages(input: SummaryInput, locale: SummaryLocale): PromptMessage[] {
  const zh = locale === 'zh-CN'
  const header = zh
    ? [
        `（消息标题：${input.messageTitle}）`,
        input.omitted > 0
          ? `这条消息共 ${input.itemsTotal} 条公告，以下是其中最新的 ${input.itemsUsed} 条：`
          : `这条消息共 ${input.itemsTotal} 条公告，全部如下：`,
      ]
    : [
        `(message: ${input.messageTitle})`,
        input.omitted > 0
          ? `${input.itemsTotal} announcements in total; the newest ${input.itemsUsed} are below:`
          : `${input.itemsTotal} announcements in total, all of them below:`,
      ]

  return [
    { role: 'system', content: SYSTEM_PROMPTS[locale] },
    { role: 'user', content: [...header, '', ...input.blocks].join('\n') },
  ]
}

/**
 * 输出 schema（按语言给不同的 description —— 描述会拼进 prompt，模型看的就是它）。
 *
 * ⚠️ 只要求 `points` 一个字段：多一个字段就多一处"模型漏填 → 整份被拒"的机会，
 *    而这里没有第二个值得要的信息（不需要它复述原文、不需要它给标题）。
 */
export function summarySchema(locale: SummaryLocale = 'zh-CN'): JSONSchema {
  const zh = locale === 'zh-CN'
  return {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        description: zh
          ? `要点（简体中文，最多 ${MAX_POINTS} 条，每条不超过 40 字，专有名词保留英文）。正文没有实质信息时返回空数组`
          : `Bullet points (at most ${MAX_POINTS}, each under 20 words, keep proper nouns as written). Return an empty array if the text has no substance`,
        items: { type: 'string' },
      },
    },
    required: ['points'],
  } as const
}
