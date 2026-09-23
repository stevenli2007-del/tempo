import type { MessagePayload } from '@/types/message'

import { readExamProposals } from './ensure'

/**
 * 把用户**在消息栏里点出来的选择**合并进 payload（P0-3-36，纯函数）。
 *
 * ### 它解决什么
 * 提案算出来是 `ambiguous`（名字对不上、但同一天已有考试可能是同一场）时，
 * 老链路只有一个「确认」按钮 —— 点下去要么按老规则静默新增，要么干脆不写。
 * 现在界面给一份候选让人挑「覆盖哪一条 / 新增一条」，挑完跟着确认一起送上来，
 * 本函数负责把它写回 `payload.examProposals`，让 applier 照单执行。
 *
 * ### 🔴 三条纪律
 * 1. **只认候选里的 id**。客户端送什么 id 都不信，必须在服务端那份 `candidates` 里
 *    出现过 —— 否则等于让客户端指名改任意一行（`candidates` 本身是按课程过滤出来的）。
 * 2. **不改写别的字段**。选择只改 `kind` / `targetId` / `beforeLabel`，
 *    考试名 / 日期 / 摘录一字不动 —— 那是"所见即所写"的那一半。
 * 3. **挑不出来就报错，绝不退化**。index 越界 / 该条没有候选 时返回 error，
 *    由路由回 400；静默忽略会让用户以为选了，结果什么都没写（R3）。
 */

export type ExamChoiceInput = {
  /** `payload.examProposals` 里的下标。 */
  index: number
  /** 字符串 = 改这一条（必须在候选里）；`null` = 用户明确要新增。 */
  targetId: string | null
}

export type ApplyExamChoicesResult = {
  payload: MessagePayload
  /** 人话错误（直接进 400 的 message）；成功为 null。 */
  error: string | null
}

/** 从请求体里读出选择（形状不可信，逐项筛）。 */
export function readExamChoices(raw: unknown): ExamChoiceInput[] {
  if (!Array.isArray(raw)) return []
  const out: ExamChoiceInput[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const index = record.index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue
    const targetId = record.targetId
    if (targetId !== null && typeof targetId !== 'string') continue
    out.push({ index, targetId })
  }
  return out
}

export function applyExamChoices(
  payload: MessagePayload,
  choices: ExamChoiceInput[],
): ApplyExamChoicesResult {
  if (choices.length === 0) return { payload, error: null }

  const proposals = readExamProposals(payload)
  if (proposals.length === 0) {
    return { payload, error: '这条消息没有可指定的考试提案，选择无效' }
  }

  const next = [...proposals]
  for (const choice of choices) {
    if (choice.index >= proposals.length) {
      return { payload, error: `选择的第 ${choice.index + 1} 条考试不存在` }
    }
    const item = proposals[choice.index]!
    if (item.candidates.length === 0) {
      return { payload, error: `「${item.examName}」没有可选择的已有考试` }
    }
    if (choice.targetId === null) {
      // 用户看过候选、明确说"新增一条" —— 强制 create（即便同名 / 同日已有）。
      next[choice.index] = { ...item, kind: 'create', targetId: null, reason: null }
      continue
    }
    const picked = item.candidates.find((candidate) => candidate.id === choice.targetId)
    if (!picked) {
      return { payload, error: `「${item.examName}」的选择不在候选里，请重新选择` }
    }
    next[choice.index] = {
      ...item,
      kind: 'update',
      targetId: picked.id,
      // 旧值标签：回执要写「Unit 1 Exam · 2026-09-22 → Chem 1A exam · 2026-09-22」，
      // 没有它回执就只有"after"，用户核对不了改的是哪一条。
      beforeLabel: picked.label,
      reason: null,
    }
  }

  return { payload: { ...payload, examProposals: next }, error: null }
}
