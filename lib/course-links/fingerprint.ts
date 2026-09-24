/**
 * 链接抓取文本 → 分段归一化指纹（P0-5-3）。
 *
 * 🔴 **ADR-026 底线**：本模块**只产出指纹**，绝不产出可还原原文的存储结构。
 * `fingerprint` 是「每段一个 `{label, hash}`」的数组：
 * - `hash`：该段正文的 sha256（不可逆，比对用）。
 * - `label`：该段前 ~60 字的**简短锚点**——只为人话地说"哪块变了"，不是内容本身。
 *
 * 原文（完整 fetched 文本）在 `lib/ingest/url-fetch.ts` 的内存里走完这一程后即丢弃，
 * 不落库、不落盘、不进日志。这里收尾的产物是唯一允许持久化的东西。
 *
 * 比对用**按段索引对齐**（不是按 label 匹配）：第 N 段 hash 变了 → "第 N 段内容更新"；
 * 尾部多出来的 → "新增"；尾部少掉的 → "移除"。这样"哪块变了"稳定且可读，
 * 不受段落内文字微调导致 label 漂移的影响。
 */

import { createHash } from 'node:crypto'

/** 单个指纹段。 */
export type LinkSegment = { label: string; hash: string }

/** 一条链接的指纹 = 有序的段数组（null = 还没成功抓过，待首次检查）。 */
export type LinkFingerprint = LinkSegment[]

/** 单段最长字符数：超过就切分，让一处小改动只影响局部，不至于整段指纹全变。 */
const MAX_SEGMENT_CHARS = 800
/** 段数上限：防极端长页把指纹撑爆（覆盖率的证据，不是全文）。 */
const MAX_SEGMENTS = 80
/** label 锚点最大字符数（人话摘要，不是内容）。 */
const LABEL_MAX_CHARS = 60

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 折叠空白：CRLF→LF、去首尾空白、合并连续空行。 */
function normalizeText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const collapsed: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' && collapsed[collapsed.length - 1] === '') continue
    collapsed.push(line)
  }
  return collapsed.join('\n').trim()
}

/** 段落前 ~60 字作为简短锚点（换行压成空格，截断并补省略号）。 */
function makeLabel(block: string): string {
  const oneLine = block.replace(/\s+/g, ' ').trim()
  return oneLine.length > LABEL_MAX_CHARS
    ? `${oneLine.slice(0, LABEL_MAX_CHARS)}…`
    : oneLine
}

function makeSegment(block: string): LinkSegment {
  return { label: makeLabel(block), hash: sha256(block) }
}

/**
 * 把抓取到的正文切成有序指纹段。
 *
 * 切分单位 = 空行分隔的「段落」；段落超过 `MAX_SEGMENT_CHARS` 再按定长切，
 * 让一处小改动局部化。段数封顶 `MAX_SEGMENTS`。
 */
export function segmentText(text: string): LinkFingerprint {
  const normalized = normalizeText(text)
  if (normalized === '') return []

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  const segments: LinkFingerprint = []
  for (const block of blocks) {
    if (block.length > MAX_SEGMENT_CHARS) {
      for (let i = 0; i < block.length; i += MAX_SEGMENT_CHARS) {
        segments.push(makeSegment(block.slice(i, i + MAX_SEGMENT_CHARS)))
      }
    } else {
      segments.push(makeSegment(block))
    }
    if (segments.length >= MAX_SEGMENTS) break
  }
  return segments
}

export type FingerprintDiff = {
  /** 同位置段 hash 变了（内容更新）。存**新**段的 label（给人话预览）。 */
  changed: string[]
  /** 尾部多出来的段。 */
  added: string[]
  /** 尾部少掉的段（旧 label）。 */
  removed: string[]
}

/**
 * 比对新旧指纹（按段索引对齐）。
 *
 * `oldFp` 为 null（还没基线）→ 返回全空，调用方应**只记基线、不发消息**
 * （否则首次检查就会误报"变了"）。
 */
export function diffFingerprints(
  oldFp: LinkFingerprint | null,
  newFp: LinkFingerprint,
): FingerprintDiff {
  if (!oldFp || oldFp.length === 0) {
    return { changed: [], added: [], removed: [] }
  }
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []

  const n = Math.max(oldFp.length, newFp.length)
  for (let i = 0; i < n; i += 1) {
    const prev = oldFp[i]
    const next = newFp[i]
    if (prev && next) {
      if (prev.hash !== next.hash) changed.push(next.label)
    } else if (next && !prev) {
      added.push(next.label)
    } else if (prev && !next) {
      removed.push(prev.label)
    }
  }
  return { changed, added, removed }
}

/** 把 diff 摊平成消息栏的 details 行（人话，哪块变了）。 */
export function diffToDetails(diff: FingerprintDiff): string[] {
  const lines: string[] = []
  for (const label of diff.changed) lines.push(`内容更新：${label}`)
  for (const label of diff.added) lines.push(`新增内容：${label}`)
  for (const label of diff.removed) lines.push(`内容移除：${label}`)
  return lines
}
