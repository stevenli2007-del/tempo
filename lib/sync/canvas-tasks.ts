import type { CanvasAssignment } from '@/types/canvas'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * Canvas 作业 → `tasks` 表的落库（P0-2-5，Database.md 第 4 节「同步语义」）。
 *
 * 与 `exam-tasks.ts` 的分工：那边管 `exam_dates → tasks` 的**派生**，
 * 这边管 `Canvas → tasks` 的**同步**。两者都只写自己 `source` 的行，互不干扰。
 *
 * ### 🔴 三条铁律
 *
 * 1. **绝不整行 upsert，绝不碰 `status`。**
 *    用户勾掉的"已完成"必须在下一次同步后依然是已完成 ——
 *    "我明明做完了，第二天又变回未完成"是这类应用最常见的体验 bug（Database.md 4.1）。
 *    本文件写入的字段集合是封闭的：`title` / `due_date` / `external_updated_at` /
 *    `last_seen_at` / `is_deleted` / `submission_state` / `submitted_at`，**没有 `status`**。
 *    `submission_state` 是 Canvas 真相（ADR-015：与用户主权的 `status` 分列，展示层合并）。
 *
 * 2. **没有变化就不写库**（Database.md 4.2 的原话：不刷 `updated_at`）。
 *    `updated_at` 应该表示"这条数据什么时候真的变过"，而不是"什么时候被同步扫到过"。
 *    代价与取舍见下面「`last_seen_at` 的语义偏差」。
 *
 * 3. **外部源删了 → 软删除，不物理删除**（Database.md 4.3）：
 *    老师误删后恢复很常见，物理删除会造成"任务凭空消失"的困惑。
 *    同理，被软删除的行如果又出现了（老师恢复了），要**恢复**它而不是新建一条。
 *
 * ### `last_seen_at` 的语义偏差（有意如此，别当成 bug 修）
 * Database.md §3.9 写它"用于识别外部已删除"。但 `tasks` 上有 `trg_tasks_updated_at`
 * 触发器，任何 UPDATE 都会连带刷新 `updated_at` —— 于是"每次同步都刷 last_seen_at"
 * 与铁律 2（不刷 updated_at）**在物理上不可兼得**。
 * 这里选择遵守铁律 2：`last_seen_at` 只在真正发生变化的写入里顺带刷新，
 * 它的实际含义退化为"最后一次被观察到**发生变化**的时间"。
 * 删除判定**不依赖它**，而是依赖"本次完整拉取中缺席"（见 `complete` 参数），
 * 所以这个退化不影响任何功能，只是字段注释比实际功能多说了一点。
 *
 * ### 写入量控制
 * 无论一门课有多少作业，落库固定最多 3 次写请求：批量插入新增 + 逐条更新变化 +
 * 批量软删除缺席。unchanged 的行一次都不写。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

const CANVAS_SOURCE = 'canvas'
const CANVAS_TASK_TYPE = 'assignment'
/** Postgres 唯一约束冲突（并发同步抢同一行时用得上）。 */
const UNIQUE_VIOLATION = '23505'

/** Canvas submission_types 里"压根不存在完成态"的几类：永远保留手勾，同步不写提交态。 */
const NO_COMPLETION_TYPES = new Set(['none', 'not_graded', 'on_paper'])
/** 外链类（Gradescope 等 LTI）。Canvas 无提交记录 → 展示「待确认」，不显示"待完成"。 */
const EXTERNAL_TOOL_TYPE = 'external_tool'

/**
 * 把一条 Canvas 作业映射成 Tempo 的提交态（P0-3-10 的"五个分支"全在此收口）。
 *
 * 返回 `submissionState`（落 `tasks.submission_state`）+ `submittedAt`（落 `tasks.submitted_at`）。
 * 任何异常形状都降级到最保守值 —— 宁可让用户手勾，也不替他判定"没交"。
 *
 * 分支：
 *  ① submission_types 含 none/not_graded/on_paper → null（无完成态，用户手勾）
 *  ② 有内联 submission：
 *       graded → graded；submitted → submitted；pending_review → pending_review
 *       unsubmitted → **external_tool 则降级 external_unconfirmed**（见 EXTERNAL_TOOL_TYPE 注释）；
 *                     其余看 Canvas 的 missing 标记 → missing / unsubmitted
 *  ③ 无内联 submission → external_tool → external_unconfirmed（待确认）；其余 → null
 */
export function deriveSubmission(
  assignment: CanvasAssignment,
): { submissionState: string | null; submittedAt: string | null } {
  const types = assignment.submissionTypes
  if (types.some((t) => NO_COMPLETION_TYPES.has(t))) {
    return { submissionState: null, submittedAt: null }
  }

  const submission = assignment.submission
  if (submission) {
    switch (submission.workflowState) {
      case 'graded':
        return { submissionState: 'graded', submittedAt: submission.submittedAt }
      case 'submitted':
        return { submissionState: 'submitted', submittedAt: submission.submittedAt }
      case 'pending_review':
        return { submissionState: 'pending_review', submittedAt: submission.submittedAt }
      case 'unsubmitted':
        // ⚠️ external_tool 的"未交"是 Canvas 的**推断**（它看不见 Gradescope 里的提交），
        //    已实测出现假阴性（Lab 1: Airbags）。降级「待确认」，绝不当"待完成"晾给用户。
        if (types.includes(EXTERNAL_TOOL_TYPE)) {
          return { submissionState: 'external_unconfirmed', submittedAt: null }
        }
        // Canvas 自己标记了缺交 → 用 missing 态（区别于普通"未交"）。
        return {
          submissionState: submission.missing ? 'missing' : 'unsubmitted',
          submittedAt: null,
        }
      default:
        // deleted / 其他未知态 → 保守当"无记录"。
        return { submissionState: null, submittedAt: null }
    }
  }

  // 没有内联提交记录。
  if (types.includes(EXTERNAL_TOOL_TYPE)) {
    return { submissionState: 'external_unconfirmed', submittedAt: null }
  }
  return { submissionState: null, submittedAt: null }
}

export type CanvasTaskCounts = {
  created: number
  updated: number
  deleted: number
}

export type ApplyCanvasTasksResult =
  | { ok: true; counts: CanvasTaskCounts }
  | { ok: false; error: string }

type ExistingRow = {
  id: string
  source_id: string | null
  title: string
  due_date: string | null
  external_updated_at: string | null
  is_deleted: boolean
  submission_state: string | null
  submitted_at: string | null
}

/** 时间值比较：两边都是 null 算相同；有一边解析不出来算不同（保守地重写一次）。 */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return ta === tb
}

/**
 * 判断一条已存在的任务是否需要写入。
 *
 * `is_deleted` 也算变化条件：之前被软删除的行这次又出现了（老师恢复了作业），
 * 必须写一次把它恢复 —— 否则用户会看到"作业回来了但列表里没有"。
 */
function hasChanged(existing: ExistingRow, incoming: CanvasAssignment): boolean {
  const { submissionState, submittedAt } = deriveSubmission(incoming)
  return (
    existing.is_deleted ||
    existing.title !== incoming.title ||
    !sameInstant(existing.due_date, incoming.dueAt) ||
    !sameInstant(existing.external_updated_at, incoming.externalUpdatedAt) ||
    existing.submission_state !== submissionState ||
    !sameInstant(existing.submitted_at, submittedAt)
  )
}

/**
 * 把一次拉取到的作业对齐到数据库。
 *
 * @param complete 本次拉取是否**完整**（拿到了全部页且没出错）。
 *   为 false 时跳过删除步骤 —— 一次不完整的拉取会把没拿到的行误判成"外部已删除"，
 *   那是同步里最伤用户的一类事故（作业凭空消失）。宁可晚一轮再删。
 */
export async function applyCanvasTasks({
  supabase,
  courseId,
  assignments,
  now,
  complete,
}: {
  supabase: SupabaseClient
  courseId: string
  assignments: CanvasAssignment[]
  /** 本次同步的时刻（ISO 串），写入 `last_seen_at`。 */
  now: string
  complete: boolean
}): Promise<ApplyCanvasTasksResult> {
  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id, source_id, title, due_date, external_updated_at, is_deleted, submission_state, submitted_at',
    )
    .eq('course_id', courseId)
    .eq('source', CANVAS_SOURCE)

  if (error) {
    return { ok: false, error: error.message }
  }

  const existingRows = (data ?? []) as ExistingRow[]
  const bySourceId = new Map<string, ExistingRow>()
  for (const row of existingRows) {
    // source_id 为 null 的行不是同步产生的（手动任务），不参与比对。
    if (row.source_id !== null) {
      bySourceId.set(row.source_id, row)
    }
  }

  const seenSourceIds = new Set<string>()
  const inserts: Record<string, unknown>[] = []
  const updates: { id: string; patch: Record<string, unknown> }[] = []

  for (const assignment of assignments) {
    // 同一个 source_id 在一批里重复出现时以第一条为准（去重，避免插入撞唯一索引）。
    if (seenSourceIds.has(assignment.externalId)) continue
    seenSourceIds.add(assignment.externalId)

    const existing = bySourceId.get(assignment.externalId)
    const { submissionState, submittedAt } = deriveSubmission(assignment)
    if (!existing) {
      inserts.push({
        course_id: courseId,
        title: assignment.title,
        due_date: assignment.dueAt,
        task_type: CANVAS_TASK_TYPE,
        source: CANVAS_SOURCE,
        source_id: assignment.externalId,
        status: 'pending',
        is_derived: false,
        external_updated_at: assignment.externalUpdatedAt,
        last_seen_at: now,
        submission_state: submissionState,
        submitted_at: submittedAt,
      })
      continue
    }

    if (hasChanged(existing, assignment)) {
      // ⚠️ 这里刻意没有 status：用户的"已完成"不被同步覆盖（文件头铁律 1）。
      // submission_state / submitted_at 是 Canvas 真相，同步可写（ADR-015）。
      updates.push({
        id: existing.id,
        patch: {
          title: assignment.title,
          due_date: assignment.dueAt,
          external_updated_at: assignment.externalUpdatedAt,
          last_seen_at: now,
          is_deleted: false,
          submission_state: submissionState,
          submitted_at: submittedAt,
        },
      })
    }
  }

  // ---------- 1) 新增 ----------
  let created = 0
  if (inserts.length > 0) {
    const insertResult = await insertNewTasks(supabase, inserts)
    if (!insertResult.ok) {
      return { ok: false, error: insertResult.error }
    }
    created = insertResult.created
  }

  // ---------- 2) 更新（逐条：每行的值都不同，无法批量） ----------
  // 变化的行一般是个位数（作业改名、deadline 调整），串行写换取「断在哪一行是确定的」。
  let updated = 0
  for (const { id, patch } of updates) {
    const { error: updateError } = await supabase
      .from('tasks')
      .update(patch)
      .eq('id', id)
      .eq('course_id', courseId)
      .eq('source', CANVAS_SOURCE)
    if (updateError) {
      return { ok: false, error: updateError.message }
    }
    updated += 1
  }

  // ---------- 3) 软删除缺席的行 ----------
  let deleted = 0
  if (complete) {
    const missingIds = existingRows
      .filter((row) => row.source_id !== null && !seenSourceIds.has(row.source_id) && !row.is_deleted)
      .map((row) => row.id)

    if (missingIds.length > 0) {
      const { error: deleteError } = await supabase
        .from('tasks')
        .update({ is_deleted: true })
        .in('id', missingIds)
        .eq('course_id', courseId)
        .eq('source', CANVAS_SOURCE)
      if (deleteError) {
        return { ok: false, error: deleteError.message }
      }
      deleted = missingIds.length
    }
  }

  return { ok: true, counts: { created, updated, deleted } }
}

/**
 * 批量插入新任务。
 *
 * 撞 `tasks_source_unique` 说明同一门课正被另一次同步并发写入（理论上不该发生：
 * 编排层有 5 分钟锁；但两个标签页、或锁到期后重试都可能撞上）。
 * 这时退化为逐条插入并跳过冲突行 —— 一行撞车不该让整门课的同步失败。
 */
async function insertNewTasks(
  supabase: SupabaseClient,
  inserts: Record<string, unknown>[],
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const { error } = await supabase.from('tasks').insert(inserts)
  if (!error) {
    return { ok: true, created: inserts.length }
  }
  if (error.code !== UNIQUE_VIOLATION) {
    return { ok: false, error: error.message }
  }

  let created = 0
  for (const row of inserts) {
    const { error: oneError } = await supabase.from('tasks').insert(row)
    if (!oneError) {
      created += 1
      continue
    }
    // 并发写入已经建好了这一行：跳过即可，不计数也不报错。
    if (oneError.code === UNIQUE_VIOLATION) continue
    return { ok: false, error: oneError.message }
  }
  return { ok: true, created }
}
