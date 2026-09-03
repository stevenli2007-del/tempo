/**
 * Syllabus 的对形状（对外契约，camelCase）。
 *
 * 与 `API-Contract.md` §3 一致。DB 列名一律 snake_case，只出现在 `lib/syllabi.ts`。
 */

import type { ParseSection } from '@/types/parse'
import type { StoredSections } from '@/types/sections'

/** 提取方式。为 null 表示尚未提取。 */
export type ExtractMethod = 'pdf_text' | 'docx' | 'pptx' | 'manual'

/** 文本提取状态（extract）与 LLM 解析状态（parse）是两件事，会分别失败。 */
export type ExtractStatus = 'pending' | 'extracted' | 'failed'
export type ParseStatus = 'pending' | 'processing' | 'completed' | 'failed'

export type Syllabus = {
  id: string
  courseId: string
  /**
   * Storage 对象路径，形如 `{user_id}/{course_id}/{syllabus_id}.pdf`。
   *
   * ⚠️ **不是可直接 fetch 的 URL** —— 桶是私有的，没有永久 URL，
   * 下载时必须现签短时签名 URL（`GET /api/v1/syllabi/:id/download`）。
   * 详见 `Database.md` §3.3 与 §7.3。
   *
   * 名字叫 `filePath` 而 DB 列叫 `file_url`（历史命名，见 `Database.md` §3.3 的澄清）：
   * 这是刻意的 —— 在 `lib/syllabi.ts` 这个唯一映射点把语义纠正过来，
   * 免得后面有人拿它去 `fetch()`。
   */
  filePath: string
  fileName: string
  extractMethod: ExtractMethod | null
  extractStatus: ExtractStatus
  extractError: string | null
  pageCount: number | null
  parseStatus: ParseStatus
  parseError: string | null
  uploadedAt: string
}

/**
 * 直传票据（ADR-009）。
 *
 * 前端拿它调 `supabase.storage.from(bucket).uploadToSignedUrl(path, token, file)`，
 * 文件不经过我们的服务端。token 有效期 2 小时（Supabase 平台固定值）。
 */
export type SyllabusUploadTicket = {
  bucket: string
  path: string
  token: string
  /** 完整的签名上传地址，调试用；前端用 `uploadToSignedUrl(path, token, file)` 即可。 */
  signedUrl: string
}

/** `POST /api/v1/courses/:id/syllabus` 的入参（JSON，不是 multipart —— 见 ADR-009）。 */
export type CreateSyllabusInput = {
  fileName: string
  fileSize: number
}

/** `POST /api/v1/courses/:id/syllabus` 的响应体。 */
export type CreateSyllabusResponse = {
  syllabus: Syllabus
  upload: SyllabusUploadTicket
}

/** `GET /api/v1/syllabi/:id/download` 的响应体。 */
export type SyllabusDownloadUrl = {
  downloadUrl: string
  /** 签名 URL 的过期时刻（ISO 8601）。过期后必须重新请求本接口。 */
  expiresAt: string
}

/** `POST /api/v1/syllabi/:id/extract` 的响应体。 */
export type SyllabusExtractResponse = {
  syllabus: Syllabus
  /**
   * 提取出的文本前 1000 字符，供前端立刻展示"抽出来的东西对不对"。
   *
   * **提取失败时是 `null`**（此时 `syllabus.extractStatus === 'failed'`，
   * 原因在 `syllabus.extractError`）。注意 HTTP 状态仍是 200 ——
   * 文件存下来了，只是读不出文字，不算请求失败。
   */
  previewText: string | null
}

/**
 * `POST /api/v1/syllabi/:id/parse` 与 `/reparse` 的响应体（P0-1-5a）。
 *
 * ⚠️ HTTP 状态**恒为 200**（ADR-012）：五个板块部分失败也照常返回已成功的部分，
 * 「解析失败」这件事体现在 `failedSections` 与 `syllabus.parseStatus` 上，不是 HTTP 错误。
 */
export type SyllabusParseResponse = {
  /** 解析后的 syllabus 行（`parseStatus` / `parseError` 已更新）。 */
  syllabus: Syllabus
  /** 落库后的板块数据。**解析失败的板块没有键**，详见 `types/sections.ts`。 */
  sections: StoredSections
  /** 成功落库的板块名。前端据此决定展示哪几块、哪几块显示"解析失败，请手动补充"。 */
  okSections: ParseSection[]
  failedSections: Array<{ section: ParseSection; code: string; message: string }>
  /** 输入文本的诊断信息。排查"为什么漏抽"的第一手资料。 */
  meta: {
    textLength: number
    truncated: boolean
    promptVersion: string
  }
}
