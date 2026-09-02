import path from 'node:path'

import JSZip from 'jszip'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

import type { SyllabusExtension } from '@/lib/syllabi'
import type { ExtractMethod, ExtractStatus } from '@/types/syllabus'

/**
 * syllabus 文本提取管线（P0-1-2）。
 *
 * 输入是文件内容 buffer，输出是「状态 + 文本 + 元数据」，**不碰数据库也不碰网络** ——
 * 取文件、写行是 `POST /api/v1/syllabi/:id/extract` 的事。这样这一层可以单独测。
 *
 * 依赖见 `TechStack.md` 版本矩阵：`pdfjs-dist` 5.4.296 / `mammoth` 1.12.2 / `jszip` 3.10.1。
 *
 * ⚠️ PDF 入口**只能**是 `pdfjs-dist/legacy/build/pdf.mjs`，原因见 `extractPdf()` 上方注释
 * 与 `TechStack.md` 第 2 节的 ⚠️（换回现代构建或换回 `pdf-parse` 都会在生产环境炸）。
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

/**
 * 标准字体数据目录（Helvetica / Times 等非嵌入字体要用到）。
 *
 * 不传 `standardFontDataUrl` 时 pdfjs 每页都会 warn，且缺字体度量可能影响换行位置。
 * 传了但路径不存在也只是 warn（实测仍能抽出文本），所以这里放心传、不做存在性判断。
 */
const STANDARD_FONT_DATA_URL = path.join(
  process.cwd(),
  'node_modules/pdfjs-dist/standard_fonts/',
)

/**
 * PDF 文本提取。
 *
 * ⚠️ 入口必须是 **legacy 构建**：pdfjs 的现代构建（`pdfjs-dist/build/pdf.mjs`）在 Node 下
 * 跑 `getDocument()` 会抛 `ReferenceError: DOMMatrix is not defined`；只有 legacy 构建
 * 自带 `DOMMatrix` polyfill。这是 2026-09-02 生产事故的直接教训 —— 上一版用的
 * `pdf-parse` 死在同一处（它靠 `require('@napi-rs/canvas')` 补 DOMMatrix，canvas
 * 加载失败时只 warn 不赋值，紧接着模块顶层 `new DOMMatrix()` 就崩），
 * 而本地 macOS 装了 23MB 的 `@napi-rs/canvas-darwin-arm64`，本地全绿、线上全红。
 */
async function extractPdf(file: Buffer): Promise<ExtractOutcome> {
  const doc = await getDocument({
    data: new Uint8Array(file),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    isEvalSupported: false, // 不渲染就不需要 eval，多数 serverless 环境也禁用它
    disableFontFace: true, // 同上：不往 document 里注入字体
    useSystemFonts: false,
  }).promise

  try {
    const pages: string[] = []
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      // `items` 里混着有 `str` 的文本片段和只有 `type` 的标记片段（marked content），
      // 后者不承载文字，跳过。`hasEOL` 表示该片段是一行结尾 —— pdfjs 不自带换行符，
      // 不补的话整页会粘成一长条，喂给 LLM 更难解析。
      pages.push(content.items.map((item) => ('str' in item ? toLine(item) : '')).join(''))
    }

    // 扫描件 / 图片型 PDF 拼出来正好是空串，「抽不出文字」的判定天然成立。
    const text = normalizeText(pages.join('\n'))
    if (text === '') return failure(EMPTY_PDF_MESSAGE)

    return {
      status: 'extracted',
      text,
      method: 'pdf_text',
      pageCount: doc.numPages,
      error: null,
    }
  } finally {
    await doc.destroy()
  }
}

/** 按 pdfjs 的 `hasEOL` 补换行。不补的话整页文字会连成一条。 */
function toLine(item: { str: string; hasEOL: boolean }): string {
  return item.hasEOL ? `${item.str}\n` : item.str
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
