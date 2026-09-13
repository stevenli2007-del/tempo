import { TASK_COLUMNS, loadActiveCourseIds, loadTasks, toTask } from '@/lib/tasks'
import type { TaskRow } from '@/lib/tasks'
import { toInsertRow, validateManualTaskInput } from '@/lib/tasks/manual'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * 任务集合端点（API-Contract.md 第 5 节）。
 *
 * GET 总览页任务列表：跨课程合并，按 dueDate 升序，dueDate 为 null 的排最后。
 *
 * ### 本阶段不返回 `meta.staleWarning` / `meta.lastSuccessfulSyncAt`
 * 契约 §5 的 meta 里有这两个字段，但它们描述的是 **Canvas 同步状态**
 * （`Sync-Strategy.md` 的陈旧告警），Phase 0 的 P0-1-9 只有 syllabus 数据、没有同步这回事。
 * 硬编码 `staleWarning: false` 等于告诉用户"数据很新鲜"，而实际上根本没有同步机制 ——
 * 这是静默的错误数据，比缺字段危险得多（P0-1-7 执行卡里对同一类问题的判断）。
 * 留到 P0-2-7（同步状态）与 P0-2-11（合并 Canvas 数据）再补。
 */

const DEFAULT_RANGE_DAYS = 7
const MAX_RANGE_DAYS = 365
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const RANGE_PATTERN = /^(\d{1,3})d$/

/**
 * `range` → 时间上界。
 *
 * 支持 `7d` / `30d` … / `all`。**只设上界，不设下界** ——
 * 逾期未完成的任务必须留在列表里，它是总览页最该被看见的信号
 * （`lib/tasks.ts` 的 loadTasks 注释有完整理由）。
 */
function parseRange(
  value: string | null,
): { ok: true; until: string | null } | { ok: false; message: string } {
  if (value === null || value === '') {
    return { ok: true, until: new Date(Date.now() + DEFAULT_RANGE_DAYS * 86_400_000).toISOString() }
  }
  if (value === 'all') {
    return { ok: true, until: null }
  }
  const match = RANGE_PATTERN.exec(value)
  if (!match) {
    return { ok: false, message: 'range 只支持 <天数>d（如 7d）或 all' }
  }
  const days = Number(match[1])
  if (days < 1 || days > MAX_RANGE_DAYS) {
    return { ok: false, message: `range 的天数必须在 1 到 ${MAX_RANGE_DAYS} 之间` }
  }
  return { ok: true, until: new Date(Date.now() + days * 86_400_000).toISOString() }
}

/** 非负整数参数（limit / offset）。契约 1.5：limit 默认 50、上限 200。 */
function parseCount(
  value: string | null,
  fallback: number,
  max: number,
  field: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === null || value === '') {
    return { ok: true, value: fallback }
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `${field} 必须是非负整数` }
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `${field} 超出范围` }
  }
  if (parsed > max) {
    return { ok: false, message: `${field} 不能超过 ${max}` }
  }
  return { ok: true, value: parsed }
}

export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const params = new URL(request.url).searchParams

    const range = parseRange(params.get('range'))
    if (!range.ok) {
      return jsonError(request, 400, 'bad_request', range.message)
    }
    const limit = parseCount(params.get('limit'), DEFAULT_LIMIT, MAX_LIMIT, 'limit')
    if (!limit.ok) {
      return jsonError(request, 400, 'bad_request', limit.message)
    }
    // offset 不设上限：它只是起点，真正的约束在 limit 上。
    const offset = parseCount(params.get('offset'), 0, Number.MAX_SAFE_INTEGER, 'offset')
    if (!offset.ok) {
      return jsonError(request, 400, 'bad_request', offset.message)
    }

    const { ids, error: courseError } = await loadActiveCourseIds(supabase)
    if (courseError) {
      throw new Error(courseError)
    }

    const { tasks, total, error } = await loadTasks(supabase, {
      courseIds: ids,
      until: range.until,
      limit: limit.value,
      offset: offset.value,
    })
    if (error) {
      throw new Error(error)
    }

    return jsonOk(request, { data: tasks, meta: { total } })
  } catch (error) {
    return internalError(request, error)
  }
}

/**
 * 创建手动任务（API-Contract.md §5.1：`POST /api/v1/tasks`，`source = manual`）。
 *
 * ### 批量入口
 * 契约写的是「创建手动任务」，对话框一次可能解析出多条，所以请求体是
 * `{ tasks: [...] }`；也兼容直接传单条对象。插入全部以 `source = 'manual'` 落库。
 *
 * ### 🔴 闭环取值（双写入方纪律）
 * 路由层**强制** `source='manual'` / `status='pending'` / `is_derived=false` /
 * `submission_state=null` —— 不接收客户端传这些字段，避免任何绕过纪律的写法。
 * 考试类型被 `validateManualTaskInput` 拒掉（考试权威源是 `exam_dates`，ADR-004）。
 *
 * ### 课程归属
 * 即便 RLS 也会拦，这里仍显式校验 `courseId` 属于当前用户的未归档课程，
 * 早失败、给清晰报错（契约 §2：归档课程的任务对外不可见）。
 */
export async function POST(request: Request) {
  try {
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

    // 兼容单对象 / 数组两种形态。
    const rawItems = Array.isArray((body as Record<string, unknown>).tasks)
      ? ((body as Record<string, unknown>).tasks as unknown[])
      : [body]
    if (rawItems.length === 0) {
      return jsonError(request, 400, 'bad_request', 'tasks 不能为空')
    }
    if (rawItems.length > 50) {
      return jsonError(request, 400, 'bad_request', '一次最多添加 50 条任务')
    }

    const validated = []
    for (const item of rawItems) {
      const result = validateManualTaskInput(item)
      if (!result.ok) {
        return jsonError(request, 400, 'validation_failed', result.message)
      }
      validated.push(result.value)
    }

    // 课程归属：只接受当前用户未归档的课程。
    const { ids, error: courseError } = await loadActiveCourseIds(supabase)
    if (courseError) {
      throw new Error(courseError)
    }
    const owned = new Set(ids)
    for (const v of validated) {
      if (!owned.has(v.courseId)) {
        return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
      }
    }

    const rows = validated.map(toInsertRow)
    const { data, error } = await supabase
      .from('tasks')
      .insert(rows)
      .select(TASK_COLUMNS)

    if (error) {
      throw new Error(error.message)
    }

    // 插入响应不含课程名：课程数很少，单独取一次名映射即可（与 loadTasks 同思路）。
    const courseIds = [...new Set(validated.map((v) => v.courseId))]
    const { data: nameRows, error: nameError } = await supabase
      .from('courses')
      .select('id, course_name')
      .in('id', courseIds)
    if (nameError) {
      throw new Error(nameError.message)
    }
    const nameMap = new Map<string, string>(
      (nameRows ?? []).map((r) => [r.id as string, r.course_name as string]),
    )

    const tasks = ((data ?? []) as TaskRow[]).map((row) =>
      toTask(row, nameMap.get(row.course_id) ?? ''),
    )
    return jsonOk(request, { data: tasks }, 201)
  } catch (error) {
    return internalError(request, error)
  }
}
