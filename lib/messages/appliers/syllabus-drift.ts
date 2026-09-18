import { EXAM_DATE_COLUMNS, deriveStatus, toExamDate, type ExamDateRow } from '@/lib/exam-dates'
import { syncExamToTask } from '@/lib/sync/exam-tasks'
import { loadActiveCourseIds } from '@/lib/tasks'
import type { ApplyContext, ApplyOutcome, MessageApplier } from '@/lib/messages/apply'
import type {
  MessageDrift,
  MessageDriftAddedComponent,
  MessageDriftAddedExam,
  MessageDriftChangedExam,
  MessageExamRestore,
  MessagePayload,
} from '@/types/message'

/**
 * 大纲漂移的写入器（P0-3-20 的「确认」路径）。
 *
 * ### 它写什么（三件，各一条纪律）
 * 1. **新增的考试 / 成绩构成** → 追加行（只追加，绝不删改别的行）；
 * 2. **变动的考试** → 更正已有的那一行 —— 但有前提，见下；
 * 3. **描述性变化（`notes`）** → 一个字段都不写，只显示。
 *
 * ### 🔴 红线一：已确认的行绝不自动覆盖
 * 只有 `source='syllabus'` 且 `is_confirmed=false` 的行可更正（判定在懒补那一步
 * 由服务端算好，写进 `change.writable`，**这里只照做、不重判**）。
 * 已经在课程页亲手确认/改过的行是权威源（ADR-015），命中它时**不写**，
 * 并在回执里点名"请到课程页手动修改" —— 说出来就不算静默失败（R3）。
 *
 * 判定放在产出侧（`lib/syllabus-drift/generate.ts`）而不是这里，是因为界面要用它
 * 画"哪些改得、哪些改不得"；如果这里再判一遍，两处迟早分叉（CodingRules §10.1 第 21 条）。
 *
 * ### 🔴 红线二：写入的考试行标 `source='syllabus'`、`is_confirmed=false`
 * 这两列的语义是**溯源**，不是"用户点没点过确认按钮"：
 * - `source` 说的是"这个事实从哪来" —— 它来自一份 syllabus 文档，所以是 `'syllabus'`
 *   （`'manual'` 是用户在课程页手填，`'canvas'` 留给 Canvas 结构化数据）；
 * - `is_confirmed=false` 说的是"用户没有**逐字**核对过这一行" —— 他确认的是**提案**，
 *   不是这条记录的每个字符。
 *
 * ⚠️ 这两列一起决定了**下一次漂移还能不能自动更正它**。若为了"用户刚点过确认"
 * 而写成 `is_confirmed=true`（或 `source='manual'`），那么老师第二次改日期时，
 * Tempo 会回一句"这条你已经确认过，请到课程页手动修改" —— 功能在第一次接受之后就死了。
 * 顺带一提：`lib/parse/persist.ts` 的重解析只清 `source='syllabus'` 的行，
 * 所以这些行在下一次重解析时会被重建 —— 那正是机器派生行应有的行为。
 *
 * ### 🔴 红线三：写完之后必须重跑派生链
 * 考试改期了，日历上的那道派生任务也得跟着动 —— `syncExamToTask()` 是
 * `exam_dates → tasks` 的唯一实现（ADR-004），而且它**只碰 title / due_date**，
 * 绝不动用户勾过的 `status`。
 *
 * ### 已知局限（与 3-24 / 3-25 两条写入路径相同，不在此处单独解决）
 * 数据库没有跨表事务：考试行插进去了、`syncExamToTask` 却失败时，本函数返回失败、
 * 消息留在 `pending`，用户重试会**再插一遍**（重复行）。三条写入路径共享这个缺口，
 * 要修就在统一的地方修（Phase 0 之后），不在这里做半截补偿 ——
 * 半截补偿（比如失败时回滚）反而会因为回滚本身失败而更难查。
 */

/** 归属：只接受当前用户未归档的课程（ADR-010：越权与不存在统一 404）。 */
async function assertOwnedCourse(
  ctx: ApplyContext,
  courseId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const { ids, error } = await loadActiveCourseIds(ctx.supabase)
  if (error) throw new Error(error)
  if (!ids.includes(courseId)) {
    return { ok: false, code: 'not_found', message: '课程不存在或无权访问，已停止写入' }
  }
  return { ok: true }
}

/**
 * 读 `payload.drift`。**payload 是 jsonb，写入方只有懒补那一步，但仍逐项守卫** ——
 * 一次手工改库或一个半截写入就会让下面所有 `for` 崩掉，而这是个写路径。
 * 坏条目**丢掉**、好条目照常写（与 3-25 公告 applier 同一取舍：用户在等结果，
 * 不该为一个形状不对的条目把整条提案作废）。
 */
function readDrift(payload: MessagePayload): MessageDrift | null {
  const raw = payload.drift
  if (typeof raw !== 'object' || raw === null) return null
  return raw as MessageDrift
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 一条新增考试（形状不对返回 null）。 */
function toAddedExam(raw: unknown): MessageDriftAddedExam | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const examName = text(record.examName)
  const sourceExcerpt = text(record.sourceExcerpt)
  // 🔴 没有摘录的条目**不许写库**（ADR-021 解禁 exam 产出的前提）。
  // 懒补侧已经挡过一道（`requireExcerpt`），这里是写路径的最后一道。
  if (examName === null || sourceExcerpt === null) return null
  return {
    examName,
    examDate: text(record.examDate),
    examTime: text(record.examTime),
    location: text(record.location),
    sourceExcerpt,
  }
}

function toAddedComponent(raw: unknown): MessageDriftAddedComponent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const name = text(record.name)
  const sourceExcerpt = text(record.sourceExcerpt)
  if (name === null || sourceExcerpt === null) return null
  const weight = record.weightPercent
  const weightPercent =
    typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 100 ? weight : null
  return { name, weightPercent, notes: text(record.notes), sourceExcerpt }
}

/** 一条可更正的变动（`writable` 不是字面 `true` 的一律不算 —— 不确定就不写）。 */
function toWritableChange(raw: unknown): MessageDriftChangedExam | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record.writable !== true) return null
  const id = text(record.id)
  const examName = text(record.examName)
  if (id === null || examName === null) return null
  return {
    id,
    examName,
    before: typeof record.before === 'string' ? record.before : '',
    after: typeof record.after === 'string' ? record.after : '',
    examDate: text(record.examDate),
    examTime: text(record.examTime),
    location: text(record.location),
    sourceExcerpt: text(record.sourceExcerpt) ?? '',
    writable: true,
    blockedReason: null,
  }
}

export const syllabusDriftApplier: MessageApplier = async (
  ctx: ApplyContext,
): Promise<ApplyOutcome> => {
  const { payload, supabase } = ctx
  const courseId = text(payload.courseId)
  if (courseId === null) {
    return {
      ok: false,
      code: 'missing_course',
      message: '这条提案没有关联课程，无法写入，请改用对话框处理',
    }
  }

  const drift = readDrift(payload)
  if (drift === null) {
    // 差异还没算出来（`driftStatus='pending'`）或写入被截断。**绝不能假装写成功**
    // —— 界面上按钮在这两种情况下本来就是灰的，走到这里说明有人绕过了界面。
    return {
      ok: false,
      code: 'drift_not_ready',
      message: '这条提案的差异还没核对出来，请稍后重试（或点「忽略」）',
    }
  }

  const addedExams = (Array.isArray(drift.addedExams) ? drift.addedExams : [])
    .map(toAddedExam)
    .filter((item): item is MessageDriftAddedExam => item !== null)
  const addedComponents = (Array.isArray(drift.addedComponents) ? drift.addedComponents : [])
    .map(toAddedComponent)
    .filter((item): item is MessageDriftAddedComponent => item !== null)
  const writableChanges = (Array.isArray(drift.changedExams) ? drift.changedExams : [])
    .map(toWritableChange)
    .filter((item): item is MessageDriftChangedExam => item !== null)

  // 被挡下的变动：**在回执里点名**，这是本卡最重要的一句人话 ——
  // 用户看到"确认"以为都改了，而有一条因为"已经确认过"没动，那必须说出来。
  const blockedChanges = Array.isArray(drift.changedExams)
    ? drift.changedExams.filter(
        (change) =>
          typeof change === 'object' &&
          change !== null &&
          (change as { writable?: unknown }).writable !== true,
      )
    : []

  const hasWork = addedExams.length > 0 || addedComponents.length > 0 || writableChanges.length > 0

  // ---------- 0) 没有要写的东西 → 刻意空写入 ----------
  //
  // 两种来源都走这里：① 核对完发现"没有差异"（`clean`）；
  // ② 有变动但**每一条都命中已确认的行**。后者回执必须说清"一条都没改"，
  // 否则用户会以为 Tempo 帮他把大纲对齐了。
  if (!hasWork) {
    if (blockedChanges.length > 0) {
      return {
        ok: true,
        summary: `${blockedChanges.length} 条变动命中了你已确认过的记录，Tempo 没有自动改 —— 请到课程页手动核对`,
      }
    }
    return { ok: true, summary: '已核对（这份大纲与你的记录一致，没有要写入的变更）' }
  }

  const owned = await assertOwnedCourse(ctx, courseId)
  if (!owned.ok) return owned

  // ---------- 1) 先读旧状态（更正要留旧值快照，撤销靠它还原） ----------
  //
  // 🔴 快照必须在**改之前**取：改完就再也拿不到旧值了，而撤销要做到
  // 「把期中日期放回去」，不能只靠界面上那句「10/20 → 10/27」——
  // 那句话拆不回 `exam_date` / `exam_time`。
  const { data: beforeRows, error: beforeError } = await supabase
    .from('exam_dates')
    .select(EXAM_DATE_COLUMNS)
    .eq('course_id', courseId)
  if (beforeError) {
    return { ok: false, code: 'exam_load_failed', message: `读取课程考试记录失败：${beforeError.message}` }
  }
  const beforeById = new Map(
    ((beforeRows ?? []) as ExamDateRow[]).map((row) => [row.id, row] as const),
  )

  const restores: MessageExamRestore[] = []
  const staleNames: string[] = []

  // ---------- 2) 更正已有的考试行 ----------
  //
  // 串行（行数是个位数，换来"断在哪一行是确定的"，与 `applyCourseUpdate` 同一取舍）。
  // 按 `id + course_id` 双重定位，绝不 `update().eq('course_id', …)` 整表改。
  for (const change of writableChanges) {
    const existing = beforeById.get(change.id)
    if (!existing) {
      // 目标行在这期间没了（用户手动删了，或另一次重解析重建过）→ 不改、记下来。
      staleNames.push(change.examName)
      continue
    }

    const { error } = await supabase
      .from('exam_dates')
      .update({
        exam_name: change.examName,
        exam_date: change.examDate,
        exam_time: change.examTime,
        location: change.location,
        status: deriveStatus(change.examDate),
        // 摘录跟着新值走：它是"这个值凭什么这么写"的证据。
        source_excerpt: change.sourceExcerpt === '' ? null : change.sourceExcerpt,
        // ⚠️ **刻意不碰 `is_confirmed` 与 `source`** —— 理由见文件头红线二。
      })
      .eq('id', change.id)
      .eq('course_id', courseId)
    if (error) {
      return { ok: false, code: 'exam_update_failed', message: `更正考试记录失败：${error.message}` }
    }

    restores.push({
      id: change.id,
      examName: existing.exam_name,
      examDate: existing.exam_date,
      examTime: existing.exam_time,
      location: existing.location,
      // 摘录也一起快照：撤销要把这一行的**全部**可写字段放回去，
      // 只还原 date/time 会把新值的摘录留在旧值旁边（库里的溯源信息就对不上了）。
      sourceExcerpt: existing.source_excerpt,
    })
  }

  // ---------- 3) 追加新增的考试 ----------
  let createdExamIds: string[] = []
  if (addedExams.length > 0) {
    const rows = addedExams.map((exam) => ({
      course_id: courseId,
      exam_name: exam.examName,
      exam_date: exam.examDate,
      exam_time: exam.examTime,
      location: exam.location,
      status: deriveStatus(exam.examDate),
      is_confirmed: false,
      source: 'syllabus',
      source_excerpt: exam.sourceExcerpt,
    }))
    const { data, error } = await supabase.from('exam_dates').insert(rows).select('id')
    if (error) {
      return { ok: false, code: 'exam_insert_failed', message: `写入新增考试失败：${error.message}` }
    }
    if ((data ?? []).length !== rows.length) {
      return {
        ok: false,
        code: 'exam_insert_incomplete',
        message: `考试写入不完整（${rows.length} 条只返回 ${(data ?? []).length} 条），请到课程页核对`,
      }
    }
    createdExamIds = ((data ?? []) as { id: string }[]).map((row) => row.id)
  }

  // ---------- 4) 重跑派生链（ADR-004 唯一实现） ----------
  //
  // 改期必须让日历上的考试任务跟着动 —— 这是本卡的**用户可感知结果**，
  // 不是收尾工作。`syncExamToTask` 只碰 title / due_date，不动用户勾过的 status。
  //
  // 重拉一次全量：它的契约是"该课程当前全部考试行"，只传本次动过的几条
  // 等于告诉它"别的都删了"→ 会把其余派生任务清掉。
  const { data: afterRows, error: afterError } = await supabase
    .from('exam_dates')
    .select(EXAM_DATE_COLUMNS)
    .eq('course_id', courseId)
  if (afterError) {
    return { ok: false, code: 'exam_reload_failed', message: `写入后重算任务失败：${afterError.message}` }
  }
  const stored = ((afterRows ?? []) as ExamDateRow[]).map(toExamDate)
  try {
    await syncExamToTask({ supabase, courseId, exams: stored })
  } catch (error) {
    return {
      ok: false,
      code: 'task_resync_failed',
      message: `写入后任务重算失败：${(error as Error).message ?? '未知错误'}`,
    }
  }

  // ---------- 5) 追加新增的成绩构成（没有派生任务，直接写） ----------
  let createdComponentIds: string[] = []
  if (addedComponents.length > 0) {
    const rows = addedComponents.map((item) => ({
      course_id: courseId,
      name: item.name,
      weight_percent: item.weightPercent,
      notes: item.notes,
      is_confirmed: false,
      source: 'syllabus',
      source_excerpt: item.sourceExcerpt,
    }))
    const { data, error } = await supabase.from('grade_components').insert(rows).select('id')
    if (error) {
      return {
        ok: false,
        code: 'component_insert_failed',
        message: `写入新增成绩构成失败：${error.message}`,
      }
    }
    createdComponentIds = ((data ?? []) as { id: string }[]).map((row) => row.id)
  }

  // ---------- 6) 回执：说清写了什么、没写什么 ----------
  const parts: string[] = []
  if (createdExamIds.length > 0 || restores.length > 0) {
    const bits: string[] = []
    if (createdExamIds.length > 0) bits.push(`新增 ${createdExamIds.length} 条考试`)
    if (restores.length > 0) bits.push(`更正 ${restores.length} 条考试`)
    parts.push(`${bits.join('、')}（该课现在共 ${stored.length} 条）`)
  }
  if (createdComponentIds.length > 0) {
    parts.push(`新增 ${createdComponentIds.length} 条成绩构成`)
  }
  if (blockedChanges.length > 0) {
    // 这句是回执里最重要的一行：**没写的那部分必须比写了的更显眼**。
    parts.push(
      `另有 ${blockedChanges.length} 条变动命中你已确认过的记录，Tempo 没有自动改 —— 请到课程页手动核对`,
    )
  }
  if (staleNames.length > 0) {
    parts.push(`另有 ${staleNames.length} 条（${staleNames[0]}）的目标记录已不存在，未修改`)
  }

  const summary = parts.length > 0 ? parts.join(' · ') : '没有写入任何内容'

  // `applied` 的三个数组各司其职（P0-3-26 撤销用）：
  // 新增的按 id 删、**更正的按 `examRestores` 里的旧值还原**（不是删！）。
  const applied = {
    examDateIds: createdExamIds,
    gradeComponentIds: createdComponentIds,
    examRestores: restores,
  }
  const hasApplied =
    createdExamIds.length > 0 || createdComponentIds.length > 0 || restores.length > 0

  return { ok: true, summary, ...(hasApplied ? { applied } : {}) }
}
