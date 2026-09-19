import { randomUUID } from 'node:crypto'

import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { normalizeExamName } from '@/lib/course-update/exam-match'
import { insertExamExtraFile } from '@/lib/review/store'
import {
  EXAM_REVIEW_BUCKET,
  buildReviewStoragePath,
  validateReviewUploadInput,
} from '@/lib/review/storage'
import type { CreateReviewFileResponse } from '@/types/review'

/**
 * `POST /api/v1/courses/:id/exams/:examId/review/files` —— 签发上传票据（两步式直传的第 1 步）。
 *
 * 与 `POST /api/v1/courses/:id/syllabus`（ADR-009）同一形态：
 *   1. 本端点校验类型/大小 → 签发 Storage 签名上传 URL → 建 `exam_review_files` 行；
 *   2. 浏览器拿票据直接 `uploadToSignedUrl` 传到 Storage，文件不经过我们的服务端。
 *
 * ### 🔴 归属判两次
 * ① `exam_dates` 行经 RLS 查（别人的考试查不到 → 404，ADR-010 统一 404 语义）；
 * ② 再校验 `exam.course_id === :id` —— URL 里的课程与考试真实归属不符时 404
 *    （防 `/courses/<自己的课>/exams/<别人的考试 id>/…` 这种拼出来的越权）。
 *
 * ### 为什么行先建、上传后传
 * 与 syllabus 一致：**先签票据再建行**，签失败就不留悬挂行。
 * 但浏览器上传可能失败 → 客户端拿到参数错误时会调 `DELETE` 清掉这一行（见上传组件）。
 */

interface RouteContext {
  params: Promise<{ id: string; examId: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id: courseId, examId } = await params
    if (!UUID_PATTERN.test(courseId) || !UUID_PATTERN.test(examId)) {
      return jsonError(request, 400, 'bad_request', '课程或考试 ID 格式不正确')
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
    const parsed = validateReviewUploadInput(body)
    if (!parsed.ok) {
      return jsonError(request, parsed.status, parsed.code, parsed.message)
    }
    const { fileName, ext, fileSize } = parsed.value
    const contentType =
      typeof (body as Record<string, unknown>).contentType === 'string'
        ? ((body as Record<string, unknown>).contentType as string)
        : null

    // 考试必须是自己的（RLS），且属于 URL 里那门课。
    const { data: exam, error: examError } = await supabase
      .from('exam_dates')
      .select('id, course_id, exam_name')
      .eq('id', examId)
      .maybeSingle()

    if (examError) {
      throw examError
    }
    const examRow = exam as { id: string; course_id: string; exam_name: string } | null
    if (!examRow || examRow.course_id !== courseId) {
      return jsonError(request, 404, 'not_found', '考试不存在或无权访问')
    }

    const examKey = normalizeExamName(examRow.exam_name)
    if (examKey === '') {
      return jsonError(
        request,
        400,
        'bad_request',
        '这场考试的名字识别不出来（只有符号或空白），无法保存复习内容',
      )
    }

    const fileId = randomUUID()
    // 路径首段是 uid：storage.objects 的 RLS 靠它判定归属（跨用户隔离的第二层）。
    const storagePath = buildReviewStoragePath(user.id, courseId, fileId, ext)

    // 先签票据再建行：签失败就不留悬挂行。
    const { data: ticket, error: signError } = await supabase.storage
      .from(EXAM_REVIEW_BUCKET)
      .createSignedUploadUrl(storagePath)

    if (signError || !ticket) {
      throw signError ?? new Error('createSignedUploadUrl 未返回票据')
    }

    const inserted = await insertExamExtraFile({
      supabase,
      id: fileId,
      courseId,
      userId: user.id,
      examKey,
      examLabel: examRow.exam_name,
      displayName: fileName,
      storagePath,
      contentType,
      sizeBytes: fileSize,
    })
    if (inserted.error || !inserted.file) {
      throw new Error(`exam_review_files 插入失败: ${inserted.error ?? '未知原因'}`)
    }

    const response: CreateReviewFileResponse = {
      file: {
        id: inserted.file.id,
        displayName: inserted.file.displayName,
        contentType: inserted.file.contentType,
        sizeBytes: inserted.file.sizeBytes,
        uploadedAt: inserted.file.createdAt,
      },
      upload: {
        bucket: EXAM_REVIEW_BUCKET,
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
