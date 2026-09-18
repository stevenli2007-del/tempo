/**
 * 单文件「一键总结」（P0-3-19b）的 prompt、schema 与**纯**校验。
 *
 * ### 🔴 这个文件必须保持零依赖（3-19 踩过的同一个坑）
 * schema 与"模型写歪了怎么办"的判据要被回归脚本（`scripts/regress-course-files.ts`）
 * 直接 import 断言。本文件一旦 import 任何服务端模块（`lib/llm/run` → `next/headers`），
 * 脚本就用 Node 的类型擦除跑不起来了。
 *
 * 所以三层分开：**prompt / schema / 校验（本文件，纯）** +
 * **落库（`store.ts`）** + **下载抽文本调模型（`generate.ts`）**。
 *
 * ### 🔴 这里也永不接触课件原文
 * 本文件只处理"已经抽成文本的字符串"，不碰字节、不碰 Canvas。
 */

// 只从**纯类型**文件取类型（而不是 `@/lib/llm` 的入口）：
// 入口会 import 各 provider 的实现，而本文件必须能被回归脚本在 Node 下直接 import。
import type { JSONSchema, LLMMessage } from '@/lib/llm/types'

/** 写进 `llm_runs.prompt_version`。改 prompt 必须同步 +1（ADR-003 复审要能归因到版本）。 */
export const SUMMARY_PROMPT_VERSION = 'v1'

/**
 * 喂给模型的文本上限（字符）。
 *
 * 实测三个真实文件：syllabus 13,947 字 / L1 Slides 5,703 字 / Answer Key 8,470 字
 * —— 常态化都在 1.5 万以内，这个上限只拦"上百页的讲义"。
 * 截断**不等于**可以假装完整：界面上会如实标出"共 N 字，本次用了前 M 字"。
 */
export const MAX_SOURCE_CHARS = 24_000

/**
 * 要点条数上限（与 prompt 里写的"最多 8 条"**必须一致**）。
 *
 * 实测（2026-09-18 真账号）：不写死上限时，一份 31 题的答案 key 会被模型摊成 **16 条**
 * —— 每条一题，读起来比原文还长，等于没总结。把上限压到 8 之后模型才会去合并概括。
 *
 * 校验层仍然只**裁掉**超量条目而不是整次失败（多写几条不影响已写那些的对错），
 * 但超量多少要计数上报：`dropped > 0` 就是"prompt 该修了"的早期信号。
 */
export const MAX_POINTS = 8

/** 单条要点/公式的长度上限。超长基本是模型在写段落，不是要点。 */
export const MAX_ITEM_CHARS = 200

/** 结构化总结的载荷 —— 也是存进 `file_summaries.summary` 的形状。 */
export type FileSummaryPayload = {
  /** 一句话：这份材料是什么、覆盖哪些内容。 */
  overview: string
  /** 要点（有序，按材料里的顺序）。空数组合法 = 材料确实没有可提炼的要点。 */
  points: string[]
  /** 材料里出现的公式 / 定义 / 关键词（**照原文抄**，英文术语与公式原样保留）。 */
  formulas: string[]
}

/** 已截断判断 + 截断后的文本。 */
export type SummaryInput = {
  fileName: string
  folderPath: string
  courseName: string
  /** 实际喂给模型的文本（可能已截断）。 */
  text: string
  /** 抽取到的原始字符数（截断前）。 */
  sourceChars: number
  /** 是否因过长被截断 —— 界面必须如实标注。 */
  truncated: boolean
}

export function buildSummaryInput(params: {
  fileName: string
  folderPath: string
  courseName: string
  text: string
}): SummaryInput {
  const sourceChars = params.text.length
  const truncated = sourceChars > MAX_SOURCE_CHARS

  return {
    fileName: params.fileName,
    folderPath: params.folderPath,
    courseName: params.courseName,
    text: truncated ? params.text.slice(0, MAX_SOURCE_CHARS) : params.text,
    sourceChars,
    truncated,
  }
}

/**
 * 输出 schema。
 *
 * 强制结构化（而不是"自由描述 + 正则解析"）是 `TechStack.md` 5.2 的硬性要求 5：
 * 正则解析的输出格式会随模型措辞漂移，且漂移之后**看不出来**（照样有结果，只是难看）。
 * 结构化之后，模型跑偏会被校验层拦在入库前，落成一行可解释的 `failed`。
 */
export function summarySchema(): JSONSchema {
  return {
    type: 'object',
    properties: {
      overview: {
        type: 'string',
        description: '一句话说明这份材料是什么、覆盖哪些内容。中文，不超过 80 字。',
      },
      points: {
        type: 'array',
        description:
          '3-8 条要点（**最多 8 条**，超出会被丢弃），按材料里出现的顺序，每条一句中文、尽量不超过 60 字。',
        items: { type: 'string' },
      },
      formulas: {
        type: 'array',
        description:
          '材料里的**公式、变量、常数**（如 `PV = nRT`、`Ksp`、`R = 0.0821 L atm K⁻¹ mol⁻¹`），' +
          '最多 8 条，照原文抄写。**只放能当符号/公式用的东西** —— 不要放完整句子、口号、' +
          '评分区间、引用语。没有就给空数组。',
        items: { type: 'string' },
      },
    },
    required: ['overview', 'points', 'formulas'],
  }
}

/**
 * 拼 messages。
 *
 * ### 规则是怎么定的（每一条都对应一次见过的翻车）
 * 1. **只依据给定文本** —— 课件总结最容易出的错是"补常识"：
 *    材料讲 VSEPR，模型顺手把整章教科书知识写进来，用户以为课件里真讲了。
 * 2. **不许数页 / 不许声称完整** —— 文本可能是截断的、也可能是扫描件抽残的，
 *    模型说"本讲义共 24 页 8 个部分"时它并不知道自己看到的是不是全集。
 * 3. **术语与公式照抄** —— 化学习题里的 `𝐾𝑠𝑝`、`ΔG°` 翻译成中文反而没法在小抄上用。
 * 4. **要点按材料顺序** —— 打乱顺序会让"这条在讲哪一页"失去线索。
 */
export function buildSummaryMessages(input: SummaryInput): LLMMessage[] {
  const system = [
    '你是学生的课程资料助手。给你一份课程材料里**抽出来的文字**，你要把它压成一份能快速扫的中文提要。',
    '',
    '硬性规则：',
    '1. **只依据给出的文字**。不要补充任何材料里没写的内容，不要引入你已有的学科知识。',
    '2. 不确定或文字残缺时，宁可少写，**绝不猜**。',
    '3. **不要声称覆盖了全部内容**，也不要数总页数/总章节数 —— 你看到的可能只是其中一部分。',
    '4. 公式、变量、专业术语**照原文抄写**（`Ks p` 这类就是 `Ksp`，英文术语保留英文），不要翻译成中文解释。',
    '5. 要点**按材料里出现的顺序**排列。',
    '6. 全部用中文书写（第 4 条要求保留的公式与术语例外）。',
    '7. 要点**最多 8 条**。宁可把相邻的几点合并成一句概括，也不要一条一题地铺开 —— 总结比原文还长就等于没总结。',
    '8. 「公式」这一栏**只放公式、变量、常数**这类能当符号用的东西。',
    '   不要放完整句子、口号、评分区间（如「A 495–550」）或引用语 —— 那些要么属于要点，要么根本不该出现。',
    '9. 材料里可能没有任何公式：那种情况把「公式」这一栏返回**空数组 `[]`** ——',
    '   字段本身必须存在（三个字段都不能省略），只是内容为空。不要为了填满它去凑。',
  ].join('\n')

  const meta = [
    `课程：${input.courseName}`,
    `文件：${input.fileName}`,
    input.folderPath === '' ? '位置：课程文件根目录' : `位置：${input.folderPath}`,
  ].join('\n')

  const coverage = input.truncated
    ? `\n\n⚠️ 这份材料的文字太长，下面是**前 ${MAX_SOURCE_CHARS} 个字符**（原文共 ${input.sourceChars} 字符），不代表全部内容。`
    : ''

  const user = [
    meta,
    '',
    '以下是材料的文字内容：',
    '-----',
    input.text,
    '-----',
    coverage,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export type ValidateResult =
  | { ok: true; value: FileSummaryPayload; /** 被丢掉的超量条目数（>0 时要留痕）。 */ dropped: number }
  | { ok: false; message: string }

/**
 * 校验模型输出。
 *
 * ### 什么算失败（落 `failed` 行 = 不再重试）
 * **三者全空**才算失败 —— 那说明模型这次什么都没读出来，重试也大概率一样。
 * 只缺其中一两项是正常的（习题答案 key 里就常常没有"公式"这一栏），
 * 那种情况照常入库、照常展示。
 *
 * ### 为什么丢超量条目而不是整次作废
 * 模型多写了几条不影响已写那几条的对错；整次作废的代价是这份文件**永远没有总结**。
 * 但丢了多少必须计数上报（`dropped`）—— "模型开始写废话"是 prompt 该修的早期信号。
 */
export function validateSummaryOutput(raw: unknown): ValidateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '模型输出不是对象' }
  }

  const record = raw as Record<string, unknown>

  const overview = typeof record.overview === 'string' ? record.overview.trim() : ''
  const points = readStringList(record.points)
  const formulas = readStringList(record.formulas)

  const dropped = Math.max(0, points.length - MAX_POINTS) + Math.max(0, formulas.length - MAX_POINTS)

  const value: FileSummaryPayload = {
    overview,
    points: points.slice(0, MAX_POINTS),
    formulas: formulas.slice(0, MAX_POINTS),
  }

  if (value.overview === '' && value.points.length === 0 && value.formulas.length === 0) {
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
