/**
 * 任务候选匹配（P0-3-8b）—— 纯函数、零 IO。
 *
 * 「用户输入 → **先检索现有任务** → 0 命中就先增 / 有命中就列举让用户选改哪条」
 * 里的「检索」就是这里。
 *
 * ### 🔴 匹配必须确定性，不用 LLM（本卡的架构判断）
 * LLM 只负责从自由文本里抽出「说的是哪个标题、想改什么」（`/api/v1/tasks/parse`）；
 * 「哪条任务叫这个标题」由本文件算。理由：LLM 会**幻觉出一条不存在的任务 id**，
 * 而匹配错 = 改错用户的日程，代价与幻觉进日程同级。确定性代码可复现、可审计、可单测
 * （`scripts/regress-manual-tasks.ts`）。
 *
 * ### 召回 > 精确（刻意）
 * 阈值取得偏低：宁可多列举一条让用户划掉，也不要漏掉真正想改的那条 ——
 * 漏了用户就得手动新建，多一条只是多看一眼。排序保证最像的在最前。
 *
 * ### 只算相似度，不做「能不能改」的产品判断
 * manual / canvas / syllabus 各来源一视同仁地参与打分；谁能改由前端决定
 * （只有 `source='manual'` 可改，canvas 会被同步覆盖，考试归 `exam_dates`，ADR-004）。
 */

import type { TaskCandidate, TaskMatch } from '@/types/task'

/** 命中阈值：低于此分不算候选。 */
export const MATCH_THRESHOLD = 0.6

/** 默认返回的候选条数上限。 */
export const DEFAULT_MATCH_LIMIT = 5

/**
 * 常见缩写归一化表（只对**纯字母** token 生效）。
 * `hw` / `hmwk` / `hwk` → `homework`，让「HW 7」「HW7」「Homework 7」归一后一致。
 */
const ABBREVIATIONS: Record<string, string> = {
  hw: 'homework',
  hmwk: 'homework',
  hwk: 'homework',
}

/**
 * 标题归一化：小写 → NFKC 折叠全角/兼容字符 → 切成「连续字母 / 连续数字 / 单个汉字」token
 * → 展开常见缩写 → 拼接（去空格与标点）。
 *
 * 例：`"HW 7"` → `"homework7"`；`"Homework 7"` → `"homework7"`（两者相等）；
 * `"HW7: Arrays"` → `"homework7arrays"`。
 */
export function normalizeTitle(input: string): string {
  const lowered = input.toLowerCase().normalize('NFKC')
  const tokens = lowered.match(/[a-z]+|\d+|[\u4e00-\u9fff]/g) ?? []
  return tokens.map((token) => ABBREVIATIONS[token] ?? token).join('')
}

/** 标准编辑距离（滚动数组，省内存）。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[b.length]
}

/** 编辑距离相似度：`1 - dist / maxLen`，∈ [0,1]。 */
function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

/** 二元组（bigram）切分；单字符退化为自身，空串为空。 */
function bigrams(s: string): string[] {
  if (s.length === 0) return []
  if (s.length === 1) return [s]
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}

/** Dice 系数（二元组重合度），∈ [0,1]。中文标题没有词边界时比编辑距离更稳。 */
function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a)
  const bb = bigrams(b)
  if (ba.length === 0 && bb.length === 0) return a === b ? 1 : 0
  if (ba.length === 0 || bb.length === 0) return 0
  const counts = new Map<string, number>()
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1)
  let overlap = 0
  for (const g of bb) {
    const c = counts.get(g)
    if (c !== undefined && c > 0) {
      overlap += 1
      counts.set(g, c - 1)
    }
  }
  return (2 * overlap) / (ba.length + bb.length)
}

/**
 * 两个标题的相似度 ∈ [0,1]。
 * 归一化后相同 → 1；否则取「编辑距离比」与「二元组 Dice」的较大者（各补对方的短板）。
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (na === '' || nb === '') return 0
  if (na === nb) return 1
  return Math.max(levenshteinRatio(na, nb), diceCoefficient(na, nb))
}

/**
 * 在候选里检索与 `query` 相似的任务：打分 → 过滤阈值 → 按分降序 → 截断。
 * 返回带 `score` 的候选，前端据此列举给用户选。
 */
export function matchTasks(
  query: string,
  candidates: TaskCandidate[],
  options: { threshold?: number; limit?: number } = {},
): TaskMatch[] {
  const threshold = options.threshold ?? MATCH_THRESHOLD
  const limit = options.limit ?? DEFAULT_MATCH_LIMIT
  return candidates
    .map((candidate) => ({ ...candidate, score: titleSimilarity(query, candidate.title) }))
    .filter((match) => match.score >= threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
}
