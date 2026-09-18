import { loadActiveCourseIds } from '@/lib/tasks'
import {
  EXAM_DATE_COLUMNS,
  toExamDate,
  type ExamDateRow,
} from '@/lib/exam-dates'
import {
  GRADE_COMPONENT_COLUMNS,
  toGradeComponent,
  type GradeComponentRow,
} from '@/lib/grade-components'
import { syncExamToTask } from '@/lib/sync/exam-tasks'
import { weightWarnings } from './weights'
import type { CourseUpdateApplyInput, ParsedExam, ParsedGradeComponent } from './normalize'
import { toExamInsertRow, toGradeComponentInsertRow } from './normalize'

/**
 * 对话编排的**写入器**（P0-3-24）。
 *
 * ### 这是全项目第二个允许写 `exam_dates` / `grade_components` 的地方
 * 第一个是 `lib/parse/save.ts`（板块保存，PUT 全量替换）。两者的语义**刻意不同**：
 * - 保存端点：以表单为准对齐整张表（表单里没有的行删掉）；
 * - **本写入器：只追加，绝不删改现有行。**
 *
 * 追加而不替换的理由：对话输入是"用户又说了点什么"，不是"这是这门课的完整构成"。
 * 用全量替换会让"我随口贴了两个期中的占比"把 syllabus 解析出来的其他项删掉 ——
 * 那是一次**不可逆的数据丢失**，而且用户完全不会预期。
 *
 * ### 🔴 复用 3-17 派生链（不是重写）
 * 考试写完后调用 `syncExamToTask()`（`lib/sync/exam-tasks.ts`），
 * 它是 `exam_dates → tasks` 的**唯一**派生实现（ADR-004）。
 * 绝不在这里自己 insert 一条 exam 任务 —— 那会让 `(course_id, source, source_id)`
 * 撞唯一索引，或者更糟：派生出两条同名的考试。
 *
 * ### 幂等与失败语义
 * 串行写入（行数是个位数，换"断在哪一行可确定"，与 `persist.ts` 同一取舍）。
 * 任一行失败 → 抛错 → 路由层 500。**不做部分成功**：
 * 已经写进去的前几条会留着（数据库没有跨表事务），但响应是明确的失败，
 * 用户会看到报错而不是"好像成功了"。这比静默部分成功安全。
 */

/** 与 `lib/parse/save.ts` 同一手法：从会话客户端推导类型，避免 import 服务端模块到纯逻辑里。 */
type Client = Parameters<typeof syncExamToTask>[0]['supabase']

export type ApplySectionResult = {
  /** 本次新增的行数。 */
  created: number
  /** 写入后该课程该板块的总行数（供回执文案："已写入 2 条，现在共 7 条"）。 */
  total: number
  /** 新增条目的名称（回执里逐条点名，用户才能核对写对了没）。 */
  names: string[]
}

export type CourseUpdateApplyResult = {
  exams: ApplySectionResult | null
  gradeComponents: ApplySectionResult | null
  /** 写入后按 source 分组的占比合计校验（≠100 时带人话报警）。 */
  weightWarnings: string[]
}

/** 课程归属：只接受当前用户未归档的课程（ADR-010：越权与不存在统一 404）。 */
async function assertOwnedCourse(
  supabase: Client,
  courseId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const { ids, error } = await loadActiveCourseIds(supabase)
  if (error) throw new Error(error)
  if (!ids.includes(courseId)) {
    return { ok: false, code: 'not_found', message: '课程不存在或无权访问' }
  }
  return { ok: true }
}

async function insertExams(
  supabase: Client,
  courseId: string,
  exams: ParsedExam[],
): Promise<ApplySectionResult> {
  const rows = exams.map((exam) => toExamInsertRow(exam, courseId))
  const { data, error } = await supabase.from('exam_dates').insert(rows).select('id')
  if (error) throw error
  if ((data ?? []).length !== rows.length) {
    throw new Error(`exam_dates: 插入 ${rows.length} 行但只返回 ${(data ?? []).length} 行`)
  }

  // 派生前重新拉全量：`syncExamToTask` 的契约是"该课程当前全部考试行"，
  // 传本次新增的几条等于告诉它"别的都没了" → 会把其余派生任务删掉。
  const { data: all, error: loadError } = await supabase
    .from('exam_dates')
    .select(EXAM_DATE_COLUMNS)
    .eq('course_id', courseId)
  if (loadError) throw loadError
  const stored = ((all ?? []) as ExamDateRow[]).map(toExamDate)

  await syncExamToTask({ supabase, courseId, exams: stored })

  return {
    created: rows.length,
    total: stored.length,
    names: exams.map((exam) =>
      exam.examDate === null ? `${exam.examName}（日期待定）` : `${exam.examName} · ${exam.examDate}`,
    ),
  }
}

async function insertGradeComponents(
  supabase: Client,
  courseId: string,
  components: ParsedGradeComponent[],
): Promise<ApplySectionResult> {
  const rows = components.map((item) => toGradeComponentInsertRow(item, courseId))
  const { data, error } = await supabase.from('grade_components').insert(rows).select('id')
  if (error) throw error
  if ((data ?? []).length !== rows.length) {
    throw new Error(`grade_components: 插入 ${rows.length} 行但只返回 ${(data ?? []).length} 行`)
  }

  const { data: all, error: loadError } = await supabase
    .from('grade_components')
    .select(GRADE_COMPONENT_COLUMNS)
    .eq('course_id', courseId)
  if (loadError) throw loadError
  const stored = ((all ?? []) as GradeComponentRow[]).map(toGradeComponent)

  return {
    created: rows.length,
    total: stored.length,
    names: components.map((item) =>
      item.weightPercent === null
        ? `${item.name}（未标占比）`
        : `${item.name} · ${item.weightPercent}%`,
    ),
  }
}

/**
 * 执行写入。**这是「确认」路径上唯一会碰 `exam_dates` / `grade_components` 的函数**。
 *
 * 调用方必须先拿到用户确认（ADR-015）——本函数不做任何"要不要写"的判断，
 * 它只负责"写"。判定在哪一层是 `lib/messages/decide.ts` 的职责（后续卡接入）。
 */
export async function applyCourseUpdate(
  supabase: Client,
  input: CourseUpdateApplyInput,
): Promise<CourseUpdateApplyResult> {
  const owned = await assertOwnedCourse(supabase, input.courseId)
  if (!owned.ok) {
    // 归属失败是"业务拒绝"不是"系统崩溃"，用异常码让路由层转成 404。
    const err = new Error(owned.message) as Error & { code?: string }
    err.code = owned.code
    throw err
  }

  let exams: ApplySectionResult | null = null
  if (input.exams.length > 0) {
    exams = await insertExams(supabase, input.courseId, input.exams)
  }

  let gradeComponents: ApplySectionResult | null = null
  let warnings: string[] = []
  if (input.gradeComponents.length > 0) {
    gradeComponents = await insertGradeComponents(supabase, input.courseId, input.gradeComponents)
    // 合计校验用**库里的全量**而不是本次新增的几条：
    // 用户贴了"两个期中各 30%"，真正的缺口要看这门课现在总共标注了多少。
    const { data: all, error } = await supabase
      .from('grade_components')
      .select(GRADE_COMPONENT_COLUMNS)
      .eq('course_id', input.courseId)
    if (error) throw error
    const stored = ((all ?? []) as GradeComponentRow[]).map(toGradeComponent)
    warnings = weightWarnings(stored)
  }

  return { exams, gradeComponents, weightWarnings: warnings }
}

/**
 * 回执文案（一条人话）。
 *
 * 为什么要在服务端拼：回执要出现在消息栏（3-26）与对话框（本卡）两处，
 * 各拼一遍就会漂移成两种说法（CodingRules §10.1 第 21 条的形状）。
 */
export function summarizeApply(result: CourseUpdateApplyResult): string {
  const parts: string[] = []
  if (result.exams) {
    parts.push(`已写入 ${result.exams.created} 条考试（该课现在共 ${result.exams.total} 条）`)
  }
  if (result.gradeComponents) {
    parts.push(
      `已写入 ${result.gradeComponents.created} 条成绩构成（该课现在共 ${result.gradeComponents.total} 条）`,
    )
  }
  return parts.length > 0 ? parts.join(' · ') : '没有写入任何内容'
}

/** 供 UI 在**确认前**预览合计（不落库）。预览条目尚未入库，一律按 manual 来源算。 */
export function previewWeightWarnings(components: ParsedGradeComponent[]): string[] {
  return weightWarnings(
    components.map((item) => ({ source: 'manual', weightPercent: item.weightPercent })),
  )
}
