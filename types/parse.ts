/**
 * Syllabus 五板块抽取结果（P0-1-4）。
 *
 * 与 `API-Contract.md` 的对外契约一致：**一律 camelCase**。
 * 五张表的 snake_case 列名只允许出现在各自 `lib/*.ts` 的映射点（P0-1-5 落库时再建）。
 *
 * 字段设计与五张表一一对应（`supabase/migrations/20260902003000_initial_schema.sql` 3.4~3.8）：
 *
 * | 板块 | 目标表 |
 * |---|---|
 * | Grade Composition | `grade_components` |
 * | Course Outline | `course_outline_items` |
 * | Test Dates | `exam_dates` |
 * | Office Hours | `office_hours` |
 * | Submission Policy | `submission_policies` |
 *
 * ⚠️ **每个条目都带 `sourceExcerpt`**：这是 P0-1-4 抗幻觉的核心设计，三层作用 ——
 *   1. 逼模型为每条结论找原文依据，编不出来的就填 null；
 *   2. 前端可以让用户鼠标悬停核对"这句话到底是哪来的"；
 *   3. 直接对应五张表都有的 `source_excerpt` 列，落库零转换。
 */

// ---------------------------------------------------------------
// 各板块的条目
// ---------------------------------------------------------------

export type GradeComponent = {
  name: string
  /** 占比百分数（0-100）。原文没写占比时为 `null` —— **不要用 0 代替，0 是"占 0 分"的意思**。 */
  weightPercent: number | null
  /** 附加说明，如"取最好的 10 次中的 8 次"。 */
  notes: string | null
  sourceExcerpt: string | null
}

export type CourseOutlineItem = {
  /** 从 1 开始的序号，对应表的 `order_index`。 */
  orderIndex: number
  /** 周次/章节标签，如 `Week 3`、`Ch. 5`。原文没分周次时为 null。 */
  weekLabel: string | null
  topic: string
  sourceExcerpt: string | null
}

/**
 * 考试时间存的是**文本**不是时间戳：syllabus 里常写成 `7-9pm` 这种区间，
 * 强行解析成时间会丢信息也容易错，交给用户看原文更稳。
 */
export type ExamDate = {
  examName: string
  /** ISO `YYYY-MM-DD`。**日期不明时为 null，此时 status 为 `tbd`。** */
  examDate: string | null
  examTime: string | null
  location: string | null
  /**
   * 由 `examDate` 派生，**不是模型填的**：
   * 填得出日期就是 `confirmed`，否则 `tbd`（对应表上 `status` 的 CHECK 约束）。
   * PRD F3 要求"缺失时显示 TBD、禁止编造"，派生而非让模型判断，才能保证两者永远一致。
   */
  status: 'confirmed' | 'tbd'
  sourceExcerpt: string | null
}

export type OfficeHour = {
  personName: string
  /** 星期，如 `Tuesday`。多人合带或每周多次时会出现多条。 */
  dayOfWeek: string | null
  /** 如 `14:00`。原文是 `2pm` 时规整成 24 小时制；无法可靠转换时保留原文。 */
  startTime: string | null
  endTime: string | null
  /** 地点或线上链接。 */
  location: string | null
  sourceExcerpt: string | null
}

export type SubmissionPolicy = {
  description: string
  /** 涉及平台，如 `Gradescope`、`bCourses`。 */
  platformName: string | null
  sourceExcerpt: string | null
}

// ---------------------------------------------------------------
// 五个板块的键与整体结果
// ---------------------------------------------------------------

export const PARSE_SECTIONS = [
  'gradeComposition',
  'courseOutline',
  'testDates',
  'officeHours',
  'submissionPolicy',
] as const

export type ParseSection = (typeof PARSE_SECTIONS)[number]

/**
 * 五个板块的抽取结果。
 *
 * **一律是数组、永不为 null**：schema 里每块的容器都是必填 `array`，
 * 整块内容在原文里没有时模型返回**空数组**（这也是 prompt 里明确要求的），
 * 因此不存在"这一块为 null"的状态 —— 空数组与"没有"是同一件事，不需要两种表示。
 */
export type ParsedSyllabus = {
  gradeComposition: GradeComponent[]
  courseOutline: CourseOutlineItem[]
  testDates: ExamDate[]
  officeHours: OfficeHour[]
  submissionPolicy: SubmissionPolicy[]
}

/** 单个板块的结果：成功带数据，失败带 `LLMError`。 */
export type SectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; retryable: boolean }

/**
 * 五板块解析的总结果。**永远不抛异常**：文本太短、某个板块 LLM 失败、schema 不符，
 * 都落在对应板块上，其余板块照常返回。
 *
 * ⚠️ `ok` 的含义是「**五个板块全成功**」，不是"结果可用"。
 * **部分成功是常态**（比如这份 syllabus 就是没有 office hours 表），
 * 调用方应当看 `okSections.length` 决定有没有东西可落库：
 * - `okSections.length === 0` → 全崩，解析失败
 * - `failedSections.length > 0` → 部分成功，落成功的几块 + 对失败的几块给出提示
 */
export type ParsedSyllabusResult = {
  /** **五个板块是否全部成功**。部分成功时这里是 false，但 `okSections` 里仍有可用结果。 */
  ok: boolean
  sections: {
    gradeComposition: SectionResult<GradeComponent[]>
    courseOutline: SectionResult<CourseOutlineItem[]>
    testDates: SectionResult<ExamDate[]>
    officeHours: SectionResult<OfficeHour[]>
    submissionPolicy: SectionResult<SubmissionPolicy[]>
  }
  /** 成功返回的板块名。前端据此决定展示哪几块、哪几块显示"解析失败"。 */
  okSections: ParseSection[]
  failedSections: Array<{ section: ParseSection; code: string; message: string }>
  /** 输入文本的诊断信息：字数与是否被截断。排查"为什么漏抽"时第一手资料。 */
  meta: {
    textLength: number
    truncated: boolean
    promptVersion: string
  }
}
