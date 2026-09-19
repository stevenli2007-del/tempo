/**
 * 考试复习总结（P0-3-31）的 prompt、schema 与**纯**校验。
 *
 * ### 🔴 这个文件必须保持零依赖（3-19 / 3-23 踩过的同一个坑）
 * schema 与"模型写歪了怎么办"的判据要被回归脚本（`scripts/regress-exam-review.ts`）
 * 直接 import 断言。本文件一旦 import 任何服务端模块（`lib/llm/run` → `next/headers`），
 * 脚本就用 Node 的类型擦除跑不起来了。
 *
 * 三层分开：**prompt / schema / 校验（本文件，纯）** + **落库（`store.ts`）**
 * + **取内容调模型（`generate.ts`）**。
 *
 * ### 🔴 这里也永不接触课件原文
 * 本文件只处理"已经抽成文本的字符串"，不碰字节、不碰 Canvas、不碰 Storage。
 *
 * ### 与 `file_summaries` 的 prompt 差别在哪
 * 单文件总结是**一份材料的提要**；这里是**多份材料合并成一场考试的复习提要**：
 * 逐份给要点（带 `f1/f2…` 编号，界面据此挂「原文 ↗」），外加跨文件的"这次考试的重点"。
 * 因此多了 `ref` 这一维 —— 模型必须把要点挂回它读的那一份，**不许把 A 份的内容记到 B 份名下**。
 */

// 只从**纯类型**文件取类型：入口 `@/lib/llm` 会 import 各 provider 的实现，
// 而本文件必须能被回归脚本在 Node 下直接 import。
import type { JSONSchema, LLMMessage } from '@/lib/llm/types'

/** 写进 `llm_runs.prompt_version`。改 prompt 必须同步 +1（ADR-003 复审要能归因到版本）。 */
export const EXAM_REVIEW_PROMPT_VERSION = 'v1'

/**
 * 喂给模型的**总**文本上限（字符，所有材料合计）。
 *
 * 比单文件总结的 24,000 高一档：这里要把 3–5 份材料（试卷 + 答案 + 讲义）一起喂进去。
 * 截断**不等于**可以假装完整：界面会如实标出"共 N 字，本次用了前 M 字"。
 */
export const MAX_SOURCE_CHARS = 40_000

/** **每份**材料的要点条数上限（与 prompt 里写的必须一致）。 */
export const MAX_POINTS_PER_FILE = 6

/** 跨文件的"重点"条数上限。 */
export const MAX_KEY_TOPICS = 8

/** 单条要点 / 重点的长度上限。超长基本是模型在写段落，不是要点。 */
export const MAX_ITEM_CHARS = 200

/** 一份材料喂进模型时的最小形状。`ref` 是给模型用的编号（`f1` / `f2` …）。 */
export type ReviewSource = {
  /** 编号。模型必须在输出的 `files[].ref` 里回指它。 */
  ref: string
  /** 给模型看的标题（文件名，**不是**给人看的最终标签 —— 那个在 manifest 里）。 */
  label: string
  text: string
}

/** 结构化复习总结 —— 也是存进 `exam_review_summaries.summary` 的形状。 */
export type ExamReviewPayload = {
  /** 一句话：这次考试大概覆盖哪些内容。 */
  overview: string
  /** 逐份材料的要点（`ref` 回指 `source_manifest` 里的一项）。 */
  files: Array<{ ref: string; points: string[] }>
  /** 跨材料的重点（这次考试反复出现的东西）。 */
  keyTopics: string[]
}

/** 已截断判断 + 截断后的输入。 */
export type ExamReviewInput = {
  courseName: string
  examLabel: string
  /** 每份材料的文本（可能已按总预算等分截断）。 */
  sources: ReviewSource[]
  /** 截断前所有材料加起来的字符数。 */
  rawChars: number
  /** 是否因过长被截断 —— 界面必须如实标注。 */
  truncated: boolean
}

/**
 * 按**总预算等分**给每份材料分配额度后截断。
 *
 * 为什么不"从头填到满"：那样后面的材料会因为前面太长而**一个字符都进不去**，
 * 用户看到"总结没覆盖这份"却不知道是被挤掉的。等分之后最坏是每份都少读一点，
 * 而不是某几份完全缺席。
 */
export function buildExamReviewInput(params: {
  courseName: string
  examLabel: string
  sources: readonly { ref: string; label: string; text: string }[]
}): ExamReviewInput {
  const sources = params.sources.map((s) => ({ ...s }))
  const rawChars = sources.reduce((sum, s) => sum + s.text.length, 0)

  if (rawChars <= MAX_SOURCE_CHARS || sources.length === 0) {
    return { courseName: params.courseName, examLabel: params.examLabel, sources, rawChars, truncated: false }
  }

  const perSource = Math.max(1, Math.floor(MAX_SOURCE_CHARS / sources.length))
  const truncatedSources = sources.map((s) => ({
    ref: s.ref,
    label: s.label,
    text: s.text.slice(0, perSource),
  }))

  return {
    courseName: params.courseName,
    examLabel: params.examLabel,
    sources: truncatedSources,
    rawChars,
    truncated: true,
  }
}

/**
 * 输出 schema。
 *
 * 强制结构化（而不是"自由描述 + 正则解析"）是 `TechStack.md` 5.2 的硬性要求 5：
 * 正则解析会随模型措辞漂移且漂移之后看不出来；结构化之后跑偏会被校验层拦在入库前。
 */
export function examReviewSchema(): JSONSchema {
  return {
    type: 'object',
    properties: {
      overview: {
        type: 'string',
        description: '一句话说明这次考试大概覆盖哪些内容。中文，不超过 80 字。',
      },
      files: {
        type: 'array',
        description:
          '逐份材料的要点。**每一份都要有一项**，`ref` 用它被给定的编号（f1 / f2 …）原样回填；' +
          '某一份材料没有可提炼的内容时，该项照给、`points` 给空数组 []。',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: '材料的编号，如 f1。' },
            points: {
              type: 'array',
              description: '这份材料的要点，最多 6 条，每条一句中文、尽量不超过 60 字。',
              items: { type: 'string' },
            },
          },
          required: ['ref', 'points'],
        },
      },
      keyTopics: {
        type: 'array',
        description:
          '跨材料的重点（这次考试反复出现、或老师明确强调的东西），最多 8 条。' +
          '没有就给空数组 []。',
        items: { type: 'string' },
      },
    },
    required: ['overview', 'files', 'keyTopics'],
  }
}

/**
 * 拼 messages。
 *
 * 规则逐条对应一次真实翻车：
 * 1. **只依据给定文字** —— 多材料总结最容易出的错是"补常识"，让用户以为材料里真讲了。
 * 2. **要点挂回正确的那一份** —— 把 A 份的内容记到 B 份名下，用户点「原文 ↗」去核对时
 *    会对不上，且**看不出来**（两边都是"看起来很合理"的学科内容）。
 * 3. **不许编题 / 不许给答案** —— 本卡**不是**出题器（ADR-027 红线）：
 *    出卷只在用户挑中一份 past exam 后，从那份卷子里**切**题（`lib/practice-test/`）。
 * 4. **不许声称完整 / 不许数页** —— 文本可能被总预算截断，也可能本身是扫描件抽残的。
 */
export function buildExamReviewMessages(input: ExamReviewInput): LLMMessage[] {
  const system = [
    '你是学生的考前复习助手。给你**几份**课程材料里抽出来的文字，你要合成一份"这场考试该看什么"的中文复习提要。',
    '',
    '硬性规则：',
    '1. **只依据给出的文字**。不要补充任何材料里没写的内容，不要引入你已有的学科知识。',
    '2. 不确定或文字残缺时，宁可少写，**绝不猜**。',
    '3. **要点必须挂在它真正来自的那一份材料下**：`files` 里每一项的 `ref` 用它被给定的编号（f1 / f2 …）。',
    '   不许把某一份的内容写进另一份名下 —— 用户会点着「原文」去核对，挂错了就对不上。',
    '4. **你不是出题人**：**绝不**编写题目、**绝不**给答案。你要做的是"把材料里的重点提炼出来"，不是"出卷子"。',
    '5. **不要声称覆盖了全部内容**，也不要数总页数 / 总题数 —— 你看到的可能只是其中一部分。',
    '6. 公式、变量、专业术语**照原文抄写**（`Ksp` 就是 `Ksp`，英文术语保留英文），不要翻译成中文解释。',
    '7. 每份材料的要点**最多 6 条**；宁可把相邻的几点合并成一句概括，也不要一条一题地铺开。',
    '8. 「重点」这一栏放**跨材料**反复出现、或材料里被强调的东西，最多 8 条。',
    '9. 三个字段都不能省略；某一栏确实没有内容时给**空数组 `[]`**，不要为了填满去凑。',
  ].join('\n')

  const meta = [`课程：${input.courseName}`, `考试：${input.examLabel}`].join('\n')

  const body = input.sources
    .map((s) => `【${s.ref}】${s.label}\n${s.text}`)
    .join('\n\n----- 下一份材料 -----\n\n')

  const coverage = input.truncated
    ? `\n\n⚠️ 这些材料合计太长（原文共 ${input.rawChars} 字符），下面是**按额度截断后**的部分，不代表全部内容。`
    : ''

  const user = [
    meta,
    '',
    '以下是各份材料的文字内容（每份以【fN】开头）：',
    '=====',
    body,
    '=====',
    coverage,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export type ValidateResult =
  | {
      ok: true
      value: ExamReviewPayload
      /** 被丢弃的坏/超量条目数（>0 时要留痕）。 */
      dropped: number
    }
  | { ok: false; message: string }

/**
 * 校验模型输出。
 *
 * ### 什么算失败（落 `failed` 行 = 不再重试）
 * **三者全空**才算失败 —— 那说明模型这次什么都没读出来，重试也大概率一样。
 * 只缺其中一两项是正常的（比如某份讲义确实没有要点），照常入库、照常展示。
 *
 * ### 为什么丢坏条目而不是整次作废
 * 模型多写几条 / 编了个不存在的 `ref`，不影响已写那些的对错；整次作废的代价是
 * 这场考试**永远没有复习总结**。但丢了多少必须计数上报（`dropped`）——
 * "模型开始写废话 / 编 ref"是 prompt 该修的早期信号。
 *
 * 🔴 `ref` **只认给定的编号**（`allowedRefs`）：模型编出来的 `f9` 会被丢掉，
 * 否则界面按 ref 去 manifest 里找标签时会找不到、把一段内容挂到空处。
 */
export function validateExamReviewOutput(
  raw: unknown,
  allowedRefs: readonly string[],
): ValidateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '模型输出不是对象' }
  }

  const record = raw as Record<string, unknown>
  const allowed = new Set(allowedRefs)

  const overview = typeof record.overview === 'string' ? record.overview.trim() : ''
  const keyTopics = readStringList(record.keyTopics).slice(0, MAX_KEY_TOPICS)

  let dropped = Math.max(0, readStringList(record.keyTopics).length - MAX_KEY_TOPICS)

  const files: Array<{ ref: string; points: string[] }> = []
  const seen = new Set<string>()

  const rawFiles = Array.isArray(record.files) ? record.files : []
  for (const entry of rawFiles) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      dropped += 1
      continue
    }
    const item = entry as Record<string, unknown>
    const ref = typeof item.ref === 'string' ? item.ref.trim() : ''
    // 编出来的 ref（不在给定集合里）直接丢 —— 见文件头。
    if (!allowed.has(ref)) {
      dropped += 1
      continue
    }
    // 同一 ref 出现两次：只留第一条（后面的会覆盖前面，且看不出来）。
    if (seen.has(ref)) {
      dropped += 1
      continue
    }
    seen.add(ref)

    const points = readStringList(item.points)
    if (points.length > MAX_POINTS_PER_FILE) dropped += points.length - MAX_POINTS_PER_FILE
    files.push({ ref, points: points.slice(0, MAX_POINTS_PER_FILE) })
  }

  // 给**每一份材料**都补一项（模型漏掉某一份时，界面仍要能画出"这份没提炼出要点"）。
  for (const ref of allowedRefs) {
    if (!seen.has(ref)) files.push({ ref, points: [] })
  }
  // 按给定顺序排（可复现），与界面/清单顺序一致。
  files.sort((a, b) => allowedRefs.indexOf(a.ref) - allowedRefs.indexOf(b.ref))

  const value: ExamReviewPayload = { overview, files, keyTopics }

  const hasAnyPoint = value.files.some((f) => f.points.length > 0)
  if (value.overview === '' && !hasAnyPoint && value.keyTopics.length === 0) {
    return { ok: false, message: '模型没有读出任何内容' }
  }

  return { ok: true, value, dropped }
}

/** 把 unknown 读成"干净的非空字符串数组"：非字符串丢掉、去空白、丢空串、超长截断。 */
function readStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []

  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    out.push(trimmed.slice(0, MAX_ITEM_CHARS))
  }
  return out
}
