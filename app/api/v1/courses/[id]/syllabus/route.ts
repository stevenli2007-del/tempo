import { randomUUID } from 'node:crypto'

import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import {
  SYLLABUS_BUCKET,
  SYLLABUS_COLUMNS,
  buildStoragePath,
  toSyllabus,
  validateUploadInput,
} from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import type { CreateSyllabusResponse } from '@/types/syllabus'

/**
 * `POST /api/v1/courses/:id/syllabus` —— 签发上传票据（两步式直传的第 1 步）。
 *
 * ⚠️ **不是 multipart**（`API-Contract.md` §3 初版写的是 multipart，已按
 * [ADR-009](../Decisions.md#adr-009) 改为两步式 JSON）：
 *   1. 本端点校验类型/大小 → 签发 Storage 签名上传 URL → 建 syllabi 行；
 *   2. 浏览器拿票据直接 `uploadToSignedUrl` 传到 Storage，文件不经过我们的服务端。
 * 这样绕开了平台的请求体上限，20MB 的上限才立得住。
 *
 * 越权判定见 [ADR-010](../Decisions.md#adr-010)：RLS 下无法区分「不存在」与「不是你的」，
 * 统一 404。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id: courseId } = await params
    if (!UUID_PATTERN.test(courseId)) {
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

    // 服务端是唯一权威：前端也会校验一次，但那只是为了体验（ADR-009）。
    const parsed = validateUploadInput(body)
    if (!parsed.ok) {
      return jsonError(request, parsed.status, parsed.code, parsed.message)
    }
    const { fileName, ext } = parsed.value

    // 课程必须是自己的（RLS 保证），且未归档 —— 归档课程不接受新文件。
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('is_archived', false)
      .maybeSingle()

    if (courseError) {
      throw courseError
    }
    if (!course) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    const syllabusId = randomUUID()
    // 路径首段是 uid：storage.objects 的 RLS 靠它判定归属（Database.md 7.3）。
    const storagePath = buildStoragePath(user.id, courseId, syllabusId, ext)

    // 先签票据再建行：签失败就不留悬挂行。
    const { data: ticket, error: signError } = await supabase.storage
      .from(SYLLABUS_BUCKET)
      .createSignedUploadUrl(storagePath)

    if (signError || !ticket) {
      throw signError ?? new Error('createSignedUploadUrl 未返回票据')
    }

    const { data, error } = await supabase
      .from('syllabi')
      .insert({
        id: syllabusId,
        course_id: courseId,
        file_url: storagePath,
        file_name: fileName,
      })
      .select(SYLLABUS_COLUMNS)
      .single()

    if (error) {
      throw error
    }

    const response: CreateSyllabusResponse = {
      syllabus: toSyllabus(data as SyllabusRow),
      upload: {
        bucket: SYLLABUS_BUCKET,
        path: ticket.path,
        token: ticket.token,
        signedUrl: ticket.signedUrl,
      },
    }

    return jsonOk(request, response, 201)
  } catch (error) {
    return internalError(request, error)
  }
}
