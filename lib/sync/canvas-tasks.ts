import { roundToScale, sameNumber } from '@/lib/numbers'
import { sameInstant } from '@/lib/time'
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
 *    `last_seen_at` / `is_deleted` / `submission_state` / `submitted_at` /
 *    `canvas_url` / `points_possible` / `submission_score`，**没有 `status`**。
 *    `submission_state` / `submitted_at` / `submission_score` 是 **Canvas 真相**
 *    （ADR-015：与用户主权的 `status` 分列，展示层合并）；
 *    `canvas_url` / `points_possible` 是**作业本身的静态属性**，也归 Canvas 所有。
 *    新增三个字段（P0-3-17）全部来自**已有的那一个** `include[]=submission` 请求，
 *    不增加任何 Canvas 调用 —— 三级熔断不受影响。
 *
 *    ⚠️ **`score_source = 'manual'` 的行例外（P0-3-34）**：
 *    用户手记的分数不能被同步抹掉 —— 老师没在 Canvas 上登分时 Canvas 的权威值是 `null`，
 *    同步照写就等于把用户刚填的 9.5/10 覆盖回空，界面上「什么都没发生」。
 *    所以这两列（`points_possible` / `submission_score`）在**比较与写入两处**都跳过，
 *    判定收口在 `canvasTaskColumns()` 一个函数里（见下）。
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
/**
 * 外链类（Gradescope 等 LTI）。
 *
 * ⚠️ Canvas **观察不到**外部平台的提交动作，只靠 LTI 成绩回传才知道结果。所以它对这类作业
 * 的任何"未交"信号都是**推断**而非**观察** —— 2026-09-13 用真实 PAT 实测：Chem 1AL
 * 「Lab 1: Airbags」(external_tool, due 9/9) 在 Gradescope 已交，Canvas 仍报 `unsubmitted`。
 * 拿它去显示"待完成/已逾期"就是诬告用户（ADR-013：Canvas 不知道 ≠ 用户没交）。
 *
 * 但**不能反过来一刀切成"待确认"**：那会把已评分的 Homework 1–4 也标成"未知"。
 * 因此按「方向 + 时间」区别对待：
 * - 正信号（graded / submitted / pending_review）照常采信 —— 那是 LTI 回传的事实；
 * - 负信号（unsubmitted / missing）**且已过 due** → 降级 `external_unconfirmed`（展示「待确认」，不诬告）；
 * - 负信号但**还没到期** → 保留 `unsubmitted`（"还没做"这时是可信的，提醒不能被吞掉）。
 */
const EXTERNAL_TOOL_TYPE = 'external_tool'

/**
 * `tasks.score_source` 的「用户手记」取值（P0-3-34，见迁移 `20260927000000`）。
 *
 * 这一行的两个分数列是**用户提供的事实**，同步不但不写，连"变没变"都不比 ——
 * 比了就会报出一次假变化，把 `updated_at` 白白刷新（违反铁律 2）。
 */
const MANUAL_SCORE_SOURCE = 'manual'

/**
 * 把一条 Canvas 作业映射成 Tempo 的提交态（P0-3-10 的"五个分支"全在此收口）。
 *
 * 返回 `submissionState`（落 `tasks.submission_state`）+ `submittedAt`（落 `tasks.submitted_at`）
 * + `submissionScore`（落 `tasks.submission_score`，P0-3-17）。
 * 任何异常形状都降级到最保守值 —— 宁可让用户手勾，也不替他判定"没交"。
 *
 * @param now 本次同步的时刻。**必须传**：同一条 Canvas 数据在"到期前 / 到期后"可信度不同 ——
 *   到期前它说"未交"就是"还没做"（该继续催，那是 Tempo 的本职）；
 *   到期后它还说"未交"就不可信了（见 EXTERNAL_TOOL_TYPE 的实测）。
 *
 * 分支：
 *  ① submission_types 含 none/not_graded/on_paper → null（无完成态，用户手勾）
 *  ② 有内联 submission：
 *       graded → graded；submitted → submitted；pending_review → pending_review
 *       unsubmitted → **external_tool 且已过 due** 则降级 external_unconfirmed（见 EXTERNAL_TOOL_TYPE 注释）；
 *                     其余看 Canvas 的 missing 标记 → missing / unsubmitted
 *  ③ 无内联 submission → external_tool → external_unconfirmed（待确认）；其余 → null
 *
 * ### 🔴 `submissionScore` **不走上面任何分支**（P0-3-17 的刻意设计）
 * 分数是 Canvas 的**独立事实**，与"完成态怎么判"没关系：
 * `on_paper` 的作业老师也可以打分，`not_graded` 也可能有分。
 * 若把它塞进上面的 switch，分支 ① 一短路就会把已经存在的分数丢掉 ——
 * 那才是真的编造信息（把有分显示成没分）。所以分数线**只复制 Canvas 给的值**：
 * 有 submission 就取 `submission.score`，没有就是 null（= 尚未评分，**不是 0 分**）。
 */
export function deriveSubmission(
  assignment: CanvasAssignment,
  now: Date,
): { submissionState: string | null; submittedAt: string | null; submissionScore: number | null } {
  // 分数与分支无关，先算出来（见上方 doc）。
  const submissionScore = assignment.submission ? assignment.submission.score : null

  const types = assignment.submissionTypes
  if (types.some((t) => NO_COMPLETION_TYPES.has(t))) {
    return { submissionState: null, submittedAt: null, submissionScore }
  }

  const submission = assignment.submission
  if (submission) {
    switch (submission.workflowState) {
      case 'graded':
        return { submissionState: 'graded', submittedAt: submission.submittedAt, submissionScore }
      case 'submitted':
        return { submissionState: 'submitted', submittedAt: submission.submittedAt, submissionScore }
      case 'pending_review':
        return { submissionState: 'pending_review', submittedAt: submission.submittedAt, submissionScore }
      case 'unsubmitted': {
        // ⚠️ external_tool 的"未交"是 Canvas 的**推断**（它看不见 Gradescope 里的提交），
        //    实测出现过假阴性（Lab 1: Airbags 已交却报未交）。但**只在已过 due 时才降级** ——
        //    没到期就降级，会把"这周还有一次讨论区小测"这类真提醒一起吞掉（那是 Tempo 的本职）。
        const isOverdue =
          assignment.dueAt !== null && new Date(assignment.dueAt).getTime() < now.getTime()
        if (types.includes(EXTERNAL_TOOL_TYPE) && isOverdue) {
          return { submissionState: 'external_unconfirmed', submittedAt: null, submissionScore }
        }
        // Canvas 自己标记了缺交 → 用 missing 态（区别于普通"未交"）。
        return {
          submissionState: submission.missing ? 'missing' : 'unsubmitted',
          submittedAt: null,
          submissionScore,
        }
      }
      default:
        // deleted / 其他未知态 → 保守当"无记录"。
        return { submissionState: null, submittedAt: null, submissionScore }
    }
  }

  // 没有内联提交记录。
  if (types.includes(EXTERNAL_TOOL_TYPE)) {
    return { submissionState: 'external_unconfirmed', submittedAt: null, submissionScore }
  }
  return { submissionState: null, submittedAt: null, submissionScore }
}

export type CanvasTaskCounts = {
  created: number
  updated: number
  deleted: number
}

export type ApplyCanvasTasksResult =
  | { ok: true; counts: CanvasTaskCounts }
  | { ok: false; error: string }

export type ExistingRow = {
  id: string
  source_id: string | null
  title: string
  due_date: string | null
  external_updated_at: string | null
  is_deleted: boolean
  submission_state: string | null
  submitted_at: string | null
  canvas_url: string | null
  /** `numeric` 列在 JSON 里可能退化成字符串 → 用 `number | string | null`，比较走 `sameNumber()`。 */
  points_possible: number | string | null
  submission_score: number | string | null
  /**
   * 分数来源（P0-3-34）。`'manual'` = 用户手记 → 上面两个分数列同步不写也不比。
   * null 与 `'canvas'` 在同步侧行为完全一样（都可写）。
   */
  score_source: string | null
}

/** 同步读取这三列时用的 select（与 `TASK_COLUMNS` 分开：这里只需要"用来比对"的列）。 */
const EXISTING_COLUMNS =
  'id, source_id, title, due_date, external_updated_at, is_deleted, submission_state, submitted_at, canvas_url, points_possible, submission_score, score_source'

/** 本次同步对一条作业算出的「Canvas 侧字段」集合。 */
export type CanvasTaskFields = {
  submissionState: string | null
  submittedAt: string | null
  /** 已按列标度定标（`roundToScale`），既能直接落库、也能直接与库里读回的值比。 */
  submissionScore: number | null
  pointsPossible: number | null
}

/**
 * 一条 Canvas 作业 → 本次要落库的字段。
 *
 * 🔴 **两个分数在这里先定标，再同时用于比较与写入**（B1：同步不幂等的修法）。
 * 症状是每轮同步都报 `updated N` 而数据其实没变：列是 `numeric(10,2)`，
 * Canvas 却给未定标浮点（实测 `9.923076923076923`）→ 库里读回 `9.92`，
 * 差量判定永远为真 → `updated_at` 被无意义地刷新，失去"这条数据什么时候真变过"的意义。
 * **只在比较端四舍五入不够** —— 那样落库的仍是未定标值，要靠数据库的舍入规则与 JS
 * 一致才能保证下一轮读出同一个数；在边界值上两者并不一致（详见 `lib/numbers.ts`）。
 * 所以走「写入与比较共用同一个已定标值」：收敛由构造保证，不依赖任何舍入约定。
 */
export function toCanvasTaskFields(assignment: CanvasAssignment, now: Date): CanvasTaskFields {
  const { submissionState, submittedAt, submissionScore } = deriveSubmission(assignment, now)
  return {
    submissionState,
    submittedAt,
    submissionScore: roundToScale(submissionScore),
    pointsPossible: roundToScale(assignment.pointsPossible),
  }
}

/** 一处的差异：`field` 是列名，`stored` 是库里的值，`incoming` 是本次算出的值。 */
export type CanvasTaskDiff = { field: string; stored: unknown; incoming: unknown }

/**
 * 这条已存在的行，本次同步到底要写哪些列 → 值。**写入与比较的唯一出处。**
 *
 * ### 为什么必须是"列 → 值"，而不是一份差异列表 + 一份手写 patch
 * 在 P0-3-34 之前，判定（`canvasTaskDiffs`）与写入（`applyCanvasTasks` 里那段固定
 * 10 列的 patch）是**两份**代码：判定说"变了"就把那 10 列照写一遍。
 * 一旦某列需要"按行决定写不写"，两份必然分叉 —— 判定那边跳过了、patch 那边照写，
 * 于是那列还是被覆盖，而且**没有任何测试会红**。
 * 所以把结论收成一个函数：diff 列表与写入 patch 都由它派生。
 *
 * ### 手工分数（P0-3-34）
 * `score_source = 'manual'` 时**不比也不写** `points_possible` / `submission_score`。
 * 老师没在 Canvas 登分时这两列的权威值是 null，同步照写就等于把用户刚记的分抹掉，
 * 而界面上"什么都没发生"。这两列的用户主权属于用户（ADR-015 的同款心态）。
 *
 * ### 其余列的语义（与文件头铁律 1、2 一致）
 * - `is_deleted` 也算变化条件：之前被软删除的行这次又出现了（老师恢复了作业），
 *   必须写一次把它恢复 —— 否则用户会看到"作业回来了但列表里没有"；
 * - **没变的列不进结果** —— 判定与写入天然共用同一份结论，不会出现
 *   "判定了变化却重写一遍没变的列"。
 */
export function canvasTaskColumns(
  existing: ExistingRow,
  incoming: CanvasAssignment,
  next: CanvasTaskFields,
): Record<string, unknown> {
  const columns: Record<string, unknown> = {}
  if (existing.is_deleted) {
    columns.is_deleted = false
  }
  if (existing.title !== incoming.title) {
    columns.title = incoming.title
  }
  if (!sameInstant(existing.due_date, incoming.dueAt)) {
    columns.due_date = incoming.dueAt
  }
  if (!sameInstant(existing.external_updated_at, incoming.externalUpdatedAt)) {
    columns.external_updated_at = incoming.externalUpdatedAt
  }
  if (existing.submission_state !== next.submissionState) {
    columns.submission_state = next.submissionState
  }
  if (!sameInstant(existing.submitted_at, next.submittedAt)) {
    columns.submitted_at = next.submittedAt
  }
  // P0-3-17 的三个字段：老师改了满分、或成绩出来了 → 必须写一次。
  if (existing.canvas_url !== incoming.htmlUrl) {
    columns.canvas_url = incoming.htmlUrl
  }
  // 🔴 手工分数行：这两列归用户 —— 跳过（连比都不比，免得刷出一次假变化）。
  if (existing.score_source !== MANUAL_SCORE_SOURCE) {
    if (!sameNumber(existing.points_possible, next.pointsPossible)) {
      columns.points_possible = next.pointsPossible
    }
    if (!sameNumber(existing.submission_score, next.submissionScore)) {
      columns.submission_score = next.submissionScore
    }
  }
  return columns
}

/**
 * 逐字段列出「哪些列真的变了」。
 *
 * 内容由 `canvasTaskColumns()` 派生，`hasChanged()` 与在线探针
 * （`scripts/probe-sync-idempotent.ts`）都走这一份 —— 探针里再抄一遍判定，
 * 等于"用另一份代码验证这份代码"，验不出真东西。
 */
export function canvasTaskDiffs(
  existing: ExistingRow,
  incoming: CanvasAssignment,
  next: CanvasTaskFields,
): CanvasTaskDiff[] {
  const columns = canvasTaskColumns(existing, incoming, next)
  const stored = existing as unknown as Record<string, unknown>
  return Object.entries(columns).map(([field, value]) => ({
    field,
    // `is_deleted` 的库里值就是 `true`（差异是"它被软删过"），照实取。
    stored: stored[field] ?? null,
    incoming: value,
  }))
}

/** 判断一条已存在的任务是否需要写入。 */
export function hasChanged(
  existing: ExistingRow,
  incoming: CanvasAssignment,
  next: CanvasTaskFields,
): boolean {
  return Object.keys(canvasTaskColumns(existing, incoming, next)).length > 0
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
    .select(EXISTING_COLUMNS)
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

  // 把同步时刻转成 Date 一次，给 deriveSubmission 的「时间闸门」用。
  const nowDate = new Date(now)

  for (const assignment of assignments) {
    // 同一个 source_id 在一批里重复出现时以第一条为准（去重，避免插入撞唯一索引）。
    if (seenSourceIds.has(assignment.externalId)) continue
    seenSourceIds.add(assignment.externalId)

    const existing = bySourceId.get(assignment.externalId)
    // 一次算完，比较与写入共用（`submissionScore` / `pointsPossible` 已定标）。
    const fields = toCanvasTaskFields(assignment, nowDate)
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
        submission_state: fields.submissionState,
        submitted_at: fields.submittedAt,
        canvas_url: assignment.htmlUrl,
        points_possible: fields.pointsPossible,
        submission_score: fields.submissionScore,
      })
      continue
    }

    // 写入与比较共用同一份结论（`canvasTaskColumns`）：patch 里只会出现**真的变了**的列，
    // 且手工分数行不含那两个分数列 —— 两边在构造上不可能分叉（P0-3-34）。
    const columns = canvasTaskColumns(existing, assignment, fields)
    if (Object.keys(columns).length > 0) {
      // ⚠️ 这里刻意没有 status：用户的"已完成"不被同步覆盖（文件头铁律 1）。
      // submission_state / submitted_at / submission_score 是 Canvas 真相，同步可写（ADR-015）。
      updates.push({ id: existing.id, patch: { ...columns, last_seen_at: now } })
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
