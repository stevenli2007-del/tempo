import { TASK_COLUMNS, loadTaskById, toTask } from '@/lib/tasks'
import type { TaskRow } from '@/lib/tasks'
import { normalizeDueDate } from '@/lib/tasks/manual'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import type { TaskStatus } from '@/types/task'

/**
 * 单条任务端点（API-Contract.md 第 5 节）。
 *
 * PATCH 可改两类字段：
 * - **`status`**（pending / done）：任务状态的唯一入口，**任何来源都可改** —— 这是「标记完成」。
 * - **`title` / `dueDate`**（内容字段）：**只有 `source='manual'` 的任务可改**（P0-3-8b）。
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

    if (presentContentFields.length === 0 && !hasStatus) {
      return jsonError(
        request,
        400,
        'bad_request',
        '请求体必须包含 status（改状态）或 title / dueDate（改内容）',
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
    const update: { status?: TaskStatus; title?: string; due_date?: string | null } = {}

    if (hasStatus) {
      if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as TaskStatus)) {
        return jsonError(request, 400, 'validation_failed', 'status 只能是 pending 或 done')
      }
      update.status = raw.status as TaskStatus
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
    return jsonOk(request, toTask(data as TaskRow, existing.courseName))
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
