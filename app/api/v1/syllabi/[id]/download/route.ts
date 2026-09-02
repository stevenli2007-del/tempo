import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { SYLLABUS_BUCKET, SYLLABUS_COLUMNS } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import type { SyllabusDownloadUrl } from '@/types/syllabus'

/**
 * `GET /api/v1/syllabi/:id/download` —— 签发**短时**下载 URL。
 *
 * 桶 `syllabi` 是私有的，不存在永久可访问的 URL（Database.md 7.3），
 * `syllabi.file_url` 里存的是对象路径而非 URL。所以取文件必须现签现用。
 *
 * 为什么不直接 302 跳到签名 URL：前端用 fetch 拿到 URL 后自行决定打开方式
 * （新标签页 / 下载），比跟随重定向可控，也不会把 Storage 域名暴露给地址栏。
 *
 * 越权判定见 ADR-010：统一 404。
 */

/** 签名有效期（秒）。够用户点开，不够拿来外传。 */
const SIGNED_URL_TTL_SECONDS = 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', 'Syllabus ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    // RLS 已限定只能看到自己课程下的 syllabus，查不到就是不存在或不是自己的。
    const { data, error } = await supabase
      .from('syllabi')
      .select(SYLLABUS_COLUMNS)
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw error
    }
    if (!data) {
      return jsonError(request, 404, 'not_found', 'Syllabus 不存在或无权访问')
    }

    const { file_url: storagePath } = data as SyllabusRow

    const { data: signed, error: signError } = await supabase.storage
      .from(SYLLABUS_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)

    if (signError || !signed) {
      throw signError ?? new Error('createSignedUrl 未返回签名 URL')
    }

    const response: SyllabusDownloadUrl = {
      downloadUrl: signed.signedUrl,
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
    }

    return jsonOk(request, response)
  } catch (error) {
    return internalError(request, error)
  }
}
