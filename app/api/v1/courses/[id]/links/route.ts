import { getCurrentUser, jsonError, jsonOk } from '@/lib/api/response'
import { insertCourseLink, listCourseLinks, validateLinkUrl } from '@/lib/course-links/store'

/**
 * `GET|POST /api/v1/courses/:id/links`（P0-5-3）。
 *
 * - GET：列出这门课的监控链接（会话客户端，RLS 只返回当前用户可见的）。
 * - POST：新增一条监控链接。URL 先做 SSRF/协议校验（server 为权威），
 *   入库只存 URL + 待检查状态，原文绝不落库（ADR-026）。
 *
 * 越权无需应用层判断：course_links 的 RLS 经 courses.user_id 收口。
 */

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params
  const { supabase, user } = await getCurrentUser()
  if (!user) return jsonError(request, 401, 'unauthorized', '请先登录')

  const result = await listCourseLinks(supabase, id)
  if (result.error) return jsonError(request, 500, 'db_error', result.error)
  return jsonOk(request, { links: result.links })
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params
  const { supabase, user } = await getCurrentUser()
  if (!user) return jsonError(request, 401, 'unauthorized', '请先登录')

  const body = (await request.json().catch(() => null)) as { url?: unknown; label?: unknown } | null
  const rawUrl = typeof body?.url === 'string' ? body.url : ''
  const rawLabel = typeof body?.label === 'string' ? body.label : null

  const valid = validateLinkUrl(rawUrl)
  if (!valid.ok) return jsonError(request, 400, valid.code, valid.message)

  const result = await insertCourseLink(supabase, {
    courseId: id,
    userId: user.id,
    url: valid.url,
    label: rawLabel,
  })
  if (!result.ok) {
    const status = result.code === 'duplicate' ? 409 : 500
    return jsonError(request, status, result.code, result.message)
  }
  return jsonOk(request, { link: result.link }, 201)
}
