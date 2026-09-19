import { loadActiveCourseIds } from '@/lib/tasks'
import {
  EXAM_DATE_COLUMNS,
  deriveStatus,
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
import { examChangeLabel, resolveExamTargets, type ExamRowRef } from './exam-match'
import type { MessageExamRestore } from '@/types/message'
import type { CourseUpdateApplyInput, ParsedExam, ParsedGradeComponent } from './normalize'
import { toExamInsertRow, toGradeComponentInsertRow } from './normalize'

/**
 * 对话编排的**写入器**（P0-3-24）。
 *
 * ### 这是全项目第二个允许写 `exam_dates` / `grade_components` 的地方
 * 第一个是 `lib/parse/save.ts`（板块保存，PUT 全量替换）。两者的语义**刻意不同**：
 * - 保存端点：以表单为准对齐整张表（表单里没有的行删掉）；
 * - **本写入器：永不删除现有行** —— 新增的追加、**改期的改那一行**（P0-3-29）。
 *
 * 追加而不替换的理由：对话输入是"用户又说了点什么"，不是"这是这门课的完整构成"。
 * 用全量替换会让"我随口贴了两个期中的占比"把 syllabus 解析出来的其他项删掉 ——
 * 那是一次**不可逆的数据丢失**，而且用户完全不会预期。
 *
 * ### 🔴 改期为什么是 update 而不是再插一条（P0-3-29）
 * 「Midterm 1 改期到 9/27」若按新增处理，库里会同时存在 9/28 与 9/27 两条，
 * 用户在界面上看不出哪条是真的 —— 比"没改"更糟（他会对着错的日期复习）。
 * 所以写入前先经 `resolveExamTargets()` 问一句"这条落到哪一行"：
 * - 唯一命中 → **update 那一行**（只写 `exam_date` / `exam_time` / `location` /
 *   `source_excerpt` 与派生的 `status`），并把旧值快照写进 `applied.examRestores` ——
 *   撤销靠它**写回旧值**，绝不能按 id 删（那会把用户原本那条考试连根删掉）；
 * - 0 命中 → insert（用户显式指定 `targetExamId: null` 时也是 insert）；
 * - 多命中 / 名字不可辨识 → **不写**，回执里点名让人到对话框或课程页指定。
 *
 * ⚠️ 刻意不碰 `source` / `is_confirmed` / `exam_name`：这三列是**溯源与用户主权**
 * （ADR-015）。改期改的是"什么时候考"，不是"这个事实从哪来、谁确认过"。
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
  /** 本次**更正**（改期）的行数（P0-3-29）。与 `created` 分开报：两者的撤销方式不同。 */
  updated: number
  /** 写入后该课程该板块的总行数（供回执文案："已写入 2 条，现在共 7 条"）。 */
  total: number
  /** 新增条目的名称（回执里逐条点名，用户才能核对写对了没）。 */
  names: string[]
  /** 本次新增行的 id（P0-3-26 撤销按它精准回滚）。 */
  ids: string[]
  /** 被更正行的旧值快照（撤销按它**写回**，不按 id 删）。 */
  restores: MessageExamRestore[]
  /** 更正的人话（"Midterm 1 2026-09-28 → 2026-09-27"），进回执。 */
  changes: string[]
  /** 没写的条目与人话原因（多命中 / 不可辨识 / 目标行没了）。回执必须点名。 */
  blocked: { name: string; reason: string }[]
}

export type CourseUpdateApplyResult = {
  exams: ApplySectionResult | null
  gradeComponents: ApplySectionResult | null
  /** 写入后按 source 分组的占比合计校验（≠100 时带人话报警）。 */
  weightWarnings: string[]
  /**
   * 本次写入的全部业务数据行 id + 被更正行的旧值（P0-3-26 撤销用）。
   *
   * ⚠️ `examDateIds` **只放新增的行**：更正过的行放 `examRestores`，
   * 撤销时对前者是"删"、对后者是"写回旧值" —— 混进去会把用户原本那条考试删掉。
   */
  applied: {
    examDateIds: string[]
    gradeComponentIds: string[]
    examRestores: MessageExamRestore[]
  }
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

/**
 * 写考试：**先解析落到哪一行，再写**（P0-3-29）。
 *
 * ### 顺序
 * 1. 读这门课现有的考试行（**只此一门课** —— 跨课同名不许串）；
 * 2. `resolveExamTargets()` 解析每条输入 → `create` / `update` / 不写；
 * 3. 更正串行执行（行数是个位数），每行更新前把旧值快照存进 `restores`；
 * 4. 没命中的一次性 insert；
 * 5. 重拉全量 + `syncExamToTask()`。
 *
 * ### 🔴 旧值快照必须在改之前取
 * 改完就再也拿不到旧值了，而撤销要做到"把期中日期放回去" ——
 * 界面上那句「9/28 → 9/27」拆不回 `exam_time` / `location`，靠它还原是在编数据。
 */
async function writeExams(
  supabase: Client,
  courseId: string,
  exams: ParsedExam[],
): Promise<ApplySectionResult> {
  const { data: before, error: loadError } = await supabase
    .from('exam_dates')
    .select(EXAM_DATE_COLUMNS)
    .eq('course_id', courseId)
  if (loadError) throw loadError
  const existing = ((before ?? []) as ExamDateRow[]).map(toExamDate)
  const rows: ExamRowRef[] = existing.map((row) => ({
    id: row.id,
    examName: row.examName,
    examDate: row.examDate,
    examTime: row.examTime,
    location: row.location,
  }))
  const byId = new Map(existing.map((row) => [row.id, row] as const))

  const resolutions = resolveExamTargets(
    exams.map((exam) => ({
      examName: exam.examName,
      examDate: exam.examDate,
      examTime: exam.examTime,
      location: exam.location,
      ...(exam.targetExamId !== undefined ? { targetExamId: exam.targetExamId } : {}),
    })),
    rows,
  )

  const toInsert: ParsedExam[] = []
  const updates: { id: string; exam: ParsedExam }[] = []
  const restores: MessageExamRestore[] = []
  const changes: string[] = []
  const blocked: { name: string; reason: string }[] = []

  resolutions.forEach((resolution, index) => {
    if (resolution.kind === 'create') {
      toInsert.push(exams[index])
      return
    }
    if (resolution.kind === 'update' && resolution.target) {
      const row = byId.get(resolution.target.id)
      if (!row) {
        // 读出来之后、写之前这一行没了（并发删 / 重解析重建）—— 不写、回执点名。
        blocked.push({ name: resolution.exam.examName, reason: '目标行已不存在，未写入' })
        return
      }
      restores.push({
        id: row.id,
        examName: row.examName,
        examDate: row.examDate,
        examTime: row.examTime,
        location: row.location,
        sourceExcerpt: row.sourceExcerpt,
      })
      changes.push(examChangeLabel(resolution.exam, resolution.target))
      updates.push({ id: row.id, exam: exams[index] })
      return
    }
    blocked.push({
      name: resolution.exam.examName,
      reason: resolution.reason ?? '未写入',
    })
  })

  // ---------- 更正（update）----------
  for (const update of updates) {
    const { error } = await supabase
      .from('exam_dates')
      .update({
        exam_date: update.exam.examDate,
        exam_time: update.exam.examTime,
        location: update.exam.location,
        status: deriveStatus(update.exam.examDate),
        // 摘录跟着新值走：它是"这个值凭什么这么写"的证据。
        source_excerpt: update.exam.sourceExcerpt,
        // ⚠️ 刻意不写 `exam_name` / `source` / `is_confirmed`（见文件头）。
      })
      .eq('id', update.id)
      .eq('course_id', courseId)
    if (error) throw error
  }

  // ---------- 新增（insert）----------
  let ids: string[] = []
  if (toInsert.length > 0) {
    const insertRows = toInsert.map((exam) => toExamInsertRow(exam, courseId))
    const { data, error } = await supabase.from('exam_dates').insert(insertRows).select('id')
    if (error) throw error
    if ((data ?? []).length !== insertRows.length) {
      throw new Error(`exam_dates: 插入 ${insertRows.length} 行但只返回 ${(data ?? []).length} 行`)
    }
    ids = ((data ?? []) as { id: string }[]).map((row) => row.id)
  }

  // 派生前重新拉全量：`syncExamToTask` 的契约是"该课程当前全部考试行"，
  // 传本次新增的几条等于告诉它"别的都没了" → 会把其余派生任务删掉。
  const { data: all, error: reloadError } = await supabase
    .from('exam_dates')
    .select(EXAM_DATE_COLUMNS)
    .eq('course_id', courseId)
  if (reloadError) throw reloadError
  const stored = ((all ?? []) as ExamDateRow[]).map(toExamDate)

  await syncExamToTask({ supabase, courseId, exams: stored })

  return {
    created: ids.length,
    updated: updates.length,
    total: stored.length,
    ids,
    names: toInsert.map((exam) =>
      exam.examDate === null ? `${exam.examName}（日期待定）` : `${exam.examName} · ${exam.examDate}`,
    ),
    restores,
    changes,
    blocked,
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
  const ids = ((data ?? []) as { id: string }[]).map((row) => row.id)

  const { data: all, error: loadError } = await supabase
    .from('grade_components')
    .select(GRADE_COMPONENT_COLUMNS)
    .eq('course_id', courseId)
  if (loadError) throw loadError
  const stored = ((all ?? []) as GradeComponentRow[]).map(toGradeComponent)

  return {
    created: rows.length,
    updated: 0,
    total: stored.length,
    ids,
    names: components.map((item) =>
      item.weightPercent === null
        ? `${item.name}（未标占比）`
        : `${item.name} · ${item.weightPercent}%`,
    ),
    // 成绩构成没有"改期"这回事（本通道只追加），所以这三个恒为空 ——
    // 显式写出来，是为了让"有没有被更正的行"这件事在类型上就有答案，不靠默认值猜。
    restores: [],
    changes: [],
    blocked: [],
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
    exams = await writeExams(supabase, input.courseId, input.exams)
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

  return {
    exams,
    gradeComponents,
    weightWarnings: warnings,
    applied: {
      examDateIds: exams?.ids ?? [],
      gradeComponentIds: gradeComponents?.ids ?? [],
      examRestores: exams?.restores ?? [],
    },
  }
}

/**
 * 回执文案（一条人话）。
 *
 * 为什么要在服务端拼：回执要出现在消息栏（3-26）与对话框（本卡）两处，
 * 各拼一遍就会漂移成两种说法（CodingRules §10.1 第 21 条的形状）。
 *
 * ### 改期必须写成「更正 … 旧 → 新」，不能写成「已写入 N 条」
 * 用户点的是"Midterm 1 改到 9/27"。若回执说"已写入 1 条考试"，
 * 他会以为库里多了一条 —— 而真相是那一条被改了。说错比不说更糟。
 *
 * ### 没写的部分比写了的更显眼
 * 多命中 / 名字不可辨识的条目一条都没落库。它们在回执里占一整句，
 * 不能挤在括号里（R3：不许让用户以为都写进去了）。
 */
export function summarizeApply(result: CourseUpdateApplyResult): string {
  const parts: string[] = []
  if (result.exams) {
    const exams = result.exams
    const bits: string[] = []
    if (exams.updated > 0) {
      // 逐条点名 before → after（"更正 1 条考试（Midterm 1 2026-09-28 → 2026-09-27）"）。
      bits.push(`更正 ${exams.updated} 条考试（${exams.changes.join('；')}）`)
    }
    if (exams.created > 0) {
      bits.push(`新增 ${exams.created} 条考试（${exams.names.join('、')}）`)
    }
    const head = bits.length > 0 ? bits.join('、') : '一条考试都没写'
    parts.push(`${head}（该课现在共 ${exams.total} 条）`)
    if (exams.blocked.length > 0) {
      parts.push(
        `另有 ${exams.blocked.length} 条没写（${exams.blocked[0].name}：${exams.blocked[0].reason}）`,
      )
    }
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
