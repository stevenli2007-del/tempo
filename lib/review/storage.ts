/**
 * 复习页「上传额外文件」的 Storage 约定与入参校验（P0-3-31）。
 *
 * ### 与 `lib/syllabi.ts` 同一套形态（ADR-009：浏览器直传，文件不经我们服务端）
 * 1. 前端预校验扩展名与大小 —— **只为体验**，不是权威；
 * 2. `POST /api/v1/courses/:id/exams/:examId/review/files` 取上传票据（服务端再校验一遍）；
 * 3. 浏览器 `uploadToSignedUrl(path, token, file)` 直传 Storage；
 * 4. `router.refresh()` 让服务端组件重新取数。
 *
 * ### 🔴 本文件必须保持零依赖（客户端组件直接 import 它做预校验）
 * 一旦 import 服务端模块（`lib/supabase/server` → `next/headers`），
 * 构建期就会把 `next/headers` 拖进客户端图（3-25 / 3-23 踩过的同一个坑）。
 */

/** 私有桶名（见迁移 `20260926000000_exam_review.sql` 的 Storage 段）。 */
export const EXAM_REVIEW_BUCKET = 'exam_review'

/** 允许的类型。以**扩展名**判定，不用 MIME（浏览器给的 MIME 常是 octet-stream，见 Database.md 7.3）。 */
export const REVIEW_ALLOWED_EXTENSIONS = ['pdf', 'docx', 'pptx'] as const
export type ReviewExtension = (typeof REVIEW_ALLOWED_EXTENSIONS)[number]

/** 20MB，与桶的 `file_size_limit` 三者必须一致（桶上限、迁移注释、本常量）。 */
export const REVIEW_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024

const MAX_FILE_NAME_LENGTH = 255

/** 从文件名取扩展名（小写、去首尾空格）；取不到返回 `null`。 */
export function extractExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return null
  return fileName.slice(dot + 1).trim().toLowerCase()
}

export function isAllowedReviewExtension(ext: string): ext is ReviewExtension {
  return (REVIEW_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * 清理文件名：路径分隔符转下划线、控制字符去掉、超长时截**尾部**（从头部截会把扩展名截掉）。
 * 保留空格与连字符（真实文件名里很常见），**不改扩展名**。
 */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.length > MAX_FILE_NAME_LENGTH
    ? cleaned.slice(cleaned.length - MAX_FILE_NAME_LENGTH)
    : cleaned
}

/** 服务端权威校验的结果。ok=false 时直接带 HTTP 状态与错误码，交给 `jsonError`。 */
export type ReviewUploadValidation =
  | { ok: true; value: { fileName: string; ext: ReviewExtension; fileSize: number } }
  | { ok: false; status: 400 | 413 | 415; code: string; message: string }

/**
 * 校验上传入参。
 *
 * ⚠️ **前端也会校验一遍，但那只是为了体验**。这里是唯一权威：
 * 前端上报的 `fileName` / `fileSize` 全不可信，必须重新核。
 */
export function validateReviewUploadInput(body: unknown): ReviewUploadValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, code: 'bad_request', message: '请求体必须是 JSON 对象' }
  }

  const { fileName, fileSize } = body as Record<string, unknown>

  if (typeof fileName !== 'string' || fileName.trim() === '') {
    return { ok: false, status: 400, code: 'bad_request', message: '缺少文件名' }
  }
  if (typeof fileSize !== 'number' || !Number.isFinite(fileSize)) {
    return { ok: false, status: 400, code: 'bad_request', message: '缺少文件大小' }
  }

  const safeName = sanitizeFileName(fileName)

  const ext = extractExtension(safeName)
  if (ext === null || !isAllowedReviewExtension(ext)) {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_file_type',
      message: `只支持 ${REVIEW_ALLOWED_EXTENSIONS.join(' / ')} 格式的文件`,
    }
  }

  if (!Number.isInteger(fileSize) || fileSize <= 0) {
    return { ok: false, status: 400, code: 'bad_request', message: '文件大小不合法' }
  }
  if (fileSize > REVIEW_MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'file_too_large',
      message: `文件不能超过 ${REVIEW_MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
    }
  }

  return { ok: true, value: { fileName: safeName, ext, fileSize } }
}

/**
 * 生成 Storage 对象路径。首段**必须是 uid** —— `storage.objects` 的 RLS 靠它判定归属
 * （跨用户隔离的第二层；第一层是 `exam_review_files` 表的 RLS）。
 */
export function buildReviewStoragePath(
  userId: string,
  courseId: string,
  fileId: string,
  ext: ReviewExtension,
): string {
  return `${userId}/${courseId}/${fileId}.${ext}`
}
