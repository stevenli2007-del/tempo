import { TASK_COLUMNS, loadTaskById, toTask } from '@/lib/tasks'
import type { TaskRow } from '@/lib/tasks'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import type { TaskStatus } from '@/types/task'

/**
 * 单条任务端点（API-Contract.md 第 5 节）。
 *
 * PATCH **只允许更新 `status`**（pending / done）—— 这是「标记任务完成」的唯一入口。
 *
 * ### 为什么内容字段一律拒绝
 * - **派生任务**（`isDerived = true`，Phase 0 即 `exam_dates` 生成的考试任务）：
 *   权威源是 `exam_dates`，改 task 的 title / dueDate 会在下次保存/同步时被覆盖回去
 *   （ADR-004）。所以返回 **422 `derived_task_immutable`**，并把用户引导到课程页 ——
 *   这是 ADR-004 在接口层的强制点，不是可选的友好提示。
 * - **非派生任务**：Phase 0 手动任务的编辑（契约 §5 的 POST / DELETE 之外的字段修改）
 *   不在 P0-1-9 范围内，返回 400 明确说"目前只支持改状态"，
 *   **不静默忽略** —— 静默忽略会让前端以为改成功了。
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

/** 有明确语义、用户可能会以为能改、因此必须显式拒绝的字段。 */
const IMMUTABLE_CONTENT_FIELDS = ['title', 'dueDate']

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

    // 先取现有行：既要 is_derived 来决定给 422 还是 400，也要拿到课程名组装响应。
    const { task: existing, error: loadError } = await loadTaskById(supabase, id)
    if (loadError) {
      throw new Error(loadError)
    }
    if (!existing) {
      return jsonError(request, 404, 'not_found', '任务不存在或无权访问')
    }

    const presentContentFields = IMMUTABLE_CONTENT_FIELDS.filter(
      (field) => raw[field] !== undefined,
    )
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
      return jsonError(
        request,
        400,
        'validation_failed',
        '目前只支持修改任务状态（pending / done），暂不支持修改标题或日期',
        { immutableFields: presentContentFields },
      )
    }

    if (raw.status === undefined) {
      return jsonError(request, 400, 'bad_request', '请求体必须包含 status')
    }
    if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as TaskStatus)) {
      return jsonError(request, 400, 'validation_failed', 'status 只能是 pending 或 done')
    }
    const status = raw.status as TaskStatus

    const { data, error } = await supabase
      .from('tasks')
      .update({ status })
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
