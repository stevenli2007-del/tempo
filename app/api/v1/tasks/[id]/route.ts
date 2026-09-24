import { TASK_COLUMNS, loadTaskById, toTask } from '@/lib/tasks'
import type { TaskRow } from '@/lib/tasks'
import { normalizeDueDate } from '@/lib/tasks/manual'
import { normalizeScoreInput } from '@/lib/tasks/score'
import { isEffectivelyDone } from '@/lib/tasks/progress'
import { awardNotesForDone } from '@/lib/notes/store'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import type { TaskScoreSource, TaskStatus } from '@/types/task'

/**
 * 单条任务端点（API-Contract.md 第 5 节）。
 *
 * PATCH 可改三类字段：
 * - **`status`**（pending / done）：任务状态的唯一入口，**任何来源都可改** —— 这是「标记完成」。
 * - **`title` / `dueDate`**（内容字段）：**只有 `source='manual'` 的任务可改**（P0-3-8b）。
 * - **`score`**（`{ score, possible }`，或 `null` 清除）：手记分数（P0-3-34），**任何来源都可改**。
 *
 * ### 🔴 为什么内容字段按 `source` 分准入（P0-3-8b）
 * 每个来源有各自的权威源，绕过去改 = 造一个下次同步就被覆盖的假相：
 * - **派生任务**（`isDerived = true`，即 `exam_dates` 生成的考试任务）：权威源是
 *   `exam_dates`，改 task 会在下次保存/同步时被覆盖回去（ADR-004）。返回
 *   **422 `derived_task_immutable`** 并把用户引导到课程页 —— 这是 ADR-004 的接口层强制点。
 * - **`source='canvas'`**：内容真相在 Canvas，改 task 会被下次同步覆盖（ADR-015 同源心态）。
 *   返回 **422 `source_not_editable`**，引导用户去 Canvas 改、或等同步自动更新。
 * - **`source='manual'`**：真相就在 Tempo，用户主权 → **允许直接改**。
 *
 * 这样"改日期"这类诉求就不会出现「改了又被同步改回」的最难查的一类 bug。
 *
 * ### 🔴 为什么 `score` **不**按 `source` 分准入（P0-3-34）
 * 分数与标题 / 日期不是一类东西：标题与日期的**真相在 Canvas**，绕过去改就是造一个
 * 下次同步被覆盖的假相；而「老师只把分登在 Gradescope 上」时，Canvas 那两列的真相
 * 就是空的 —— 分数是**用户提供的事实**，属于用户主权那一侧（ADR-015）。
 * 所以它与 `status` 同级：任何来源都可写；写的同时打上 `score_source='manual'`，
 * 由同步侧跳过这两列（否则下一轮同步会把它抹回 null，见 P0-3-34 卡面「最大坑」）。
 *
 * ### 关于 404
 * 不存在 / 不属于当前用户 / **所在课程已归档** 三种情况统一 404（ADR-010）。
 * 归档课程的判断在 `loadTaskById()` 里（tasks 的 RLS 不看 `is_archived`）。
 */

interface RouteContext {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>
}

const STATUSES: TaskStatus[] = ['pending', 'done']

/** 可编辑的内容字段（**仅限 `source='manual'`**）。其余来源的编辑显式拒绝，不静默忽略。 */
const CONTENT_FIELDS = ['title', 'dueDate'] as const

const TITLE_MAX = 500

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', '任务 ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }
    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }
    const raw = body as Record<string, unknown>

    // 先取现有行：既要 is_derived / source 来决定内容字段的准入（422 哪种码），
    // 也要拿到课程名组装响应。
    const { task: existing, error: loadError } = await loadTaskById(supabase, id)
    if (loadError) {
      throw new Error(loadError)
    }
    if (!existing) {
      return jsonError(request, 404, 'not_found', '任务不存在或无权访问')
    }

    const presentContentFields = CONTENT_FIELDS.filter((field) => raw[field] !== undefined)
    const hasStatus = raw.status !== undefined
    /** 手记分数（P0-3-34）：`{ score, possible }` 对象，或 `null` 表示清除。 */
    const hasScore = raw.score !== undefined

    if (presentContentFields.length === 0 && !hasStatus && !hasScore) {
      return jsonError(
        request,
        400,
        'bad_request',
        '请求体必须包含 status（改状态）、score（记分数）或 title / dueDate（改内容）',
      )
    }

    // 内容字段准入：派生任务 422（ADR-004），非手动任务 422（会被同步覆盖）。
    if (presentContentFields.length > 0) {
      if (existing.isDerived) {
        return jsonError(
          request,
          422,
          'derived_task_immutable',
          '这条任务是从考试日期自动生成的，不能在这里改标题或日期 —— 请到该课程详情页的「考试日期」板块修改，任务会自动跟着更新',
          { immutableFields: presentContentFields },
        )
      }
      if (existing.source !== 'manual') {
        return jsonError(
          request,
          422,
          'source_not_editable',
          '这条任务来自 Canvas 同步，在这里改会被下次同步覆盖 —— 请在 Canvas 侧修改，或等 Tempo 同步自动更新。Tempo 只允许直接编辑手动添加的任务',
          { source: existing.source, immutableFields: presentContentFields },
        )
      }
    }

    // 只组装请求里真实出现的字段，避免把没传的字段误写成 null。
    const update: {
      status?: TaskStatus
      title?: string
      due_date?: string | null
      submission_score?: number | null
      points_possible?: number | null
      score_source?: TaskScoreSource | null
    } = {}

    if (hasStatus) {
      if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as TaskStatus)) {
        return jsonError(request, 400, 'validation_failed', 'status 只能是 pending 或 done')
      }
      update.status = raw.status as TaskStatus
    }

    if (hasScore) {
      // 与 status 同为「用户主权」那一侧，所以**不看 source**（理由见文件头）。
      // ⚠️ 派生任务（考试）也放行：考试的分数同样是用户提供的事实，而
      //    `syncExamToTask()` 只写 title / due_date，不会碰这两列。
      //    已知边界：syllabus 重解析会把考试行连同派生任务**重建**，那上面的手记分数会丢
      //    （与 P0-3-31 复习数据「按 id 存会静默丢」同源）。这里如实记着，不藏。
      if (raw.score === null) {
        // 清除手记 → 三列一起置空，把这两列的权威交还给 Canvas（下一轮同步会重新填）。
        update.submission_score = null
        update.points_possible = null
        update.score_source = null
      } else {
        const parsed = normalizeScoreInput(raw.score)
        if (!parsed.ok) {
          return jsonError(request, 400, 'validation_failed', parsed.message)
        }
        update.submission_score = parsed.value.score
        update.points_possible = parsed.value.possible
        // 🔴 这个标记就是同步侧的闸：见 `canvasTaskColumns()`。
        update.score_source = 'manual'
      }
    }

    if (presentContentFields.includes('title')) {
      if (typeof raw.title !== 'string' || raw.title.trim() === '') {
        return jsonError(request, 400, 'validation_failed', 'title 不能为空')
      }
      update.title = raw.title.trim().slice(0, TITLE_MAX)
    }

    if (presentContentFields.includes('dueDate')) {
      const due = normalizeDueDate(raw.dueDate)
      if (!due.ok) {
        return jsonError(request, 400, 'validation_failed', due.message)
      }
      update.due_date = due.value
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(update)
      .eq('id', id)
      .select(TASK_COLUMNS)
      .maybeSingle()

    if (error) {
      throw error
    }
    if (!data) {
      // 与上面同一个原因：并发归档 / 越权，RLS 让行查不出来。
      return jsonError(request, 404, 'not_found', '任务不存在或无权访问')
    }

    // 课程名沿用读到的那份：update 的响应里没有它，而这门课刚刚已被确认未归档。
    const updated = toTask(data as TaskRow, existing.courseName)

    /**
     * 音符（P0-5-4）——**记入点之一**：用户亲手标记完成，当场记一枚。
     *
     * - 判据只有 `isEffectivelyDone()`（在 `awardNotesForDone` 内部），这里**不另写**
     *   `status === 'done'`：那样"手勾的给、Canvas 判的不给"就成了两套口径，
     *   而用户在同一个界面上看到的是同一个勾选框。
     * - 幂等由主键 `(user_id, task_id)` 兜底：重复点同一个勾不会重复计（验收 ②）。
     * - 取消勾选**不回退**：倒扣就是惩罚，ADR-016 R5 禁止。
     *
     * 🔴 记入失败**不回滚**这次状态更新：状态是用户刚做的动作，音符是它的回声 ——
     * 让回声盖掉动作是颠倒主次。但必须留日志，不能静默（CodingRules 7）。
     * 下一次打开总览页的懒补会把这一枚补回来。
     */
    if (isEffectivelyDone(updated)) {
      const notes = await awardNotesForDone(supabase, user.id, [updated])
      if (notes.error) {
        console.error('[notes] 记入失败', { taskId: id, reason: notes.error })
      }
    }

    return jsonOk(request, updated)
  } catch (error) {
    return internalError(request, error)
  }
}

/**
 * 删除任务（API-Contract.md §5.1：`DELETE /api/v1/tasks/:id`）。
 *
 * ### 🔴 只允许删手动任务
 * 同步来的任务（Canvas / 大纲派生）如果被用户删掉，下次同步又会被重新拉回来，
 * 等于「删了个寂寞」还制造困惑。所以 `source !== 'manual'` 一律拒绝，
 * 明确告诉用户「这事儿得去源头（Canvas / 课程页）处理」。
 *
 * ### 软删除
 * 置 `is_deleted = true`，不物理删除（与全表约定一致，Database.md 4.4）。
 * 已软删的行 `loadTaskById` 查不到 → 重复删除返回 404（幂等）。
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', '任务 ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { task, error: loadError } = await loadTaskById(supabase, id)
    if (loadError) {
      throw new Error(loadError)
    }
    if (!task) {
      return jsonError(request, 404, 'not_found', '任务不存在或无权访问')
    }

    if (task.source !== 'manual') {
      return jsonError(
        request,
        400,
        'validation_failed',
        '只有手动添加的任务可以删除；来自 Canvas / 大纲的任务会随同步刷新，无法在此删除',
      )
    }

    const { error } = await supabase.from('tasks').update({ is_deleted: true }).eq('id', id)
    if (error) {
      throw new Error(error.message)
    }

    return jsonOk(request, { data: { id, deleted: true } })
  } catch (error) {
    return internalError(request, error)
  }
}
