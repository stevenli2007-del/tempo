import { getCurrentUser, jsonError, jsonOk } from '@/lib/api/response'
import { deleteCourseLink } from '@/lib/course-links/store'

/**
 * `DELETE /api/v1/courses/:id/links/:linkId`（P0-5-3）。
 *
 * 同时按 `course_id` 收口：只删本课程的链接（RLS 再兜一道，越权行连 where 都命中不了）。
 */

interface RouteContext {
  params: Promise<{ id: string; linkId: string }>
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id, linkId } = await params
  const { supabase, user } = await getCurrentUser()
  if (!user) return jsonError(request, 401, 'unauthorized', '请先登录')

  const result = await deleteCourseLink(supabase, id, linkId)
  if (!result.ok) return jsonError(request, 500, result.code, result.message)
  return jsonOk(request, { ok: true, deleted: result.deleted })
}
