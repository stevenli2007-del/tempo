/**
 * 大纲漂移的 prompt、JSON Schema 与输出校验（P0-3-20）。
 *
 * ### 输入是什么
 * ① 新抽取出来的 syllabus **正文**（用户打开消息栏时才去下载 + 抽取，ADR-026 的按需路径）；
 * ② **当前已确认的**考试列表（带 `exam_dates.id`）与成绩构成 —— 差异的另一半。
 *
 * ### 输出是什么
 * 「新增 X / 变动 Y」的结构化版本。**变动必须回指一个已有的 `exam_dates.id`** ——
 * 这是本卡与"再解析一次 syllabus"的本质区别：重解析是全量重建（会冲掉用户改过的东西，
 * 那是 `lib/parse/persist.ts` 的语义），而漂移检测是**增量提案**，必须说清"改的是哪一条"。
 *
 * ### 🔴 三条不能破的纪律（都在下面的 prompt 里写死了）
 * 1. **没有原文依据的条目一律不许产出**（`sourceExcerpt` 必填）——
 *    ADR-021 解禁"从文本产出考试"的前提就是"必须可核对"。
 * 2. **日期没写就不填（null → TBD）、占比没写就 null（不是 0）** —— ADR-004 的老规矩。
 * 3. **对 JSON Schema 的必填字段，只能说"内容为空"，绝不能说"可以不要这个字段"**。
 *    P0-3-19b 实测：prompt 里加一句「材料里可能没有公式：那种情况返回空数组」，
 *    模型就**整个省略了 `formulas` 键** → `schema_mismatch`，同一版 prompt 下 3 个文件全挂。
 *    `空数组合法` ≠ `键可以缺席`。本文件的 schema 与 prompt 都按这条写。
 *
 * ### 为什么独立成纯模块
 * `scripts/probe-syllabus-drift.ts` 要拿**同一份** prompt 去打真模型（不然"线上跑 A 版、
 * 探针验 B 版"），`scripts/regress-syllabus-drift.ts` 要直接断言校验器。
 * 任何 `next/headers` 之类的服务端依赖拖进来，两者都跑不起来。
 */

import type { JSONSchema, LLMMessage } from '@/lib/llm'
import {
  EXCERPT_MAX,
  validateExamInput,
  validateGradeComponentInput,
} from '@/lib/course-update/normalize'
import type { ParsedExam, ParsedGradeComponent } from '@/lib/course-update/normalize'

/**
 * prompt 版本号。**换 prompt 或换 schema 都要升** ——
 * `llm_runs.prompt_version` 是将来按版本对比准确率的唯一依据（ADR-003 复审用）。
 */
export const SYLLABUS_DRIFT_PROMPT_VERSION = 'v1'

/** 写进 `llm_runs.purpose`（那列没有 CHECK，新用途直接加字面量）。 */
export const SYLLABUS_DRIFT_PURPOSE = 'syllabus_drift'

/**
 * 喂给模型的正文上限（字符）。
 *
 * 实测 Chem 1A 的 syllabus 是 13,947 字符 —— 远在预算内，
 * 这个上限是兜住"某些课的 syllabus 是几百页的合订本"。截断必须**如实上报**
 * （`buildDriftInput` 返回 `truncated`），否则用户会以为"没列出来的就是没变"。
 */
export const MAX_SOURCE_CHARS = 30_000

/** 各类条目的上限。超出的**裁掉并计数**（`dropped`），静默 `slice` 是降级。 */
export const MAX_ADDED_EXAMS = 10
export const MAX_CHANGED_EXAMS = 20
export const MAX_ADDED_COMPONENTS = 10
export const MAX_NOTES = 5

/** 一句「考试长什么样」的展示文案。**唯一实现**：`before` 与 `after` 必须同一种写法。 */
export function formatExamLine(
  examName: string,
  examDate: string | null,
  examTime: string | null,
): string {
  const parts = [examName]
  parts.push(examDate === null ? '日期待定' : examDate)
  if (examTime !== null && examTime !== '') parts.push(examTime)
  return parts.join(' · ')
}

/** 当前已确认的一条考试（服务端读出来的、进 prompt 的那一份）。 */
export type CurrentExam = {
  id: string
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
}

export type DriftPromptInput = {
  courseName: string
  fileName: string
  currentExams: CurrentExam[]
  currentComponents: { name: string; weightPercent: number | null }[]
  text: string
}

/** 已确认的考试列表 → prompt 里的几行（带 id，模型要回指它）。 */
function formatCurrentExams(exams: CurrentExam[]): string {
  if (exams.length === 0) {
    return '（这门课目前没有已确认的考试记录 —— 那就全部按"新增"产出，`examsChanged` 返回空数组）'
  }
  return exams
    .map((exam) => {
      const parts = [exam.examName, exam.examDate ?? '日期待定']
      if (exam.examTime) parts.push(exam.examTime)
      if (exam.location) parts.push(exam.location)
      return `- id=${exam.id} | ${parts.join(' | ')}`
    })
    .join('\n')
}

function formatCurrentComponents(components: { name: string; weightPercent: number | null }[]): string {
  if (components.length === 0) return '（这门课目前没有已确认的成绩构成记录）'
  return components
    .map((item) =>
      item.weightPercent === null ? `- ${item.name} | 未标占比` : `- ${item.name} | ${item.weightPercent}%`,
    )
    .join('\n')
}

export const SYLLABUS_DRIFT_SYSTEM_PROMPT = `你是 Tempo 的「课程大纲变更核对器」。用户已经有一份确认过的课程记录（下面是"当前已确认"的考试与成绩构成），现在老师更新了 Canvas 上的 syllabus 文件。请**只找出真正的差异**，不要重新抄一遍整份大纲。

规则：
1. **只找差异**。原文与当前记录一致的条目，一个字都不要产出 —— 产出一条"没变的"会让用户白点一次确认。
2. examsAdded：原文里**新出现**的考试 / 测验 / 期中 / 期末（当前记录里没有对应的那一条）。名称保留原文写法。
3. examsChanged：原文里**改了**的考试 —— 必须是"当前已确认"列表里的某一条，且日期 / 时间 / 地点确实与记录不同。**examsChanged 的每一项都必须带 examDateId，值只能从上面"当前已确认"列表里逐字复制**，不许自己编 id、不许用序号。只有名称写法有细微差别（如 "Midterm" vs "Midterm 1"）而日期时间全都相同 → **不算变动**，放进 notes。
4. gradeComponentsAdded：原文里**新出现**的成绩构成项。原文说 "Each Midterm 30%" 指两次期中 → 拆成两条。只有当前记录里已经有同名同占比的才算"没变"，不产出。
5. 日期只填原文真的写了的那个（按 M/D，如 9/4）；原文没写日期就填 null（系统会记成待定），**严禁编造日期**。examTime / location 同理，没写就 null。
6. weightPercent 只填原文写出的百分数（0-100，不含百分号）；原文没写占比就填 null，**绝不能用 0 代替**（0 的语义是"不占分"，与"没写"完全相反）。
7. **每一条 examsAdded / examsChanged / gradeComponentsAdded 都必须带 sourceExcerpt**：支持这一条的原文逐字摘录（≤200 字符）。**找不到原文依据就不要产出这一条**。
8. notes：其他变化的一句话摘要（评分细则、办公时间、课程安排、迟到政策…）。这些**不会写进系统**，只显示给用户看。没有就返回空数组。
9. uncertain：如果你觉得原文与记录对不上、或者这份原文本身残缺/读不通（例如像扫描件），置 true；有把握就 false。
10. 🔴 **下面这五个键（examsAdded / examsChanged / gradeComponentsAdded / notes / uncertain）在任何情况下都必须全部出现**。某类没有内容时用空数组（或 false），**不要省略这个键**。
11. 输出必须严格符合 JSON schema，不要输出任何解释性文字。`

export function buildDriftMessages(input: DriftPromptInput): LLMMessage[] {
  const context = `课程：${input.courseName}
syllabus 文件：${input.fileName}

【当前已确认的考试】
${formatCurrentExams(input.currentExams)}

【当前已确认的成绩构成】
${formatCurrentComponents(input.currentComponents)}

【Canvas 上这份 syllabus 的正文】
${input.text}`

  return [
    { role: 'system', content: SYLLABUS_DRIFT_SYSTEM_PROMPT },
    { role: 'user', content: context },
  ]
}

/**
 * 模型输出的 JSON Schema。
 *
 * ⚠️ 与 `validateDriftOutput()` **必须同步改**：schema 要求而校验器不认 = "解析成功但一条都写不进去"；
 * 反过来则是模型永远给不出合格输出。回归脚本用 `regress:syllabus-drift` 钉着这条对应关系。
 */
export function driftSchema(): JSONSchema {
  const examProps = {
    examName: { type: 'string', description: '考试名称，保留原文写法，如 Quiz 1、Midterm 2' },
    examDate: {
      type: ['string', 'null'],
      description: '考试日期 M/D 或 YYYY-MM-DD。**只写原文真的写了的日期**，没写就 null（会记成 TBD）',
    },
    examTime: { type: ['string', 'null'], description: '考试时刻，保留原文写法（如 7-9pm）。没写就 null' },
    location: { type: ['string', 'null'], description: '考场地点。没写就 null' },
    sourceExcerpt: {
      type: 'string',
      description: `**必填**。支持这一条的原文逐字摘录（≤${EXCERPT_MAX} 字符）。找不到原文依据就别产出这一条`,
    },
  } as const

  return {
    type: 'object',
    properties: {
      examsAdded: {
        type: 'array',
        description: '原文里**新出现**的考试。没有就返回空数组（这个键不能省略）',
        items: {
          type: 'object',
          properties: examProps,
          required: ['examName', 'examDate', 'examTime', 'location', 'sourceExcerpt'],
        },
      },
      examsChanged: {
        type: 'array',
        description: '原文里**改了**的考试（必须是当前已确认列表里的某一条）。没有就返回空数组',
        items: {
          type: 'object',
          properties: {
            examDateId: {
              type: 'string',
              description:
                '**必填**。被改的那条考试在"当前已确认"列表里的 id，逐字复制，不许自己编',
            },
            ...examProps,
          },
          required: ['examDateId', 'examName', 'examDate', 'examTime', 'location', 'sourceExcerpt'],
        },
      },
      gradeComponentsAdded: {
        type: 'array',
        description: '原文里新出现的成绩构成项。没有就返回空数组',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '构成项名称，如 Midterm 1、Final、Homework' },
            weightPercent: {
              type: ['number', 'null'],
              description: '占比百分数（0-100，不含百分号）。原文没写就 null，**不要用 0 代替**',
            },
            notes: { type: ['string', 'null'], description: '附加规则（如"取最好的 8 次"）。没有就 null' },
            sourceExcerpt: { type: 'string', description: '**必填**。支持这一条的原文逐字摘录' },
          },
          required: ['name', 'weightPercent', 'notes', 'sourceExcerpt'],
        },
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: '其他变化的一句话摘要（不写进系统，只显示）。没有就返回空数组',
      },
      uncertain: {
        type: 'boolean',
        description: '原文与记录对不上、或原文本身残缺读不通（如扫描件）时为 true',
      },
    },
    required: ['examsAdded', 'examsChanged', 'gradeComponentsAdded', 'notes', 'uncertain'],
  } as const
}

// ---------------------------------------------------------------
// 校验
// ---------------------------------------------------------------

/** 模型原始输出（未经校验）。 */
export type RawDriftOutput = {
  examsAdded?: unknown
  examsChanged?: unknown
  gradeComponentsAdded?: unknown
  notes?: unknown
  uncertain?: unknown
}

/** 校验通过的变动条目（`before` 由服务端算，不是模型说的）。 */
export type DriftChange = {
  id: string
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
  sourceExcerpt: string
  /** 旧值 / 新值的展示文案（同一份 `formatExamLine` 产出，两句话必然可比）。 */
  before: string
  after: string
}

/**
 * 带原文依据的条目：`sourceExcerpt` **必非空**。
 *
 * 为什么要在类型上钉死而不是靠 `ParsedExam`：`ParsedExam.sourceExcerpt` 的类型是
 * `string | null`（它服务于"校验前"的形状），而落到 `MessageDriftAddedExam` 上的
 * 是**要写进库**的那一份 —— ADR-021 解禁 exam 产出的前提就是"必须可核对"。
 * 用类型把这道闸表达出来，就不会有人图省事把 `null` 一路传进 payload。
 * （`validateExamInput` 本身已经拒空；成绩构成那条 `validateGradeComponentInput`
 * 只校验了类型没校验非空，所以两者的挑拣统一放在 `validateDriftOutput` 里做一次。）
 */
export type DriftAddedExam = ParsedExam & { sourceExcerpt: string }
export type DriftAddedComponent = ParsedGradeComponent & { sourceExcerpt: string }

export type DriftDraft = {
  addedExams: DriftAddedExam[]
  changes: DriftChange[]
  addedComponents: DriftAddedComponent[]
  notes: string[]
  uncertain: boolean
}

export type DriftValidation =
  | {
      ok: true
      draft: DriftDraft
      /** 被跳过的条目原因（人话，回执里逐条说清 —— 明确说出来就不算静默失败）。 */
      skipped: string[]
      /** 因超出上限被裁掉的条数。>0 是 prompt 该收紧的信号，不是"输出正常"。 */
      dropped: number
    }
  | { ok: false; message: string }

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 取非空的原文摘录；空串 / 全空白 / null 一律返回 `null`（→ 调用方跳过该条）。
 *
 * 🔴 与 prompt 规则 7 是**同一条纪律的两个执行面**：prompt 说"找不到原文依据就不要产出"，
 * 这里负责"模型没听"的时候把它挡下来。做成一个共享函数而不是各处写 `!!excerpt.trim()`，
 * 是为了让"什么算有依据"只有一个答案（CodingRules §10.1 第 21 条）。
 */
function requireExcerpt(value: { sourceExcerpt: string | null }): string | null {
  const excerpt = value.sourceExcerpt
  if (excerpt === null || excerpt.trim() === '') return null
  return excerpt
}

/**
 * 校验模型输出。
 *
 * ### 与对话框（`validateApplyBody`）**刻意不同**：这里跳过坏条目、留下好的
 * 对话框那条路是"单条非法 = 整批拒绝"，因为用户正看着预览、可以改；
 * 而这条路用户**没在编辑** —— 整批拒绝等于让他对着一句"第 3 条考试缺少原文摘录"干瞪眼。
 * 所以跳过并在回执里逐条说明；**全都不合格时才返回失败**。
 *
 * @param allowedExamIds 该课程当前全部 `exam_dates.id` —— 变动只能命中它们
 *   （模型编一个 id 出来必须在这里被挡住，否则会去改别的课的、甚至不存在的行）。
 */
export function validateDriftOutput(raw: unknown, allowedExamIds: string[]): DriftValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '模型输出不是对象' }
  }
  const record = raw as RawDriftOutput

  const skipped: string[] = []
  let dropped = 0

  // ---------- 新增考试 ----------
  const rawAdded = asArray(record.examsAdded)
  if (rawAdded.length > MAX_ADDED_EXAMS) dropped += rawAdded.length - MAX_ADDED_EXAMS
  const addedExams: DriftAddedExam[] = []
  for (const item of rawAdded.slice(0, MAX_ADDED_EXAMS)) {
    const parsed = validateExamInput(item)
    if (!parsed.ok) {
      skipped.push(parsed.message)
      continue
    }
    const excerpt = requireExcerpt(parsed.value)
    if (excerpt === null) {
      skipped.push(`「${parsed.value.examName}」没有原文摘录，无法核对，已跳过`)
      continue
    }
    addedExams.push({ ...parsed.value, sourceExcerpt: excerpt })
  }

  // ---------- 变动 ----------
  const allowed = new Set(allowedExamIds)
  const rawChanged = asArray(record.examsChanged)
  if (rawChanged.length > MAX_CHANGED_EXAMS) dropped += rawChanged.length - MAX_CHANGED_EXAMS
  const changes: DriftChange[] = []
  for (const item of rawChanged.slice(0, MAX_CHANGED_EXAMS)) {
    const parsed = validateExamInput(item)
    if (!parsed.ok) {
      skipped.push(parsed.message)
      continue
    }
    const id = typeof (item as { examDateId?: unknown }).examDateId === 'string'
      ? ((item as { examDateId: string }).examDateId).trim()
      : ''
    // 🔴 只认这门课真实存在的 exam_dates.id（模型编 id 是必须挡住的一类幻觉）。
    if (id === '' || !allowed.has(id)) {
      skipped.push(`「${parsed.value.examName}」的变动没有指向这门课已有的考试记录，已跳过`)
      continue
    }
    changes.push({
      id,
      examName: parsed.value.examName,
      examDate: parsed.value.examDate,
      examTime: parsed.value.examTime,
      location: parsed.value.location,
      sourceExcerpt: parsed.value.sourceExcerpt ?? '',
      // `before` 只在这里算：取值来自服务端已知的旧值（调用方比对后覆盖），
      // 保证界面上那句「10/20 → 10/27」两边同源。
      before: '',
      after: formatExamLine(parsed.value.examName, parsed.value.examDate, parsed.value.examTime),
    })
  }

  // ---------- 新增成绩构成 ----------
  const rawComponents = asArray(record.gradeComponentsAdded)
  if (rawComponents.length > MAX_ADDED_COMPONENTS) {
    dropped += rawComponents.length - MAX_ADDED_COMPONENTS
  }
  const addedComponents: DriftAddedComponent[] = []
  for (const item of rawComponents.slice(0, MAX_ADDED_COMPONENTS)) {
    const parsed = validateGradeComponentInput(item)
    if (!parsed.ok) {
      skipped.push(parsed.message)
      continue
    }
    // ⚠️ 成绩构成这条校验器**只查类型不查非空**（`validateGradeComponentInput` 的历史行为），
    // 所以空摘录必须在这里挡 —— 否则 `sourceExcerpt: ''` 会一路写进 payload。
    const excerpt = requireExcerpt(parsed.value)
    if (excerpt === null) {
      skipped.push(`「${parsed.value.name}」没有原文摘录，无法核对，已跳过`)
      continue
    }
    addedComponents.push({ ...parsed.value, sourceExcerpt: excerpt })
  }

  // ---------- 描述性变化（不写库） ----------
  const notes: string[] = []
  for (const item of asArray(record.notes)) {
    if (notes.length >= MAX_NOTES) break
    if (typeof item === 'string' && item.trim() !== '') notes.push(item.trim().slice(0, 300))
  }

  return {
    ok: true,
    draft: {
      addedExams,
      changes,
      addedComponents,
      notes,
      // `!== false`：字段缺失（老 prompt / 模型漏键）时**按不确定处理**更安全 ——
      // 宁可让用户多点一次课程页，也不要让一份读不准的差异被一键接受。
      uncertain: record.uncertain !== false,
    },
    skipped,
    dropped,
  }
}

/**
 * 把服务端读到的旧值补进变动条目（`before`）。
 *
 * 🔴 **必须用库里的旧值**，不能用模型转述的 —— 模型可能把旧值也写错，
 * 那样界面上「10/20 → 10/27」两个数字都不可信，用户就失去了唯一的核对依据。
 * 找不到对应行的变动**整条丢掉**（并发场景：用户在我们算 diff 时手动删了那条）。
 */
export function attachBeforeValues(
  changes: DriftChange[],
  currentExams: CurrentExam[],
): { changes: DriftChange[]; missing: string[] } {
  const byId = new Map(currentExams.map((exam) => [exam.id, exam]))
  const result: DriftChange[] = []
  const missing: string[] = []

  for (const change of changes) {
    const existing = byId.get(change.id)
    if (!existing) {
      missing.push(change.examName)
      continue
    }
    const before = formatExamLine(existing.examName, existing.examDate, existing.examTime)
    // 算完发现"根本没什么变化"（模型自己绕了一圈）→ 丢掉，别让用户点一次空确认。
    if (before === change.after) continue
    result.push({ ...change, before })
  }
  return { changes: result, missing }
}
