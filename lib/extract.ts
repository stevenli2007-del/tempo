import JSZip from 'jszip'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

import type { SyllabusExtension } from '@/lib/syllabi'
import type { ExtractMethod, ExtractStatus } from '@/types/syllabus'

/**
 * syllabus 文本提取管线（P0-1-2）。
 *
 * 输入是文件内容 buffer，输出是「状态 + 文本 + 元数据」，**不碰数据库也不碰网络** ——
 * 取文件、写行是 `POST /api/v1/syllabi/:id/extract` 的事。这样这一层可以单独测。
 *
 * 依赖见 `TechStack.md` 版本矩阵：`pdf-parse` 2.4.5 / `mammoth` 1.12.2 / `jszip` 3.10.1。
 */

export type ExtractOutcome = {
  /** `failed` 时其余字段为 null（除 `error`）。HTTP 状态仍是 200 —— 文件存下来了，只是抽不出文字。 */
  status: ExtractStatus
  text: string | null
  method: ExtractMethod | null
  /** 只有 PDF 有页数概念，docx / pptx 一律 null。 */
  pageCount: number | null
  error: string | null
}

/** 预览文本长度（`previewText`）。给前端冷启动展示用，不喂 LLM。 */
export const PREVIEW_TEXT_LENGTH = 1000

const EMPTY_PDF_MESSAGE =
  '这份 PDF 里没有可提取的文字层，可能是扫描件或图片型 PDF。请手动补充课程信息。'
const EMPTY_OFFICE_MESSAGE = '这个文件里没有可提取的文字。请手动补充课程信息。'

/**
 * 按扩展名分派提取器。
 *
 * 扩展名在上传时就校验过（`lib/syllabi.ts` 的 `validateUploadInput`），
 * 所以这里的 `ext` 一定是三者之一，不需要再判白名单。
 */
export async function extractSyllabusText(
  ext: SyllabusExtension,
  file: Buffer,
): Promise<ExtractOutcome> {
  try {
    switch (ext) {
      case 'pdf':
        return await extractPdf(file)
      case 'docx':
        return await extractDocx(file)
      case 'pptx':
        return await extractPptx(file)
    }
  } catch (error) {
    // 提取器抛错 ≠ HTTP 错误：文件是存下来了，只是这份读不出文字。
    // 原因要存进 extract_error 让用户看见（CodingRules 7 失败可见性）。
    return failure(describeError(error))
  }
}

// ---------------------------------------------------------------
// PDF
// ---------------------------------------------------------------

async function extractPdf(file: Buffer): Promise<ExtractOutcome> {
  // v2 是类式 API：`new PDFParse({ data }).getText()`。v1 的 `pdfParse(buffer)` 已废弃。
  const parser = new PDFParse({ data: new Uint8Array(file) })
  try {
    const result = await parser.getText()

    // ⚠️ **不要用 `result.text`** —— pdf-parse 2.x 会在每页之间注入
    // `-- N of M --` 分页标记（`"\n\n-- 1 of 6 --\n\n"`）。那段标记会一路带进
    // P0-1-3 的 LLM 输入里，属于纯噪声。
    // `result.pages` 是干净的逐页文本，拼起来即可；扫描件拼出来正好是空串，
    // 「抽不出文字」的判定因此天然成立（用 `result.text` 判空会永远判不出来）。
    const raw = result.pages.map((page) => page.text).join('\n')
    const text = normalizeText(raw)

    if (text === '') return failure(EMPTY_PDF_MESSAGE)

    return {
      status: 'extracted',
      text,
      method: 'pdf_text',
      pageCount: result.total,
      error: null,
    }
  } finally {
    // pdfjs 会起 worker，不 destroy 会漏。失败路径也要走到这里。
    await parser.destroy()
  }
}

// ---------------------------------------------------------------
// docx
// ---------------------------------------------------------------

async function extractDocx(file: Buffer): Promise<ExtractOutcome> {
  // 用 extractRawText 而不是 convertToHtml：我们要的是纯文本，
  // 转 HTML 还得再剥一层标签，多一次失真。
  const result = await mammoth.extractRawText({ buffer: file })
  const text = normalizeText(result.value)

  if (text === '') return failure(EMPTY_OFFICE_MESSAGE)

  return { status: 'extracted', text, method: 'docx', pageCount: null, error: null }
}

// ---------------------------------------------------------------
// pptx
// ---------------------------------------------------------------

/** 只取正式幻灯片。同名目录下的 notesSlide / slideLayout 等不算内容。 */
const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/

/** `<a:t>` 是 DrawingML 里唯一承载真实文字的元素。 */
const TEXT_RUN = /<a:t>([\s\S]*?)<\/a:t>/g

async function extractPptx(file: Buffer): Promise<ExtractOutcome> {
  const zip = await JSZip.loadAsync(file)

  // 按文件名里的数字排序，而不是按 zip 内的字典序 ——
  // slide10.xml 在字典序里会排在 slide2.xml 前面，页面顺序就乱了。
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, index: Number(SLIDE_PATH.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isInteger(entry.index))
    .sort((a, b) => a.index - b.index)

  if (slides.length === 0) return failure(EMPTY_OFFICE_MESSAGE)

  const chunks: string[] = []
  for (const slide of slides) {
    const xml = await zip.files[slide.name].async('string')
    for (const match of xml.matchAll(TEXT_RUN)) {
      chunks.push(decodeXmlEntities(match[1]))
    }
  }

  const text = normalizeText(chunks.join('\n'))
  if (text === '') return failure(EMPTY_OFFICE_MESSAGE)

  return { status: 'extracted', text, method: 'pptx', pageCount: null, error: null }
}

// ---------------------------------------------------------------
// 工具
// ---------------------------------------------------------------

/**
 * 归一化：统一换行、压掉连续空行、去首尾空白。
 *
 * 连续空行要压，是因为后面整段要喂给 LLM（P0-1-3）—— 空行不携带信息，
 * 但会实打实吃掉 token。
 */
function normalizeText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** XML 里的文字可能带实体，不还原会直接出现 `&amp;` 这种字面量。 */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function failure(error: string): ExtractOutcome {
  return { status: 'failed', text: null, method: null, pageCount: null, error }
}

/**
 * 把异常转成给人看的一句话。
 *
 * 不回传堆栈：`extract_error` 会直接渲染给用户，而且堆栈可能含服务端路径。
 * 原始错误只进 `console.error`（由调用方记）。
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine === ''
    ? '提取失败，原因未知。请手动补充课程信息。'
    : `提取失败：${oneLine}`
}

/** 截取预览文本。`text` 为 null 时返回 null（提取失败就没有预览）。 */
export function buildPreviewText(text: string | null): string | null {
  if (text === null) return null
  return text.slice(0, PREVIEW_TEXT_LENGTH)
}
