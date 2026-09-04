import {
  COURSE_COLUMNS,
  parseCanvasLinkInput,
  toCanvasCourseIdUpdate,
  toCourse,
} from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { runCanvasSync } from '@/lib/sync/canvas-sync'

/**
 * 课程 ↔ Canvas 课程的关联端点（API-Contract.md 第 6 节，P0-2-4）。
 *
 * POST   关联（写 `courses.canvas_course_id`）
 * DELETE 解除关联（置 null）
 *
 * ### 为什么是"手动关联"而不是自动匹配
 * PRD F4 明确要求：不做自动匹配，避免匹配错误。真人数据里 Math 53 会同时有
 * LEC 与 DIS 两个 id，靠名字自动匹配必错。选哪一个是用户的判断，不是模型的。
 *
 * ### 三处 409（都是"已经关联过了"，但含义不同，文案必须区分）
 * 1. 这门 Tempo 课已经关联了**另一个** Canvas 课 → 提示先解除。
 *    静默覆盖会让用户以为换关联成功了，实际旧关联的同步数据还挂着（P0-2-5）。
 * 2. 这个 Canvas 课已经被**另一门 Tempo 课**关联了 → 提示是哪门课。
 *    一门 Canvas 课挂两门 Tempo 课，同步时作业会被拉两份。
 * 3. 幂等例外：**重复提交同一个 ID 不算冲突**，返回 200 与当前课程。
 *    用户在 UI 上再点一次已关联的项不该看到报错（契约原文"重复关联 → 409"
 *    在这里按"同一个 ID"与"不同 ID"分开处理，见 API-Contract 变更记录）。
 *
 * ### 归档课程
 * 一律 404（ADR-010 + 归档=删除语义）：已归档的课不该还能改关联。
 *
 * ### 关于"关联后触发一次同步"（P0-2-5 已接上）
 * 契约 §6 写了 `POST` 后触发同步，本卡原本刻意留空（"现在硬塞一个空跑的同步调用，
 * 等于给用户一个假的成功信号"）。P0-2-5 有了真正的同步编排，这里补上，但**只同步这一门课**。
 *
 * 三条边界：
 * 1. **同步失败不影响关联结果。** 关联本身已经成功写入，同步的成败由
 *    `courses.sync_status` / `sync_error` 记账（Sync-Strategy §2 S2「失败必须可见」落在那里），
 *    不该让一个已经成功的写操作因为下游失败而回滚或报错。
 * 2. **不做节流。** 用户刚点完关联就被"同步太频繁"拦下是最差的一种体验，
 *    而按课程触发的成本只有一个 Canvas 请求。
 * 3. **不等待它的结果进响应。** 响应体仍是 course 对象（契约形状不变），
 *    同步结果用户下次看课程页的状态区即可 —— 为此让关联按钮多等几秒不值得。
 */

interface RouteContext {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', '课程 ID 格式不正确')
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

    const parsed = parseCanvasLinkInput(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }
    const externalCourseId = parsed.value

    // 先确认这门课存在且未归档（RLS 保证只能读到自己的；归档=删除语义）。
    const { data: current, error: readError } = await supabase
      .from('courses')
      .select(COURSE_COLUMNS)
      .eq('id', id)
      .eq('is_archived', false)
      .maybeSingle()

    if (readError) {
      throw readError
    }
    if (!current) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    const row = current as CourseRow

    // 幂等：已经关联的就是这一门，不写字也不报错。
    if (row.canvas_course_id === externalCourseId) {
      return jsonOk(request, toCourse(row))
    }

    // 冲突 1：这门 Tempo 课已关联别的 Canvas 课。
    if (row.canvas_course_id !== null) {
      return jsonError(
        request,
        409,
        'already_linked',
        '这门课已经关联了另一个 Canvas 课程，请先解除关联',
      )
    }

    // 冲突 2：这个 Canvas 课已被另一门 Tempo 课关联。
    const { data: taken, error: takenError } = await supabase
      .from('courses')
      .select('id, course_name')
      .eq('canvas_course_id', externalCourseId)
      .eq('is_archived', false)
      .neq('id', id)
      .maybeSingle()

    if (takenError) {
      throw takenError
    }
    if (taken) {
      const other = taken as { id: string; course_name: string }
      return jsonError(
        request,
        409,
        'already_linked',
        `这个 Canvas 课程已经关联到「${other.course_name}」，一门 Canvas 课只能关联一门 Tempo 课`,
      )
    }

    const { data, error } = await supabase
      .from('courses')
      .update(toCanvasCourseIdUpdate(externalCourseId))
      .eq('id', id)
      .eq('is_archived', false)
      .select(COURSE_COLUMNS)
      .maybeSingle()

    if (error) {
      throw error
    }
    if (!data) {
      // 并发归档/删除。不猜，让调用方重试。
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    // 关联成功后立刻同步这门课（契约 §6，P0-2-5 接上）。
    // 整体 try/catch：同步的失败不回滚关联，也不改变本端点的响应形状。
    try {
      await runCanvasSync(supabase, user.id, { trigger: 'manual', courseIds: [id] })
    } catch (error) {
      console.error('[canvas-link] 关联后触发同步失败:', id, error)
    }

    return jsonOk(request, toCourse(data as CourseRow))
  } catch (error) {
    return internalError(request, error)
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', '课程 ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { data, error } = await supabase
      .from('courses')
      .update(toCanvasCourseIdUpdate(null))
      .eq('id', id)
      .eq('is_archived', false)
      .select(COURSE_COLUMNS)
      .maybeSingle()

    if (error) {
      throw error
    }
    if (!data) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    // 幂等：本来就没关联（多标签页重复点解除），返回 200 与当前状态，不报错。
    return jsonOk(request, toCourse(data as CourseRow))
  } catch (error) {
    return internalError(request, error)
  }
}
