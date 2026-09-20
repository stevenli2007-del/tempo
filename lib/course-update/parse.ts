import { runStructured } from '@/lib/llm/run'
import { COURSE_UPDATE_PARSE_SCHEMA } from './normalize'
import { COURSE_UPDATE_PROMPT_VERSION, buildCourseUpdateMessages } from './prompt'

/**
 * 「一段课程文本 → 结构化预览」的**唯一实现**（P0-3-24 抽出，P0-3-25 复用）。
 *
 * ### 为什么抽成模块
 * 现在有**两个**调用方，而它们必须产出完全一样的形状：
 * 1. `POST /api/v1/tasks/parse` —— 用户在对话框里粘一段话（P0-3-8 / P0-3-24）；
 * 2. 公告 applier —— 用户对一条 Canvas 公告点「确认」（P0-3-25）。
 *
 * 两处各写一遍会漂成"对话框能认出考试、公告认不出"这种最难发现的差异 ——
 * prompt、schema、promptVersion 三样只要有一样不同，`llm_runs` 里按版本比准确率就是错的。
 *
 * ### 🔴 这里仍然不落库
 * 本函数只做「文本 → 结构化」，产出的是**候选**。写库是 `apply.ts` 的事，
 * 而"要不要写"由确认通道决定（ADR-015）。这条边界从 3-24 起没变。
 */

/** LLM 的原始产出（未经 `validateExamInput` 等校验器过滤）。 */
export type RawCourseUpdate = {
  tasks: Array<{ title: string; taskType: string; dueDate: string | null; notes: string | null }>
  exams: Array<{
    examName: string
    examDate: string | null
    examTime: string | null
    location: string | null
    sourceExcerpt: string
  }>
  gradeComponents: Array<{
    name: string
    weightPercent: number | null
    notes: string | null
    sourceExcerpt: string
  }>
  /**
   * 某一次作业 / 测验的得分（P0-3-34）。
   *
   * ⚠️ 与上面三个数组的**去向不同**：它不写 `exam_dates` / `grade_components`，
   * 也不新建任务 —— 它要落到一条**现有任务**上（用户在对话框里挑），
   * 走 `PATCH /api/v1/tasks/:id` 的 `score` 字段组。所以这里不做服务端校验过滤；
   * 校验由 `lib/tasks/score.ts` 的 `normalizeScoreInput()` 负责（对话框过滤 + 写入时各一次）。
   */
  scores: Array<{
    title: string
    score: number
    possible: number
    sourceExcerpt: string
  }>
  warnings: string[]
}

export type ParseCourseUpdateOutcome =
  | { ok: true; data: RawCourseUpdate }
  | { ok: false; code: string; message: string; reason: string }

/**
 * 跑一次解析。
 *
 * **不抛异常**（`runStructured` 保证）：模型不可用、返回不合 schema，一律回到
 * `ok: false`。调用方据此决定是给用户报错（对话框）还是判 applier 失败并回滚状态
 * （公告确认路径）。
 *
 * @param purpose 写进 `llm_runs.purpose`。两个调用方刻意用**不同**的 purpose ——
 *   否则将来查"公告这条路解析得准不准"就得靠时间戳猜。
 */
export async function parseCourseUpdate(input: {
  userId: string
  text: string
  purpose: string
  /**
   * 是否写 `llm_runs` 审计行。默认 true（业务调用必记）。
   * 独立脚本传 false —— 它们没有 Next 请求上下文，`cookies()` 会抛错，
   * 而且不该往审计表里插探针噪音（`probe:announcements` 就靠这个）。
   */
  record?: boolean
}): Promise<ParseCourseUpdateOutcome> {
  const result = await runStructured<RawCourseUpdate>({
    userId: input.userId,
    purpose: input.purpose,
    record: input.record ?? true,
    // 版本与 prompt 一起在 `lib/course-update/prompt.ts`（离线探针脚本共用同一份）。
    promptVersion: COURSE_UPDATE_PROMPT_VERSION,
    schema: COURSE_UPDATE_PARSE_SCHEMA,
    schemaName: 'CourseUpdateParse',
    messages: buildCourseUpdateMessages(input.text),
    temperature: 0,
  })

  if (!result.ok) {
    return {
      ok: false,
      code: 'llm_failed',
      message: '解析服务暂时不可用，请稍后重试',
      reason: result.error.code,
    }
  }
  return { ok: true, data: result.data }
}
