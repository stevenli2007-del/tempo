/**
 * 对话框编排产物的**纯逻辑层**（P0-3-24）：校验 + 日期归一化。
 *
 * ### 为什么必须独立成纯函数文件
 * 与 `lib/tasks/manual.ts` 同一条理由：
 * 1. 这里的判定是「哪些输入能进 `exam_dates` / `grade_components`」的唯一口径 ——
 *    路由层只做编排，不做判断；
 * 2. `scripts/regress-course-updates.ts` 可以直接 import 断言，
 *    不用数据库、不用网络、不用 LLM（改 prompt 之后回归能立刻跑）。
 *
 * ### 🔴 权威源纪律（ADR-004）
 * 本文件是**除 `lib/parse/persist.ts`（syllabus 解析）与板块保存端点（P0-1-5b）之外**
 * 唯一允许产出行写入 `exam_dates` 的形状。产出的行一律 `source = 'manual'`
 * （用户在对话框里说出来的，不是 syllabus 抽的、也不是 Canvas 同步的），
 * 且 `is_confirmed = true`（**用户点确认那一刻就是确认**，ADR-015）。
 *
 * 注意：`source = 'manual'` 而不是 `'syllabus'` 还有一层实际意义 ——
 * `lib/parse/persist.ts` 重解析只删 `source = 'syllabus'` 的行，
 * 用户从对话框编排进去的考试不会被一次重解析冲掉。
 */

import type { JSONSchema } from '@/lib/llm'

// ---------------------------------------------------------------
// 形状
// ---------------------------------------------------------------

/** 一条解析出来的考试（`exam_dates` 的候选行）。 */
export type ParsedExam = {
  examName: string
  /** `YYYY-MM-DD`；null = 原文没给确切日期 → 落库为 TBD（**禁止编造**）。 */
  examDate: string | null
  examTime: string | null
  location: string | null
  /** 原文逐字摘录。**没有摘录的考试一律不收**（见 `validateExamInput`）。 */
  sourceExcerpt: string | null
}

/** 一条解析出来的成绩构成（`grade_components` 的候选行）。 */
export type ParsedGradeComponent = {
  name: string
  /** 0-100；null = 原文没写占比（不等于 0）。 */
  weightPercent: number | null
  notes: string | null
  sourceExcerpt: string | null
}

/** 确认写入的请求体（校验后的形状）。 */
export type CourseUpdateApplyInput = {
  courseId: string
  exams: ParsedExam[]
  gradeComponents: ParsedGradeComponent[]
}

// ---------------------------------------------------------------
// 常量（与 DB 列长约束一致，见 lib/exam-dates.ts / lib/grade-components.ts）
// ---------------------------------------------------------------

const MAX_EXAM_NAME = 200
const MAX_EXAM_TIME = 100
const MAX_EXAM_LOCATION = 500
const MAX_GC_NAME = 200
const MAX_GC_NOTES = 2000
/** 摘录上限：与 syllabus 解析侧一致（200 字符足够核对，多了反而没人看）。 */
const MAX_EXCERPT = 200

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const EXCERPT_MAX = MAX_EXCERPT

// ---------------------------------------------------------------
// 日期归一化
// ---------------------------------------------------------------

/**
 * `M/D` / `M/D/YYYY` / `YYYY-MM-DD` → `YYYY-MM-DD`。
 *
 * 与 `lib/tasks/manual.ts` 的 `normalizeDueDate` **同一套学年推断规则**
 * （月 ≥ 8 → 当年 Fall，月 ≤ 7 → 次年 Spring），两处不一致就会出现
 * 「作业显示在 2026、同一门课的考试显示在 2027」这种最难查的错。
 *
 * 差异只有一处：这里返回**纯日历日**（`exam_dates.exam_date` 是 `date` 列，
 * 没有时区概念），不拼 `T23:59:59Z` —— 时刻由 `exam_time` 原文承载。
 *
 * @param now 推断基准；测试注入固定日期保证确定性。
 */
export function normalizeExamDate(
  input: unknown,
  now: Date = new Date(),
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (input === null || input === undefined || input === '') {
    return { ok: true, value: null }
  }
  if (typeof input !== 'string') {
    return { ok: false, message: 'examDate 必须是日期字符串或 null' }
  }
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }

  const check = (year: number, month: number, day: number, raw: string) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { ok: false as const, message: `examDate 不是合法日期：${raw}` }
    }
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    // 回环校验：2/30 这类"格式对但日历上不存在"的日期必须挡掉，否则会静默写进库。
    const probe = new Date(`${iso}T00:00:00Z`)
    if (
      Number.isNaN(probe.getTime()) ||
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() + 1 !== month ||
      probe.getUTCDate() !== day
    ) {
      return { ok: false as const, message: `examDate 不是合法日期：${raw}` }
    }
    return { ok: true as const, value: iso }
  }

  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (dateOnly) {
    return check(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), trimmed)
  }

  const md = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(trimmed)
  if (md) {
    const month = Number(md[1])
    const day = Number(md[2])
    const year = md[3]
      ? md[3].length === 2
        ? 2000 + Number(md[3])
        : Number(md[3])
      : month >= 8
        ? now.getFullYear()
        : now.getFullYear() + 1
    return check(year, month, day, trimmed)
  }

  return {
    ok: false,
    message: `examDate 格式无法识别：${trimmed}（请用 YYYY-MM-DD 或 M/D）`,
  }
}

// ---------------------------------------------------------------
// 校验
// ---------------------------------------------------------------

/**
 * 失败分支。**必须带 `ok: false` 字面量** —— 只有 `{ message }` 的话 TS 无法用 `.ok`
 * 收窄联合类型，调用点会全部报 "Property 'ok' does not exist"（第一次写就踩了）。
 * 与 `lib/api/input.ts` 的 `ValidationResult<T>` 同形状。
 */
type Invalid = { ok: false; message: string }

/** 可空文本：类型不对 → Invalid；超长 → 截断（不拒，摘录/备注长一点不影响正确性）。 */
function text(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: `${field} 必须是字符串或 null` }
  return { ok: true, value: value.trim().slice(0, max) }
}

function requireString(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: `${field} 不能为空` }
  }
  return { ok: true, value: value.trim().slice(0, max) }
}

/**
 * 校验单条考试。
 *
 * 🔴 **没有 `sourceExcerpt` 的考试一律不收**（返回错误，不是静默留空）：
 * 对话框输入天然没有可核对锚点，ADR-021 解禁 exam 产出的**前提**就是"必须带摘录" ——
 * 没有摘录的考试日期与 ADR-004 防幻觉的初衷直接冲突，等于把禁令绕过去了。
 */
export function validateExamInput(raw: unknown): { ok: true; value: ParsedExam } | Invalid {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '考试条目必须是对象' }
  }
  const r = raw as Record<string, unknown>

  const name = requireString(r.examName, 'examName', MAX_EXAM_NAME)
  if (!name.ok) return { ok: false, message: name.message }

  const date = normalizeExamDate(r.examDate)
  if (!date.ok) return { ok: false, message: date.message }

  const time = text(r.examTime, 'examTime', MAX_EXAM_TIME)
  if (!time.ok) return { ok: false, message: time.message }

  const location = text(r.location, 'location', MAX_EXAM_LOCATION)
  if (!location.ok) return { ok: false, message: location.message }

  const excerpt = text(r.sourceExcerpt, 'sourceExcerpt', MAX_EXCERPT)
  if (!excerpt.ok) return { ok: false, message: excerpt.message }
  if (!excerpt.value) {
    return { ok: false, message: `「${name.value}」缺少原文摘录（sourceExcerpt），无法核对，已跳过` }
  }

  return {
    ok: true,
    value: {
      examName: name.value,
      examDate: date.value,
      examTime: time.value,
      location: location.value,
      sourceExcerpt: excerpt.value,
    },
  }
}

/** 校验单条成绩构成。占比必须是 0-100 的数字或 null（**不用 0 代替"没写"**）。 */
export function validateGradeComponentInput(
  raw: unknown,
): { ok: true; value: ParsedGradeComponent } | Invalid {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '成绩构成条目必须是对象' }
  }
  const r = raw as Record<string, unknown>

  const name = requireString(r.name, 'name', MAX_GC_NAME)
  if (!name.ok) return { ok: false, message: name.message }

  let weightPercent: number | null = null
  if (r.weightPercent !== null && r.weightPercent !== undefined) {
    const raw2 = typeof r.weightPercent === 'string' ? Number(r.weightPercent) : r.weightPercent
    if (typeof raw2 !== 'number' || !Number.isFinite(raw2)) {
      return { ok: false, message: `「${name.value}」的 weightPercent 必须是数字或 null` }
    }
    if (raw2 < 0 || raw2 > 100) {
      return { ok: false, message: `「${name.value}」的 weightPercent 必须在 0-100 之间` }
    }
    weightPercent = raw2
  }

  const notes = text(r.notes, 'notes', MAX_GC_NOTES)
  if (!notes.ok) return { ok: false, message: notes.message }

  const excerpt = text(r.sourceExcerpt, 'sourceExcerpt', MAX_EXCERPT)
  if (!excerpt.ok) return { ok: false, message: excerpt.message }

  return {
    ok: true,
    value: { name: name.value, weightPercent, notes: notes.value, sourceExcerpt: excerpt.value },
  }
}

/**
 * 校验确认写入的请求体。
 *
 * **单条非法 = 整批拒绝**，不做"跳过坏的写好的"：
 * 用户看到的是"确认 6 条考试"，结果只写了 4 条、另外 2 条无声消失 ——
 * 那是比报错严重得多的静默失败（ADR-016 R3）。宁可让他改完重发。
 */
export function validateApplyBody(
  body: unknown,
): { ok: true; value: CourseUpdateApplyInput } | Invalid {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const r = body as Record<string, unknown>

  if (typeof r.courseId !== 'string' || !UUID_PATTERN.test(r.courseId)) {
    return { ok: false, message: 'courseId 格式不正确' }
  }

  const rawExams = r.exams === undefined || r.exams === null ? [] : r.exams
  const rawComponents = r.gradeComponents === undefined || r.gradeComponents === null ? [] : r.gradeComponents
  if (!Array.isArray(rawExams)) return { ok: false, message: 'exams 必须是数组' }
  if (!Array.isArray(rawComponents)) return { ok: false, message: 'gradeComponents 必须是数组' }
  if (rawExams.length === 0 && rawComponents.length === 0) {
    return { ok: false, message: '没有要写入的内容（exams / gradeComponents 都为空）' }
  }

  const exams: ParsedExam[] = []
  for (const [index, raw] of rawExams.entries()) {
    const parsed = validateExamInput(raw)
    if (!parsed.ok) return { ok: false, message: `第 ${index + 1} 条考试：${parsed.message}` }
    exams.push(parsed.value)
  }

  const gradeComponents: ParsedGradeComponent[] = []
  for (const [index, raw] of rawComponents.entries()) {
    const parsed = validateGradeComponentInput(raw)
    if (!parsed.ok) {
      return { ok: false, message: `第 ${index + 1} 条成绩构成：${parsed.message}` }
    }
    gradeComponents.push(parsed.value)
  }

  return { ok: true, value: { courseId: r.courseId, exams, gradeComponents } }
}

// ---------------------------------------------------------------
// 落库行（snake_case 只出现在本文件，与 lib/exam-dates.ts 的分工见下）
// ---------------------------------------------------------------

/**
 * ⚠️ 为什么这里又写了一遍 snake_case，而不是直接用 `toExamDateSaveInsert`：
 * 那个函数属于 **PUT 全量替换**语义（不带 id = 新增，`source='manual'`），
 * 本文件是 **追加**语义。两者的 `is_confirmed` / `source_excerpt` 取值完全不同
 * （保存端点置 `source_excerpt = null`，因为用户手填的行没有原文可引；
 * 对话编排**恰恰有原文**，摘录是它唯一的可核对锚点）。
 * 混用一个函数会让"来源与摘录"这种溯源字段随调用点漂移。
 */
export function toExamInsertRow(
  item: ParsedExam,
  courseId: string,
): Record<string, unknown> {
  return {
    course_id: courseId,
    exam_name: item.examName,
    exam_date: item.examDate,
    exam_time: item.examTime,
    location: item.location,
    // 与 lib/exam-dates.ts 的 deriveStatus 同一条规则：有日期 = confirmed，否则 tbd。
    status: item.examDate !== null ? 'confirmed' : 'tbd',
    is_confirmed: true,
    source: 'manual',
    source_excerpt: item.sourceExcerpt,
  }
}

export function toGradeComponentInsertRow(
  item: ParsedGradeComponent,
  courseId: string,
): Record<string, unknown> {
  return {
    course_id: courseId,
    name: item.name,
    weight_percent: item.weightPercent,
    notes: item.notes,
    is_confirmed: true,
    source: 'manual',
    source_excerpt: item.sourceExcerpt,
  }
}

// ---------------------------------------------------------------
// LLM 解析用的 JSON Schema（parse 端点与回归共用同一份，避免两处漂移）
// ---------------------------------------------------------------

/**
 * 对话框解析的 schema（P0-3-24 解禁 exam 之后的版本）。
 *
 * 放在这里而不是端点文件里，是为了让 `scripts/regress-course-updates.ts`
 * 能断言「schema 要求的字段 ⊆ 校验器接受的字段」——
 * 这两个一旦漂移，模型会产出校验器拒收的值，表现为"解析成功但一条都写不进去"。
 */
export const COURSE_UPDATE_PARSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: '从文本中识别出的可添加 / 可更新的任务（作业 / 阅读 / 其他待办）',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简洁的任务标题，去掉营销腔与废话' },
          taskType: {
            type: 'string',
            enum: ['assignment', 'reading', 'other'],
            description: 'assignment=作业/项目/论文；reading=阅读；other=其他待办。考试放 exams，不要放这里',
          },
          dueDate: {
            type: ['string', 'null'],
            description: '截止日期。文字给了具体月日（如 9/20、12月10日、Oct 5）就按 M/D 返回；完全没有任何日期信息才填 null；不要自补 4 位年份（年份由系统按当前学年推断）',
          },
          notes: {
            type: ['string', 'null'],
            description: '补充说明（提交方式 / 字数 / 平台等），可空',
          },
        },
        required: ['title', 'taskType', 'dueDate', 'notes'],
      },
    },
    exams: {
      type: 'array',
      description:
        '文本里明确写出的**考试 / 测验 / 期中 / 期末安排**（如 Quiz 1、Midterm、Final）。日常作业不算。没有就返回空数组',
      items: {
        type: 'object',
        properties: {
          examName: { type: 'string', description: '考试名称，保留原文写法，如 Quiz 1、Midterm 2' },
          examDate: {
            type: ['string', 'null'],
            description: '考试日期 M/D 或 YYYY-MM-DD。**只写文本里真的写了的日期**，没写就填 null（会记成 TBD）',
          },
          examTime: {
            type: ['string', 'null'],
            description: '考试时刻，保留原文写法（如 7-9pm）。没写就 null',
          },
          location: {
            type: ['string', 'null'],
            description: '考场地点。没写就 null',
          },
          sourceExcerpt: {
            type: 'string',
            description:
              '**必填**。支持这条考试的原文逐字摘录（≤200 字符）。找不到原文依据就别产出这条考试',
          },
        },
        required: ['examName', 'examDate', 'examTime', 'location', 'sourceExcerpt'],
      },
    },
    gradeComponents: {
      type: 'array',
      description:
        '文本里写出的**成绩构成**（各项占总评的百分比）。如 "Each Midterm 30%" 出现两次就拆成两条。没有就返回空数组',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '构成项名称，如 Midterm 1、Final、Homework、Quiz' },
          weightPercent: {
            type: ['number', 'null'],
            description: '占比百分数（0-100，不含百分号）。原文没写占比就填 null，**不要用 0 代替**',
          },
          notes: {
            type: ['string', 'null'],
            description: '附加规则（如"取最好的 10 次中的 8 次"）。没有就 null',
          },
          sourceExcerpt: {
            type: 'string',
            description: '**必填**。支持这条构成的原文逐字摘录（≤200 字符）',
          },
        },
        required: ['name', 'weightPercent', 'notes', 'sourceExcerpt'],
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: '无法归到上面三类的事项：歧义、与课程无关的内容等',
    },
  },
  required: ['tasks', 'exams', 'gradeComponents', 'warnings'],
} as const
