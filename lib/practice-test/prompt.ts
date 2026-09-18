/**
 * 自测卷与逐题讲解的 prompt、schema 与**纯**校验（P0-3-23）。
 *
 * ### 🔴 这个文件必须保持"只依赖纯类型"
 * schema 与校验要被回归脚本（`scripts/regress-practice-tests.ts`）在 Node 下直接 import 断言。
 * 所以这里只从 `@/lib/llm/types` 取**类型**（会被擦除），不 import `@/lib/llm` 的入口
 * （那个会拉进各家 provider 实现）。三层分开的写法沿用 3-19b：
 * **prompt / schema / 校验（本文件，纯）** + **落库（`store.ts`）** + **下载抽文本调模型（`generate.ts`）**。
 *
 * ### 🔴 本卡的红线，逐条落在下面的 prompt 里
 * 1. **绝不幻觉出新题**（类型 B 已被否：物理/化学题会让模型编出错的公式）；
 * 2. **绝不自己算答案** —— 答案只能从用户自己选的那份 answer key 里照抄，
 *    找不到就 `null`。一个错的答案比没有答案坏得多（用户是拿它背的）；
 * 3. 题干照原文，不许"整理得更清楚"（那等于改了题）。
 *
 * `answer: null` 这个取值是有意的，**不是"模型没写"**：
 * 配不到答案文件、或答案文件里只有奇数题的答案，都会产生一批 `null`。
 * 界面必须如实说"12 题里有 3 题没找到答案"，而不是把空答案画成空白让用户自己猜。
 */

import type { JSONSchema, LLMMessage } from '@/lib/llm/types'

import {
  MAX_ANSWER_CHARS,
  MAX_CONCEPTS,
  MAX_QUESTIONS,
  MAX_QUESTION_CHARS,
  MAX_STEPS,
  MAX_STEP_CHARS,
  MAX_TITLE_CHARS,
  normalizeQuestion,
  normalizeStringList,
} from './paper'
import type { PracticeExplanation, PracticePaper } from './paper'

/** 写进 `llm_runs.prompt_version`。改 prompt 必须同步 +1（ADR-003 复审要能归因到版本）。 */
export const PRACTICE_TEST_PROMPT_VERSION = 'v1'

/** 逐题讲解的 prompt 版本（与切题分开：两者的修改节奏不同，混在一起就没法归因）。 */
export const EXPLANATION_PROMPT_VERSION = 'v1'

/**
 * 喂给模型的试卷文字上限（字符）。
 *
 * 实测试卷 PDF 大多 7-8 页、几千到一万多字；这个上限只拦"上百页的题集"。
 * 截断**不等于**可以假装完整：界面会如实标出"试卷共 N 字，本次用了前 M 字"。
 */
export const MAX_EXAM_CHARS = 40_000

/**
 * 答案文字上限（比试卷低）。
 *
 * 答案 key 通常比试卷短（只有答案或简短解析），但也有老师把完整解答全写进去的。
 * 上限低一些是因为**切题不需要答案文字**：答案文字只用来"取答案"，
 * 取不到就是 `null`，比把整份解答灌进去更划算（token 是真金白银）。
 */
export const MAX_KEY_CHARS = 24_000

// ---------------------------------------------------------------
// 输入
// ---------------------------------------------------------------

export type PracticeInput = {
  courseName: string
  examFileName: string
  /** `null` = 这次没配到答案文件（所有题都会是 `answer: null`）。 */
  keyFileName: string | null
  /** 实际喂给模型的文字（可能已截断）。 */
  examText: string
  keyText: string | null
  /** 抽取到的原始字符数（截断前）。 */
  examSourceChars: number
  keySourceChars: number
  /** 是否有任一份因过长被截断 —— 界面必须如实标注。 */
  truncated: boolean
}

export function buildPracticeInput(params: {
  courseName: string
  examFileName: string
  keyFileName: string | null
  examText: string
  keyText: string | null
}): PracticeInput {
  const examSourceChars = params.examText.length
  const keySourceChars = params.keyText?.length ?? 0
  const examTruncated = examSourceChars > MAX_EXAM_CHARS
  const keyTruncated = params.keyText !== null && keySourceChars > MAX_KEY_CHARS

  return {
    courseName: params.courseName,
    examFileName: params.examFileName,
    keyFileName: params.keyFileName,
    examText: examTruncated ? params.examText.slice(0, MAX_EXAM_CHARS) : params.examText,
    keyText:
      params.keyText === null
        ? null
        : keyTruncated
          ? params.keyText.slice(0, MAX_KEY_CHARS)
          : params.keyText,
    examSourceChars,
    keySourceChars,
    truncated: examTruncated || keyTruncated,
  }
}

// ---------------------------------------------------------------
// 切题
// ---------------------------------------------------------------

export function practiceSchema(): JSONSchema {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          '这份试卷的标题（如 `Practice Midterm 1 (F23)`）。试卷文字里有就用原文，没有就用文件名。',
      },
      questions: {
        type: 'array',
        description:
          `试卷里的**全部**题目，按原文顺序。每一项都必须有 number / text / answer 三个键。` +
          `最多 ${MAX_QUESTIONS} 题。`,
        items: {
          type: 'object',
          properties: {
            number: { type: 'string', description: '题号，照原文（`1` / `2a` / `III`）。' },
            text: {
              type: 'string',
              description:
                '题干，**照原文抄**（条件、数字、单位、选项、(a)(b) 小问都要在）。不要翻译、不要改写。',
            },
            answer: {
              type: ['string', 'null'],
              description:
                '这一题的答案，**只能从答案文字里照抄**。答案文字里找不到这一题就填 `null` ' +
                '（键必须存在，值才是 null）。**绝不自己算、绝不推测。**',
            },
          },
          required: ['number', 'text', 'answer'],
        },
      },
    },
    required: ['title', 'questions'],
  }
}

/**
 * 拼切题的 messages。
 *
 * ### 规则怎么来的（每条都对应一类真实的翻车）
 * 1. **不许出题**：本卡否掉了"LLM 出新题"的类型 B（物理/化学题会幻觉出错的公式），
 *    所以模型唯一的合法输入是**这份试卷的文字**。
 * 2. **不许算答案**：理科题里"顺手把答案算出来"对模型来说太自然了，
 *    而这份卷子的用途是**自测**——错的答案会被背下来。所以答案只准照抄。
 * 3. **题干照抄**：一旦允许"整理表述"，题目的数字与条件就可能被悄悄改掉，
 *    而改过的题做出来无法与老师的答案核对。
 * 4. **答案文字只是答案表**：模型很容易把答案文件里的解析当成"额外的题目"
 *    （那是幻觉新题最隐蔽的一种形态：看上去是原文，其实是另一份文件的内容）。
 */
export function buildPracticeMessages(input: PracticeInput): LLMMessage[] {
  const system = [
    '你在帮学生把一份学期试卷做成**自测卷**。给你两份文字：一份**试卷**（学生要做的题），',
    '以及一份**答案文件**（同一份试卷的官方答案，可能没有）。',
    '',
    '你的唯一任务：把试卷**原样**切成一道道题，并从答案文件里取出每一题的答案。',
    '',
    '硬性规则（每一条都必须遵守）：',
    '1. **绝不自己出题、补题、改题**。题目只能来自试卷文字。',
    '   不许因为"看起来缺了第 4 题"就替它编一道，不许把你想得起来的同类题型写进来，',
    '   也不许为了凑数把一道题拆成两道。',
    '2. **绝不自己算答案**。`answer` 只能从答案文件里**照抄**；答案文件里找不到这一题，',
    '   就填 `null`。空着远好过填错 —— 学生要拿这份卷子自测，一个错的答案会让他背错东西。',
    '   不要用你的学科知识补答案，不要写"由公式可得"，不要"顺手算一下"。',
    '3. 题干**照原文抄**：条件、数字、单位、选项、`(a)(b)` 小问结构都必须保留。',
    '   只允许做两件事：① 去掉页眉页脚、页码、重复的标题行；② 把多余的空格与空行压成一个。',
    '   不要翻译、不要改写、不要"整理得更清楚"、不要添加你自己的提示或提示语。',
    '4. 题号**照原文**（`1` / `2a` / `III`）。原文没有题号时，按出现顺序用 `1`、`2`…',
    '5. 只切**真正成题的题目**。指令性文字（`Show all work`、`Answer the following`、',
    '   考试须知）、公式表、分值说明、封面文字都**不算题**。',
    '6. **答案文件只用来取答案**，它不是题源 —— 不要把它里面的解析当成"额外的题目"，',
    '   也不要把答案文件里的题号当成试卷的题号。',
    '7. `questions` 里每一项都**必须**有 `number`、`text`、`answer` 三个键。',
    '   找不到答案时 `answer` 的值是 `null`，但**这个键不能省略**。',
    '8. 不要声称覆盖了全部内容，也不要数总页数／总题数 —— 你看到的可能只是其中一部分。',
    '9. 题干与答案**保持原文语言**（英文题就抄英文），不要翻译。',
  ].join('\n')

  const meta = [
    `课程：${input.courseName}`,
    `试卷文件：${input.examFileName}`,
    input.keyFileName === null
      ? '答案文件：**这次没有拿到答案文件** —— 所以每一题的 `answer` 都填 `null`，不要自己算。'
      : `答案文件：${input.keyFileName}`,
  ].join('\n')

  const coverage = input.truncated
    ? '\n\n⚠️ 材料太长，下面是**截断后**的文字（试卷共 ' +
      `${input.examSourceChars} 字，答案共 ${input.keySourceChars} 字），不代表全部内容。`
    : ''

  const answerSection =
    input.keyText === null
      ? ['=== 答案文件文字 ===', '（这次没有答案文件 —— 所有题目的 answer 都填 null）'].join('\n')
      : ['=== 答案文件文字 ===', input.keyText].join('\n')

  const user = [
    meta,
    coverage,
    '',
    '=== 试卷文字 ===',
    input.examText,
    '',
    answerSection,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export type ValidatePracticeResult =
  | {
      ok: true
      value: PracticePaper
      /** 被丢掉的条目数（读不出来的 + 超出上限的）。>0 时要留痕。 */
      dropped: number
      /** 有题但没答案的题数（配不到答案 / 答案文件不全都会产生）。界面必须报。 */
      answerless: number
    }
  | { ok: false; message: string }

/**
 * 校验切题结果。
 *
 * ### 什么算失败（落 `failed` 行 = 不再重试）
 * **一题都没切出来**才算失败。那说明这份材料不是一份可切的卷子
 * （公式表、说明页、扫描件抽残），重试也大概率一样。
 *
 * ### 为什么丢条目而不是整次作废
 * 一两条坏条目不该让整张卷子没有 —— 但丢了多少必须计数上报
 * （`dropped > 0` 是"prompt 该修了 / 模型开始乱来"的早期信号）。
 *
 * @param fallbackTitle 模型没给标题时的兜底（调用方传试卷文件名）——
 *   宁可显示文件名，也不要一张没有标题的卷子。
 */
export function validatePracticeOutput(
  raw: unknown,
  fallbackTitle: string,
): ValidatePracticeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '模型输出不是对象' }
  }

  const record = raw as Record<string, unknown>
  const title =
    typeof record.title === 'string' && record.title.trim() !== ''
      ? record.title.trim().slice(0, MAX_TITLE_CHARS)
      : fallbackTitle.trim().slice(0, MAX_TITLE_CHARS)

  const rawQuestions = Array.isArray(record.questions) ? record.questions : []

  const questions: PracticePaper['questions'] = []
  let dropped = 0
  for (const entry of rawQuestions) {
    if (questions.length >= MAX_QUESTIONS) {
      dropped += 1
      continue
    }
    const question = normalizeQuestion(entry, questions.length)
    if (question === null) {
      dropped += 1
      continue
    }
    questions.push(question)
  }

  if (questions.length === 0) {
    return { ok: false, message: '模型没有从这份试卷里切出任何题目' }
  }

  return {
    ok: true,
    value: { title, questions },
    dropped,
    answerless: questions.filter((question) => question.answer === null).length,
  }
}

// ---------------------------------------------------------------
// 逐题讲解
// ---------------------------------------------------------------

export function explanationSchema(): JSONSchema {
  return {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description:
          `解题步骤，按先后顺序，2-${MAX_STEPS} 条，每条一句中文（公式与专有名词保留原文写法）。` +
          '每条要说清"这一步在做什么、为什么这么做"，不要只写算式不解释。',
        items: { type: 'string' },
      },
      concepts: {
        type: 'array',
        description:
          `这道题用到的公式 / 定理 / 关键概念，最多 ${MAX_CONCEPTS} 条，照原文抄写。` +
          '**只放能当符号用的东西**（如 `PV = nRT`），不要放整句话。',
        items: { type: 'string' },
      },
    },
    required: ['steps', 'concepts'],
  }
}

export type ExplanationInput = {
  courseName: string
  paperTitle: string
  questionNumber: string
  questionText: string
  /** `null` = 这一题没找到答案（讲解必须如实说明，不许自己编一个答案再讲）。 */
  officialAnswer: string | null
}

export function buildExplanationInput(params: ExplanationInput): ExplanationInput {
  return params
}

/**
 * 拼讲解的 messages。
 *
 * ### 🔴 「以官方答案为准」这一条是刻意的
 * 模型经常会"觉得答案不对"然后按自己的算法讲一遍 —— 那会让学生拿到一份
 * 与老师答案冲突的讲解，而他无从判断谁对。所以：有官方答案时，**按官方答案走**；
 * 真看不出两者怎么一致，就如实说"这一步怎么从题干走到这个答案"，
 * 而不是宣布官方答案错了。
 *
 * ### 没有答案的那一题怎么办
 * 明确允许讲，但**必须标明"这一题没找到官方答案，下面是推导"** ——
 * 学生得知道自己在看的是推导而不是答案。
 */
export function buildExplanationMessages(input: ExplanationInput): LLMMessage[] {
  const system = [
    '你是学生的解题教练。给你**一道题**的题干，以及（可能有的）它的官方答案。',
    '你要讲清"这道题怎么解"。',
    '',
    '硬性规则：',
    '1. 只讲这一道题。**不要出新题**，不要改题干里的数字与条件，不要写"类似的题可以这样"',
    '   然后展开另一道题。',
    '2. 有官方答案时**以它为准**：讲的是"怎么从题干走到这个答案"。',
    '   即使你觉得答案有问题，也不要宣布它错了 —— 那会让学生拿着一份与老师冲突的讲解，',
    '   而他无从判断谁对。',
    '3. 没有官方答案时，讲推导过程，并且**第一句就说清"这一题没找到官方答案，下面是推导"**。',
    '4. 步骤 2-6 条，每条一句，说清"这一步在做什么、为什么用这个公式/这个方法"，',
    '   不要只写算式不解释。',
    '5. 「概念」栏只放公式、定理、关键概念这类能当符号用的东西，照原文抄写；',
    '   不要放完整句子。没有就返回**空数组 `[]`** —— 键必须存在，只是内容为空。',
    '6. 题目信息不足时（题干被截断、答案缺失、条件没给全）**如实说明缺什么**，',
    '   不要凭想象补条件。',
    '7. 用中文写（公式与专有名词保留原文写法）。',
  ].join('\n')

  const user = [
    `课程：${input.courseName}`,
    `试卷：${input.paperTitle}`,
    `题号：${input.questionNumber}`,
    '',
    '题干：',
    input.questionText,
    '',
    input.officialAnswer === null
      ? '官方答案：**这一题没有找到官方答案**（答案文件里没有，或这次没配到答案文件）。'
      : ['官方答案：', input.officialAnswer].join('\n'),
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export type ValidateExplanationResult =
  | { ok: true; value: PracticeExplanation; dropped: number }
  | { ok: false; message: string }

/**
 * 校验讲解结果。
 *
 * **两栏都空**才算失败（模型什么也没讲出来，重试也大概率一样）。
 * 只有 `concepts` 空是正常的（很多题没有"公式"可列），照常入库。
 */
export function validateExplanationOutput(raw: unknown): ValidateExplanationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '模型输出不是对象' }
  }

  const record = raw as Record<string, unknown>
  const rawSteps = Array.isArray(record.steps) ? record.steps : []
  const rawConcepts = Array.isArray(record.concepts) ? record.concepts : []

  const steps = normalizeStringList(record.steps, MAX_STEPS, MAX_STEP_CHARS)
  const concepts = normalizeStringList(record.concepts, MAX_CONCEPTS, MAX_STEP_CHARS)

  const dropped =
    Math.max(0, rawSteps.length - steps.length) + Math.max(0, rawConcepts.length - concepts.length)

  if (steps.length === 0 && concepts.length === 0) {
    return { ok: false, message: '模型没有给出任何讲解内容' }
  }

  return { ok: true, value: { steps, concepts }, dropped }
}

/**
 * 卷面标题为空时，用试卷文件名兜底 —— 宁可显示文件名，也不要一张没有标题的卷子。
 *
 * ⚠️ **必须先 trim 再剥后缀**：`"  a.pdf  "` 这种带尾空白的展示名在真实数据里存在，
 * 先剥后缀的话 `\.[a-z0-9]{1,6}$` 匹配不上（结尾是空格），于是文件名里的 `.pdf`
 * 会跟着进标题。
 */
export function fallbackTitleFromFileName(fileName: string): string {
  const trimmed = fileName.trim()
  const withoutExtension = trimmed.replace(/\.[a-z0-9]{1,6}$/i, '')
  const title = withoutExtension === '' ? trimmed : withoutExtension
  return title.trim().slice(0, MAX_TITLE_CHARS)
}

// 供上层引用，免得它们为了几个数字再 import 一次 paper.ts（少一处会漂的地方）。
export { MAX_ANSWER_CHARS, MAX_CONCEPTS, MAX_QUESTIONS, MAX_QUESTION_CHARS, MAX_STEPS }
