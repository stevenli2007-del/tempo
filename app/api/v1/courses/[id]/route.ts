import { COURSE_COLUMNS, parseUpdateCourseInput, toCourse, toCourseUpdate } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'

/**
 * 单个课程端点（API-Contract.md 第 2 节）。
 *
 * PATCH  更新课程元信息
 * DELETE 归档（is_archived = true），不是物理删除
 *
 * ⚠️ 关于 403 的偏离：契约 1.2 要求"资源不属于当前用户返回 403"。
 * 但所有业务表都开着 RLS，别人的课程行在当前会话下根本查不出来，
 * 服务端无法区分"不存在"和"不是你的"。要在应用层区分就得用 service role
 * 绕过 RLS 去探测存在性——那反而制造了一条存在性泄漏的口子，
 * 与 403-not-404 想保护的意图相悖。因此统一返回 404，
 * 文案写成"课程不存在或无权访问"，既不撒谎也不泄漏。
 */


interface RouteContext {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
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

    const parsed = parseUpdateCourseInput(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }

    const { data, error } = await supabase
      .from('courses')
      .update(toCourseUpdate(parsed.value))
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

    // 软删除：只置 is_archived。Database.md 4.4 —— Phase 0 一律软删除。
    const { data, error } = await supabase
      .from('courses')
      .update({ is_archived: true })
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

    // 契约 1.5 规则 2：写操作返回变更后的完整对象，前端不必二次拉取。
    return jsonOk(request, toCourse(data as CourseRow))
  } catch (error) {
    return internalError(request, error)
  }
}
