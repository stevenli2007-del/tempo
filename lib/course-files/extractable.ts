/**
 * 「这份文件能不能抽出文字」的**判定**（P0-3-19b）。
 *
 * ### 为什么单独一个零依赖文件
 * 这个判定被**三处**用，且三处必须给出同一个答案：
 * 1. 资料区（`components/courses/course-files.tsx`）—— 决定那个文件还要不要显示「一键总结」；
 * 2. 总结页（`app/(routes)/courses/[id]/files/[fileId]/page.tsx`）—— 决定要不要真的去下载；
 * 3. 回归脚本 —— 断言"没有扩展名但 `content_type` 是 PDF"这类真实情况不会判错。
 *
 * 三处各写一份的后果是**分叉**：按钮画出来了、点进去说"不支持"（或反过来，
 * 明明能抽却不出按钮）—— 而这在 `tsc` / `eslint` / `build` 里全绿（P0-3-15 的同一类坑）。
 *
 * ### 🔴 实测依据（2026-09-18 真账号）
 * 判定**不能只看扩展名**：Chem 1AL 的 `Weekly Review 1 - PDF` 根本没有点后缀，
 * 但 `content_type` 是 `application/pdf`、也能抽（真实存在于库里）。
 * 所以先看后缀、再看 `content_type`。
 *
 * ### 刻意不做的事
 * - **图片（png/jpg）不在这里**：它们没有文字层，得走视觉模型（3-23 的活）。
 *   这里如实返回不支持，而不是硬抽出一个空结果、让用户以为"这份材料没内容"。
 * - **PPTX 支持**：`lib/extract.ts` 已有 `extractPptx()`（从 `ppt/slides/*.xml` 取 `<a:t>`）。
 *   3-19 的卡面写着"本卡不解析 PPTX"，那条**边界针对的是索引路径**（不下载内容）；
 *   按需总结时 PPTX 是**能抽的**，所以这里放行。
 */

/** 抽取器认得的扩展名（与 `lib/extract.ts` 的 `SyllabusExtension` 一致）。 */
export type ExtractableExtension = 'pdf' | 'docx' | 'pptx'

/** `content_type` → 扩展名。只列**确实能抽**的三种。 */
const CONTENT_TYPE_MAP: Record<string, ExtractableExtension> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

/**
 * 判定可抽取的扩展名；抽不了返回 `null`。
 *
 * - `name`：Canvas 上的展示名（可能没有后缀，也可能大小写混杂）。
 * - `contentType`：Canvas 给的 MIME（可能是 `null`，也可能带 `; charset=` 之类参数）。
 */
export function detectExtractableExtension(
  name: string,
  contentType: string | null,
): ExtractableExtension | null {
  const lower = name.toLowerCase()

  // ① 后缀优先。`\.` 起手是必须的：`weekly review - pdf` 这种名字里就有 "pdf" 字面量。
  const byName = /\.(pdf|docx|pptx)$/.exec(lower)
  if (byName) return byName[1] as ExtractableExtension

  // ② 退到 MIME。先剥 `; charset=utf-8` 这类参数、再去空白、再小写。
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase()
    const mapped = CONTENT_TYPE_MAP[mime]
    if (mapped) return mapped
  }

  return null
}

/**
 * 抽不了时给用户的一句话。
 *
 * **必须说清"是 Tempo 不做"而不是"这个文件没内容"** —— 后者是诬告：
 * 用户会以为老师的材料是空的。图片型特别点明原因（要视觉模型）与去处（后续版本）。
 */
export function unsupportedReason(name: string, contentType: string | null): string {
  const lower = name.toLowerCase()
  const ext = /\.([a-z0-9]{1,6})$/.exec(lower)?.[1] ?? null

  if (contentType?.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext ?? '')) {
    return '这是图片，没有文字层 —— Tempo 现在还不能读它（要视觉模型，排在后面的卡里）。'
  }
  if (['pptx', 'ppt', 'key', 'doc', 'pages', 'xlsx', 'xls', 'csv'].includes(ext ?? '')) {
    // 注意：pptx 能抽，走不到这里；能到这里的 ppt/doc/xls 都是**旧版二进制格式**。
    return '这个格式（旧版 Office 二进制文件）Tempo 暂时读不了。'
  }
  if (['mp4', 'mov', 'mp3', 'm4a', 'wav', 'zip', 'ipynb', 'py', 'r', 'java', 'c', 'cpp'].includes(ext ?? '')) {
    return '这不是文档（音视频 / 压缩包 / 代码文件），没有可总结的文字。'
  }
  return '这个文件类型 Tempo 暂时不支持总结。'
}
