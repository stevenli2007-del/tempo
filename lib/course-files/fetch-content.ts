/**
 * 「取一个 Canvas 文件的内容」—— 三件事的**唯一**实现（P0-3-30 抽出）。
 *
 * ### 为什么要有这个文件
 * 3-19b 的「一键总结」与本卡的「syllabus 一键导入」做的是同一件事：
 * 换一条新鲜下载链 → 下载字节 → 抽文本。两处各写一份的后果一定是分叉 ——
 * **"总结能读的文件、导入说不支持"**（或反过来），而这在 `tsc` / `eslint` / `build`
 * 里全绿（CodingRules §10.1 第 21 条那类坑）。
 *
 * ### 🔴 本文件守的三条红线（ADR-026）
 * 1. **只服务按需路径**：调用方必须是"用户刚点了某个文件"。同步路径一个字节都不下。
 * 2. **三道闸门全在发请求之前判**（扩展名 / MIME → 已知大小 → 大小上限）。
 *    不是为了省钱 —— 是为了**不做没意义的外部动作**：图片型文件下载了也抽不出字。
 * 3. **Canvas 的 `url` 是能力凭据**（`?verifier=…`，不带 Authorization 也能取到文件）：
 *    不落库、不下发浏览器、只在本次请求里用完即弃。本文件**不返回它**，
 *    只返回抽出来的文字 —— 从类型上就断掉"顺手存一下"的可能。
 *
 * ### 刻意零依赖（除 `canvasGet` / `extract`）
 * 判定部分（`checkFetchable`）是纯函数，回归脚本可直接断言。
 */

import { canvasGet } from '@/lib/canvas/client'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import { extractSyllabusText } from '@/lib/extract'

import type { ExtractableExtension } from '@/lib/course-files/extractable'

/** 单份材料的下载上限（字节）。实测最大的课件 PDF 约 2.4MB，留一倍余量。 */
export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024

/** 下载超时。再长就该让用户重试，而不是干等。 */
const DOWNLOAD_TIMEOUT_MS = 20_000

/** 闸门判据只需要这几列 —— 与 `course_files` 已有的元数据一一对应。 */
export type FetchableFile = {
  displayName: string
  contentType: string | null
  /**
   * Canvas 给的大小。**null = 不敢下载**：ADR-026 的红线是
   * "发请求前判不了成本就拒绝"，未知大小就是判不了。
   */
  sizeBytes: number | null
}

/**
 * 发请求之前的判定结果。
 *
 * | kind | 含义 | 界面怎么画 | 要不要落"别再重试" |
 * |---|---|---|---|
 * | `ok` | 可以下载 | 正常 | — |
 * | `unsupported` | **Tempo 读不了**（图片 / 未知大小 / 旧版 Office） | 灰掉 + 原因 | **不落**（将来支持了就能用） |
 * | `too_large` | 已知太大 | 灰掉 + 原因 | 不落（但也不会因为文件没变而改判） |
 */
export type FetchGate =
  | { kind: 'ok'; ext: ExtractableExtension }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'too_large'; reason: string }

/**
 * 三道闸门：扩展名 / MIME → 大小已知 → 大小不超限。
 *
 * ⚠️ 顺序不能换：图片型文件**先**被判掉，就永远走不到"下载了才发现抽不出字"。
 */
export function checkFetchable(file: FetchableFile, maxBytes: number = MAX_DOWNLOAD_BYTES): FetchGate {
  const ext = detectExtractableExtension(file.displayName, file.contentType)
  if (!ext) {
    return { kind: 'unsupported', reason: unsupportedReason(file.displayName, file.contentType) }
  }
  if (file.sizeBytes === null) {
    return {
      kind: 'unsupported',
      reason: '这个文件在 Canvas 上没有大小信息 —— 不知道要下多大，Tempo 就不下。',
    }
  }
  if (file.sizeBytes > maxBytes) {
    return {
      kind: 'too_large',
      reason: `文件太大（${formatMb(file.sizeBytes)}），超过 ${formatMb(maxBytes)} 上限。`,
    }
  }
  return { kind: 'ok', ext }
}

/** 下载结果。`permanent` 决定要不要落"别再重试"的标记。 */
export type DownloadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; message: string; permanent: boolean }

/**
 * 下载字节（**不落盘、不入库**，仅在内存里过一遍）。
 *
 * ⚠️ Canvas 的下载链自带能力凭据，所以**不发 Bearer** ——
 * 它是"一个短时有效的下载凭据"，不是"一个要用 token 调 API"。
 */
export async function downloadFile(url: string, maxBytes: number): Promise<DownloadResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })

    if (!response.ok) {
      // 403 / 404：链接过期或文件没了，重试无用 → 确定性。
      const permanent = response.status === 403 || response.status === 404
      return { ok: false, message: `下载失败（Canvas 返回 HTTP ${response.status}）`, permanent }
    }

    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, message: `文件太大（${formatMb(declared)}），超过上限`, permanent: true }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      return { ok: false, message: `文件太大（${formatMb(bytes.byteLength)}），超过上限`, permanent: true }
    }

    return { ok: true, bytes }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      message: aborted ? '下载超时，请稍后重试' : '下载失败（网络问题），请稍后重试',
      // 暂时性：网络与超时下次可能就好了。
      permanent: false,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取新鲜下载链。
 *
 * 🔴 **必须现场换一条**，不能存：那是一条带短时 `verifier` 的能力凭据。
 * 库里存的 `file_url` 是给人点的**预览页**，不是它。
 */
export async function resolveDownloadUrl(params: {
  domain: string
  token: string
  canvasCourseId: string
  canvasFileId: string
}): Promise<{ url: string | null; message: string | null; permanent: boolean }> {
  const result = await canvasGet<{ url?: string }>(
    params.domain,
    params.token,
    `/api/v1/courses/${params.canvasCourseId}/files/${params.canvasFileId}`,
  )

  if (!result.ok) {
    // 401/403 = token 失效（全局问题）；404 = 这个没了（局部问题 → 确定性）。
    const permanent = result.kind === 'not_found'
    return { url: null, message: result.message, permanent }
  }

  if (!result.data.url) {
    // 实测图片类文件会出现"有记录但没给下载链"。
    return { url: null, message: 'Canvas 没有为这个文件提供下载链接', permanent: true }
  }

  return { url: result.data.url, message: null, permanent: false }
}

/** 抽出来的文本（连同"怎么抽的"一起返回，落库那两列要用）。 */
export type FetchedText = {
  text: string
  pageCount: number | null
  method: string
  ext: ExtractableExtension
}

/** 一次完整取内容的结局。**不抛异常**，失败全收敛到 `ok: false`。 */
export type FetchTextOutcome =
  | { ok: true; value: FetchedText }
  /** 确定性失败：同一个文件再试一次还是这样（无文字层 / 链接没了 / 不支持）。 */
  | { ok: false; message: string; permanent: true }
  /** 暂时性失败：网络 / 超时 / Canvas 5xx —— 下次点可能就好了。 */
  | { ok: false; message: string; permanent: false }

/**
 * 「换链 → 下载 → 抽文本」三步合一。
 *
 * 调用方先跑 `checkFetchable()`（那一步在更早的时机、可能还要给 UI 画灰态），
 * 这里**只**负责真的去取。失败二分法沿用 ADR-026 第 5 条。
 */
export async function fetchFileText(params: {
  file: FetchableFile
  ext: ExtractableExtension
  domain: string
  token: string
  canvasCourseId: string
  canvasFileId: string
  maxBytes?: number
}): Promise<FetchTextOutcome> {
  const maxBytes = params.maxBytes ?? MAX_DOWNLOAD_BYTES

  const resolved = await resolveDownloadUrl({
    domain: params.domain,
    token: params.token,
    canvasCourseId: params.canvasCourseId,
    canvasFileId: params.canvasFileId,
  })
  if (!resolved.url) {
    return {
      ok: false,
      message: resolved.message ?? '取下载链接失败',
      permanent: resolved.permanent,
    }
  }

  const download = await downloadFile(resolved.url, maxBytes)
  if (!download.ok) {
    return { ok: false, message: download.message, permanent: download.permanent }
  }

  const extracted = await extractSyllabusText(params.ext, download.bytes)
  if (extracted.status !== 'extracted' || extracted.text === null) {
    // 扫描件 / 图片型 PDF：确定性失败（再抽一次还是空的）。
    return { ok: false, message: extracted.error ?? '这份文件抽不出文字。', permanent: true }
  }

  return {
    ok: true,
    value: {
      text: extracted.text,
      pageCount: extracted.pageCount,
      method: extracted.method ?? params.ext,
      ext: params.ext,
    },
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
