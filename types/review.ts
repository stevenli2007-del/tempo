/**
 * 考试复习模式（P0-3-31）的对外契约（camelCase）。
 *
 * 只覆盖"上传/移除额外文件"这两个 API 的形状；复习总结的读取走服务端组件直查 DB
 * （RLS 保护），不对外暴露端点 —— 与资料总结 / 自测卷同一取舍。
 */

/** 一条上传件在接口里的形状（**不含** Storage 路径 —— 那是内部实现）。 */
export type ReviewExtraFileView = {
  id: string
  displayName: string
  contentType: string | null
  sizeBytes: number | null
  /** ISO 8601。 */
  uploadedAt: string
}

/**
 * 直传票据（ADR-009）。
 *
 * 前端拿它调 `supabase.storage.from(bucket).uploadToSignedUrl(path, token, file)`，
 * 文件不经过我们的服务端。token 有效期由 Supabase 平台固定。
 */
export type ReviewUploadTicket = {
  bucket: string
  path: string
  token: string
  /** 完整签名上传地址，调试用。 */
  signedUrl: string
}

/** `POST /api/v1/courses/:id/exams/:examId/review/files` 的响应体。 */
export type CreateReviewFileResponse = {
  file: ReviewExtraFileView
  upload: ReviewUploadTicket
}
