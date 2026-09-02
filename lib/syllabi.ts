import type {
  CreateSyllabusInput,
  ExtractMethod,
  ExtractStatus,
  ParseStatus,
  Syllabus,
} from '@/types/syllabus'

/**
 * Syllabus 的 DB 行 ↔ 对外对象映射，以及上传校验。
 *
 * 与 `lib/courses.ts` 同构：**这是全项目唯一知道 syllabi 表 DB 列名的地方**。
 * 其余代码一律用 camelCase 的 `Syllabus`，不允许 snake_case 泄漏出去。
 */

/**
 * 查询时显式列出，不用 `*`（契约：字段可控，避免表结构变更悄悄改掉响应形状）。
 *
 * ⚠️ **必须写成字面量字符串，不能 `.join()`** —— 一旦退化成 `string`，
 * supabase-js 就推不出返回行类型，`data` 会被推断成 `GenericStringError`，
 * 只能靠 `as unknown as` 硬转（等于关掉类型检查）。与 `COURSE_COLUMNS` 保持一致。
 */
export const SYLLABUS_COLUMNS =
  'id, course_id, file_url, file_name, extract_method, extract_status, extract_error, page_count, parse_status, parse_error, uploaded_at'

/** syllabi 表在 DB 里的真实形状（snake_case）。只在本文件内使用。 */
export type SyllabusRow = {
  id: string
  course_id: string
  file_url: string
  file_name: string
  extract_method: string | null
  extract_status: string
  extract_error: string | null
  page_count: number | null
  parse_status: string
  parse_error: string | null
  uploaded_at: string
}

// ---------------------------------------------------------------
// 上传校验
// ---------------------------------------------------------------

export const SYLLABUS_BUCKET = 'syllabi'

/** 允许的类型（与 PRD / API-Contract §3 一致）。以扩展名判定，不用 MIME，理由见 Database.md 7.3。 */
export const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'pptx'] as const
export type SyllabusExtension = (typeof ALLOWED_EXTENSIONS)[number]

/** 20MB，与桶的 `file_size_limit` 和 `API-Contract.md` §3 三者必须一致。 */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024

const MAX_FILE_NAME_LENGTH = 255

const EXTRACT_METHODS = new Set<string>(['pdf_text', 'docx', 'pptx', 'manual'])
const EXTRACT_STATUSES = new Set<string>(['pending', 'extracted', 'failed'])
const PARSE_STATUSES = new Set<string>(['pending', 'processing', 'completed', 'failed'])

/**
 * 从文件名取扩展名（小写、去首尾空格）。
 *
 * 取不到（无点、或以点结尾）返回 null —— 由调用方判为 unsupported_file_type。
 */
export function extractExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return null
  return fileName.slice(dot + 1).trim().toLowerCase()
}

export function isAllowedExtension(ext: string): ext is SyllabusExtension {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
}

/** 服务端权威校验的结果。ok=false 时直接带 HTTP 状态与错误码，交给 `jsonError`。 */
export type UploadValidation =
  | { ok: true; value: CreateSyllabusInput & { ext: SyllabusExtension } }
  | { ok: false; status: 400 | 413 | 415; code: string; message: string }

/**
 * 校验上传入参。
 *
 * ⚠️ **前端也会校验一遍，但那只是为了体验**（ADR-009 已把这条写进评审清单）。
 * 这里是唯一权威：前端上报的 fileSize / fileName 全不可信，必须重新核。
 */
export function validateUploadInput(body: unknown): UploadValidation {
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

  // 文件名里的路径分隔符一律去掉：它只用于展示与下载时的 Content-Disposition，
  // 带上目录片段既没有意义，也可能在将来拼路径时出岔子。
  const safeName = sanitizeFileName(fileName)

  const ext = extractExtension(safeName)
  if (ext === null || !isAllowedExtension(ext)) {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_file_type',
      message: `只支持 ${ALLOWED_EXTENSIONS.join(' / ')} 格式的文件`,
    }
  }

  if (!Number.isInteger(fileSize) || fileSize <= 0) {
    return { ok: false, status: 400, code: 'bad_request', message: '文件大小不合法' }
  }
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'file_too_large',
      message: `文件不能超过 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
    }
  }

  return { ok: true, value: { fileName: safeName, fileSize, ext } }
}

/** 控制字符（含 DEL）。文件名里出现这些只可能是伪造或编码事故。用转义写法，不写字面控制字符。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/**
 * 清理文件名：路径分隔符转下划线、控制字符去掉、截断到 255。
 *
 * 保留空格与连字符（真实文件名里很常见），**不改扩展名**（校验依赖它）。
 */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw.replace(/[/\\]/g, '_').replace(CONTROL_CHARS, '').trim()
  // 超长时截尾部而不是截头部 —— 从头部截会把扩展名一起截掉。
  return cleaned.length > MAX_FILE_NAME_LENGTH
    ? cleaned.slice(cleaned.length - MAX_FILE_NAME_LENGTH)
    : cleaned
}

// ---------------------------------------------------------------
// 行 ↔ 对象
// ---------------------------------------------------------------

/**
 * DB 行 → 对外对象。
 *
 * 约束外的枚举值一律**抛错**而不是给兜底值：这些字段会直接渲染成"提取中/失败/解析完成"，
 * 编一个出来就是假数据（CodingRules 7）。DB 有 CHECK 约束，正常不会触发。
 */
export function toSyllabus(row: SyllabusRow): Syllabus {
  return {
    id: row.id,
    courseId: row.course_id,
    filePath: row.file_url,
    fileName: row.file_name,
    extractMethod: toEnum(row.extract_method, EXTRACT_METHODS, 'extract_method') as ExtractMethod | null,
    extractStatus: toEnum(row.extract_status, EXTRACT_STATUSES, 'extract_status') as ExtractStatus,
    extractError: row.extract_error,
    pageCount: row.page_count,
    parseStatus: toEnum(row.parse_status, PARSE_STATUSES, 'parse_status') as ParseStatus,
    parseError: row.parse_error,
    uploadedAt: row.uploaded_at,
  }
}

/** nullable 的枚举列：null 原样返回，非空但不在枚举内则抛错。 */
function toEnum(value: string | null, allowed: Set<string>, column: string): string | null {
  if (value === null) return null
  if (!allowed.has(value)) {
    throw new Error(`syllabi.${column} 出现约束外的取值: ${value}`)
  }
  return value
}

/** 生成 Storage 对象路径。首段必须是 uid —— RLS 靠它判定归属（Database.md 7.3）。 */
export function buildStoragePath(
  userId: string,
  courseId: string,
  syllabusId: string,
  ext: string,
): string {
  return `${userId}/${courseId}/${syllabusId}.${ext}`
}
