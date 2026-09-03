/**
 * 五板块抽取编排（P0-1-4）。
 *
 * **这一层是纯编排，不碰 DB（落库在 P0-1-5）**：输入 syllabus 全文，输出五个板块的结构化结果。
 * 每个板块是一次**独立**的 LLM 调用 —— 不合并成一次大 JSON，理由见 `runSections()` 的注释。
 *
 * 依赖方向：`types/parse` ← `lib/parse` → `lib/llm`（结构化抽取 + `llm_runs` 审计）。
 */

import { runStructured } from '@/lib/llm/run'

import type {
  CourseOutlineItem,
  ExamDate,
  GradeComponent,
  OfficeHour,
  ParseSection,
  ParsedSyllabusResult,
  SectionResult,
  SubmissionPolicy,
} from '@/types/parse'

import {
  COURSE_OUTLINE_SCHEMA,
  GRADE_COMPOSITION_SCHEMA,
  OFFICE_HOURS_SCHEMA,
  SUBMISSION_POLICY_SCHEMA,
  TEST_DATES_SCHEMA,
} from './schemas'
import { buildSectionInstruction } from './prompts'

import type { SyllabusContext } from './prompts'
import type { JSONSchema } from '@/lib/llm'

/**
 * prompt 版本号，写进 `llm_runs.prompt_version`。
 *
 * ⚠️ **改 `prompts.ts` 或 `schemas.ts` 必须升这个版本号。**
 * PRD F3 要求把用户修正存成 diff 当优化种子，而"这次改动有没有变准"只能靠
 * prompt 版本 + 模型名两个维度分组统计；版本不动的话新旧调用混在一起，数据就废了。
 */
export const PROMPT_VERSION = 'v1'

/**
 * 少于这个字符数就不值得调 LLM —— 扫描件或排版异常的文件抽出来往往只有几行乱码，
 * 硬喂给模型只会得到一个"看起来合理"的编造结果。**宁可明确失败，不可编造。**
 */
const MIN_TEXT_LENGTH = 200

/**
 * 单次调用喂给模型的字符上限（约 7-8K token）。
 * 超过就截断尾部：syllabus 极少有 3 万字符以上的（正常 3-8K），
 * 真超了也要保证不把整个请求撑爆。截断会在 `meta.truncated` 里如实标记。
 *
 * ⚠️ 已知留白：截断是从尾部切的，而 office hours / 提交政策常写在文末。
 * 真遇到长文件时正确做法是**分块 + 合并**，Phase 0 先不做（先标记，别静默丢内容）。
 */
const MAX_SYLLABUS_CHARS = 30_000

const SECTION_CONFIG: Record<
  ParseSection,
  { schema: JSONSchema; schemaName: string; purpose: string }
> = {
  gradeComposition: {
    schema: GRADE_COMPOSITION_SCHEMA,
    schemaName: 'GradeComposition',
    purpose: 'syllabus_parse_grade',
  },
  courseOutline: {
    schema: COURSE_OUTLINE_SCHEMA,
    schemaName: 'CourseOutline',
    purpose: 'syllabus_parse_outline',
  },
  testDates: {
    schema: TEST_DATES_SCHEMA,
    schemaName: 'TestDates',
    purpose: 'syllabus_parse_exam',
  },
  officeHours: {
    schema: OFFICE_HOURS_SCHEMA,
    schemaName: 'OfficeHours',
    purpose: 'syllabus_parse_office_hours',
  },
  submissionPolicy: {
    schema: SUBMISSION_POLICY_SCHEMA,
    schemaName: 'SubmissionPolicy',
    purpose: 'syllabus_parse_submission',
  },
}

/** ISO 日期 `YYYY-MM-DD`。模型偶尔会把 "October 15, 2026" 原样塞进来，必须挡掉。 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function fail(code: string, message: string): { ok: false; code: string; message: string; retryable: boolean } {
  return { ok: false, code, message, retryable: false }
}

/**
 * 把模型返回的考试日期规整成可信值。
 *
 * `status` 由日期派生、**不接受模型的判断**：PRD F3 要求缺失时显示 TBD 且禁止编造，
 * 让模型自己填 status 就一定会出现"日期是 null 但 status 写 confirmed"的矛盾数据。
 *
 * 日期格式不合法时**置 null 而不是原样保留** —— 一个格式不对的日期既进不了
 * `exam_dates.exam_date`（`date` 列），展示给用户也是误导，退化成 TBD 让人补更安全。
 */
function normalizeExam(exam: Omit<ExamDate, 'status'>): ExamDate {
  const hasUsableDate = typeof exam.examDate === 'string' && ISO_DATE_PATTERN.test(exam.examDate)
  return {
    ...exam,
    examDate: hasUsableDate ? exam.examDate : null,
    status: hasUsableDate ? 'confirmed' : 'tbd',
  }
}

export type ParseSyllabusParams = {
  /** 写进 `llm_runs.user_id`。必须来自当前会话，否则 RLS 会拒掉审计行。 */
  userId: string
  /** 写进 `llm_runs.syllabus_id`，可空。 */
  syllabusId?: string | null
  /** `syllabi.raw_text`，即 P0-1-2 抽出来的全文。为 null 表示文本提取就没成功。 */
  rawText: string | null
  /** 课程上下文，主要给考试日期提供年份锚点。 */
  context?: SyllabusContext
}

/**
 * 五个板块各调一次 LLM，返回各自独立的结果。
 *
 * **为什么不合并成一次调用**：① 一次输出五块的 JSON 更长，模型更容易在某一块上跑偏，
 * 而一次跑偏会污染整个响应（schema 校验失败 → 五个板块全废）；② 拆开后某块失败可单独重试；
 * ③ 便于按板块统计准确率，定位"到底是哪一块的 prompt 需要改"。
 *
 * 并发而非串行：五块互不依赖，串行会把 PRD 要求的 10-30 秒预算拖成 5 倍。
 * 用 `Promise.all` 但每个调用内部已经收敛成 `LLMResult`，不会有未捕获的 rejection。
 */
async function runSections(
  params: ParseSyllabusParams,
  text: string,
): Promise<ParsedSyllabusResult['sections']> {
  const runOne = async <T>(
    section: ParseSection,
    pick: (payload: Record<string, unknown>) => unknown,
  ): Promise<SectionResult<T>> => {
    const config = SECTION_CONFIG[section]
    const result = await runStructured<Record<string, unknown>>({
      userId: params.userId,
      purpose: config.purpose,
      promptVersion: PROMPT_VERSION,
      syllabusId: params.syllabusId ?? null,
      schema: config.schema,
      schemaName: config.schemaName,
      messages: [
        { role: 'system', content: buildSectionInstruction(section, params.context) },
        { role: 'user', content: text },
      ],
    })

    if (!result.ok) {
      return {
        ok: false,
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
      }
    }

    const raw = pick(result.data)
    if (!Array.isArray(raw)) {
      return fail('invalid_response', `${section} 的返回里没有预期的数组字段`)
    }
    return { ok: true, data: raw as T }
  }

  const [gradeComposition, courseOutline, testDates, officeHours, submissionPolicy] =
    await Promise.all([
      runOne<GradeComponent[]>('gradeComposition', (d) => d.components),
      runOne<CourseOutlineItem[]>('courseOutline', (d) => d.items),
      runOne<Omit<ExamDate, 'status'>[]>('testDates', (d) => d.exams),
      runOne<OfficeHour[]>('officeHours', (d) => d.sessions),
      runOne<SubmissionPolicy[]>('submissionPolicy', (d) => d.policies),
    ])

  return {
    gradeComposition,
    courseOutline,
    // status 在这里派生，模型不参与。
    testDates: testDates.ok ? { ok: true, data: testDates.data.map(normalizeExam) } : testDates,
    officeHours,
    submissionPolicy,
  }
}

/**
 * 把 syllabus 全文解析成五个板块。
 *
 * **不抛异常**：文本太短、配置缺失、LLM 失败、schema 不符，全部收敛到对应板块的 error 分支。
 */
export async function parseSyllabusSections(
  params: ParseSyllabusParams,
): Promise<ParsedSyllabusResult> {
  const trimmed = (params.rawText ?? '').trim()
  const truncated = trimmed.length > MAX_SYLLABUS_CHARS
  const meta = {
    textLength: trimmed.length,
    truncated,
    promptVersion: PROMPT_VERSION,
  }

  const toResult = (sections: ParsedSyllabusResult['sections']): ParsedSyllabusResult => {
    const okSections = (Object.keys(sections) as ParseSection[]).filter(
      (section) => sections[section].ok,
    )
    const failedSections = (Object.keys(sections) as ParseSection[])
      .filter((section) => !sections[section].ok)
      .map((section) => {
        const failed = sections[section] as Extract<SectionResult<unknown>, { ok: false }>
        return { section, code: failed.code, message: failed.message }
      })

    return {
      ok: failedSections.length === 0,
      sections,
      okSections,
      failedSections,
      meta,
    }
  }

  // 文本太短：不浪费这次 LLM 调用，五个板块一起明确失败。
  // 这是 P0-1-2 降级路径的延续 —— 扫描件走到这里就该停，而不是让模型编一份课表出来。
  if (trimmed.length < MIN_TEXT_LENGTH) {
    const message =
      `syllabus 文本只有 ${trimmed.length} 个字符（少于 ${MIN_TEXT_LENGTH}），` +
      '无法解析。多半是扫描件或排版异常，请手动补充关键信息。'
    const failed: SectionResult<never> = fail('text_too_short', message)
    return toResult({
      gradeComposition: failed,
      courseOutline: failed,
      testDates: failed,
      officeHours: failed,
      submissionPolicy: failed,
    })
  }

  const text = truncated ? trimmed.slice(0, MAX_SYLLABUS_CHARS) : trimmed
  return toResult(await runSections(params, text))
}
