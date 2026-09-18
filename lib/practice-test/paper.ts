/**
 * 自测卷的**卷面形状**与读取守卫（P0-3-23）。
 *
 * ### 🔴 这个文件也是零依赖
 * `PracticePaper` 出现在**客户端组件链**上（消息栏的视图模型要带卷面引用，
 * `lib/messages/view.ts` → `messages-view.tsx`）。按 3-25 踩出来的那条纪律：
 * 客户端要读的纯数据必须住在**零 import** 的模块里 ——
 * 动态 `import()` 挡不住 Turbopack 的模块图分析，一旦这里 import 了服务端模块，
 * `next build` 会直接红。
 *
 * `prompt.ts` import 本文件（单向），反向绝不允许。
 *
 * ### 这里为什么有"上限"常量
 * 上限同时被**写入侧**（`validatePracticeOutput` 裁剪 + 计数）与**读取侧**（`readPaper` 渲染守卫）
 * 用。两处必须是同一组数 —— 分开放两个文件就是 P0-3-15 那类"同一个判定写两遍"的预备队。
 */

// ---------------------------------------------------------------
// 卷面
// ---------------------------------------------------------------

/**
 * 一题最多切多少题（**安全上限，不是产品上限**）。
 * 实测一份 practice midterm 是 8-20 题，60 已经覆盖全部真实试卷；
 * 超过就截断并**计数上报**（`dropped`），界面如实说"只切出了前 N 题"——
 * 静默 `slice` 会让用户以为那就是全部（`file_summaries` 的 `MAX_POINTS` 同一条纪律）。
 */
export const MAX_QUESTIONS = 60

/** 单题题干长度上限。超长基本是模型把整页抄进来了，不是一道题。 */
export const MAX_QUESTION_CHARS = 4_000

/** 单题答案长度上限。答案 key 里偶有推导过程，留得比题干紧。 */
export const MAX_ANSWER_CHARS = 2_000

/** 卷面标题长度上限。 */
export const MAX_TITLE_CHARS = 120

/** 一题最多几条讲解步骤 / 几个涉及的概念。 */
export const MAX_STEPS = 8
export const MAX_CONCEPTS = 6

/** 单条讲解步骤 / 概念的长度上限。 */
export const MAX_STEP_CHARS = 400

export type PracticeQuestion = {
  /**
   * 稳定键（`q1` / `q2` …，按**切题顺序**生成），讲解缓存的 key。
   *
   * 为什么不用题号（`1`、`2a`、`II.3`）：模型给的题号形状不可控（带括号、罗马数字、
   * 中英文混排），拿它当数据库键就得先做一次"归一化"，而归一化写错了会出现
   * **两题共用一个键**（后写的讲解把前一题的覆盖掉，且看不出来）。
   * 顺序键的形状是我们自己定的，简单、无歧义、URL 安全。
   */
  key: string
  /** 题号，**照原文**（`1` / `2a` / `III`）。 */
  number: string
  /** 题干，**照原文**（只做空白归一化，不改写、不翻译、不"整理"）。 */
  text: string
  /** 答案。`null` = 答案文件里没找到这一题 —— **绝不用模型推断的答案填进来**。 */
  answer: string | null
}

export type PracticePaper = {
  title: string
  questions: PracticeQuestion[]
}

/** 逐题讲解的载荷。 */
export type PracticeExplanation = {
  /** 解题步骤，每条一句、按先后顺序。 */
  steps: string[]
  /** 涉及的概念 / 公式（照原文抄，用于回看时定位）。 */
  concepts: string[]
}

/** 第 `index` 题（0-based）的键。 */
export function questionKey(index: number): string {
  return `q${index + 1}`
}

/** 从键反查下标（`q3` → 2）。形状不对返回 `null` —— 调用方据此把请求判成 400。 */
export function questionIndex(key: string): number | null {
  const matched = /^q([1-9]\d*)$/.exec(key)
  if (!matched) return null
  const index = Number(matched[1]) - 1
  return Number.isSafeInteger(index) ? index : null
}

/**
 * 把行里的 `paper` 读成卷面。
 *
 * `paper` 是 jsonb，写入侧虽然已过 `validatePracticeOutput()`，但**读的时候不能假设**：
 * 手改过的行、旧版本写的行都可能缺字段。缺就降级（丢那一题 / 那一段），
 * 绝不把 `undefined` 塞进 `questions.map()` 让整页崩掉 —— 一道题坏掉不该让整张卷子打不开。
 */
export function readPaper(raw: unknown): PracticePaper {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { title: '', questions: [] }
  }
  const record = raw as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE_CHARS) : ''

  const rawQuestions = Array.isArray(record.questions) ? record.questions : []
  const questions: PracticeQuestion[] = []
  for (const entry of rawQuestions) {
    if (questions.length >= MAX_QUESTIONS) break
    const question = normalizeQuestion(entry, questions.length)
    if (question) questions.push(question)
  }

  return { title, questions }
}

/**
 * 把一条原始题目读成卷面里的一题；读不出（不是对象 / 没有题干）返回 `null`。
 *
 * 🔴 **与写入侧的 `validatePracticeOutput()` 共用这**一个**函数**：
 * 一边是"模型给的能不能入库"、一边是"库里的能不能渲染"，
 * 两处各写一遍归一化就会出现"入库时能过、渲染时被丢掉"这种谁也说不清的分叉。
 */
export function normalizeQuestion(raw: unknown, index: number): PracticeQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const text = typeof record.text === 'string' ? record.text.trim().slice(0, MAX_QUESTION_CHARS) : ''
  if (text === '') return null

  const rawNumber = typeof record.number === 'string' ? record.number.trim() : ''
  const answer =
    typeof record.answer === 'string' && record.answer.trim() !== ''
      ? record.answer.trim().slice(0, MAX_ANSWER_CHARS)
      : null

  return {
    // 键**不信任行里的值**：按位置重算。行里的键要是被手改过（重复 / 乱序），
    // 讲解请求会打到错误的题上 —— 而"讲解配错题"比"讲解丢了"坏得多。
    key: questionKey(index),
    number: rawNumber === '' ? String(index + 1) : rawNumber,
    text,
    answer,
  }
}

/**
 * 读讲解载荷。
 *
 * 三种情况在界面上长得一样（什么都不画），但**语义不同**：还没生成 / 生成失败 / 模型说
 * "这题没什么可讲的"。所以这里只负责把形状读干净，画不画由调用方按 `status` 决定。
 */
export function readExplanation(raw: unknown): PracticeExplanation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { steps: [], concepts: [] }
  }
  const record = raw as Record<string, unknown>
  return {
    steps: normalizeStringList(record.steps, MAX_STEPS, MAX_STEP_CHARS),
    concepts: normalizeStringList(record.concepts, MAX_CONCEPTS, MAX_STEP_CHARS),
  }
}

/**
 * 读成"干净的非空字符串数组"：非字符串丢掉、去空白、丢空串、超长截断、超量截断。
 * 与 `validateExplanationOutput()` 共用（同上：一副归一化只该有一处）。
 */
export function normalizeStringList(raw: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= max) break
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    out.push(trimmed.slice(0, maxChars))
  }
  return out
}

/** 卷面统计。`missing` = 有题但没答案的题数 —— 界面必须如实报出来。 */
export function paperStats(paper: PracticePaper): {
  total: number
  answered: number
  missing: number
} {
  const total = paper.questions.length
  const answered = paper.questions.filter((question) => question.answer !== null).length
  return { total, answered, missing: total - answered }
}

// ---------------------------------------------------------------
// 路由
// ---------------------------------------------------------------

/** 自测卷页的查询参数。**`key` 是"用户换过答案文件"时的显式指定**。 */
export type PaperHrefParams = {
  courseId: string
  examFileId: string
  answerKeyFileId?: string | null
  /** 要就地生成讲解的那一题的键（`q3`）。 */
  explain?: string | null
}

/**
 * 自测卷页的地址。**唯一的拼 URL 的地方** —— 资料区入口、消息里的链接、
 * 「讲解」按钮三处都调它。三处各拼一遍的话，改一个参数名就会有两条链接悄悄失效
 * （而失效的表现是"点进去 404"或"点进去参数丢了"，`tsc` 全绿）。
 */
export function paperHref(params: PaperHrefParams): string {
  const search = new URLSearchParams()
  search.set('exam', params.examFileId)
  if (params.answerKeyFileId) search.set('key', params.answerKeyFileId)
  if (params.explain) search.set('explain', params.explain)
  return `/courses/${params.courseId}/practice-tests/new?${search.toString()}`
}

/**
 * 在卷面地址上追加「生成这一题讲解」的参数与锚点（`#q3`）。
 *
 * 收在这里而不是写在组件里：组件那边是**纯展示**的（连 URL 知识都不该有），
 * 而且这个拼接要跟 `paperHref()` 用同一套分隔符规则 —— 写歪了的表现是
 * 「点讲解没反应」（参数被吃进上一个值里），`tsc` 全绿。
 */
export function withExplain(href: string, questionKey: string): string {
  const separator = href.includes('?') ? '&' : '?'
  return `${href}${separator}explain=${encodeURIComponent(questionKey)}#${questionKey}`
}

/** 「讲解这道题」的地址：同一个页面 + `explain` 参数 + 锚点（生成完直接滚到那一题）。 */
export function explainHref(params: PaperHrefParams & { explain: string }): string {
  return withExplain(paperHref(params), params.explain)
}

/**
 * 卷面里每一题的锚点 id。
 * 生成讲解是**整页重渲染**（本卡刻意不做客户端状态机，见页面的文件头），
 * 没有锚点的话用户点完「讲解」会被丢回页面顶部，还得自己滚回第 7 题 ——
 * 那就等于每看一题讲解都要重新找一次位置。
 */
export function questionAnchor(key: string): string {
  return key
}
