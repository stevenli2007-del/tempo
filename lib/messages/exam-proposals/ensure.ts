import { MESSAGE_COLUMNS, toMessage } from '@/lib/messages'
import { EXAM_DATE_COLUMNS, toExamDate, type ExamDateRow } from '@/lib/exam-dates'
import { parseCourseUpdate } from '@/lib/course-update/parse'
import {
  validateExamInput,
  validateGradeComponentInput,
} from '@/lib/course-update/normalize'
import {
  examScheduleLabel,
  resolveExamTargets,
  type ExamRowRef,
} from '@/lib/course-update/exam-match'
import type {
  Message,
  MessageComponentProposal,
  MessageExamProposal,
  MessagePayload,
  MessageRow,
} from '@/types/message'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * 公告考试提案的**懒补**编排（P0-3-29）—— 与 ADR-024（要点）/ P0-3-20（漂移）同一条范式。
 *
 * ### 为什么不在同步时算
 * 解析一次公告要打一次模型。同步一轮要给几十条公告都来一遍，既慢又贵，
 * 而且**同步不该依赖模型可用性**（模型挂了会连累作业同步）。
 * 所以同步只做关键词粗筛（`hasStructuredLanding`），真正的解析发生在
 * **用户打开消息栏时**（本文件）。
 *
 * ### 为什么不在「确认」时才算（本卡改变的那一点）
 * 原先解析确实在确认那一刻做 —— 但那样用户点的是一个**不知道会改哪一条**的按钮。
 * 「改期」这种最常见的公告，点下去之前必须看到 `9/28 → 9/27`。
 * 现在提前到打开消息栏时算，确认时直接**复用**这份结论（所见即所写）。
 *
 * ### 失败怎么表达（与漂移同一条二分法）
 * - `failed`：**确定性失败**（公告记录没了 / 正文空 / 课程对不上）→ 写回，不再重试；
 * - 模型不可用 → **什么都不写**（状态留在 `pending`），下次打开消息栏自然重试。
 * 混成一个"失败"就分不清"这条读不了"和"刚才网抖了"。
 *
 * ### 🔴 归属靠会话 client
 * 入参 id 来自客户端，绝不能用 service role（那会读到别人的消息、用别人的公告跑模型）。
 * 会话 client 下别人的 id 查不出来 —— 静默不在候选里（ADR-010）。
 */

/** 一轮最多算几条（每条 = 1 次模型调用）。 */
export const MAX_EXAM_PROPOSALS_PER_REQUEST = 3

/** 同时在飞的数量。 */
export const EXAM_PROPOSALS_CONCURRENCY = 2

/** 防御性上限：客户端只会送它正在渲染的几条，但这是个接收数组的端点。 */
const MAX_INPUT_IDS = 50

export type EnsureExamProposalsOutcome = {
  /** 本轮**算出并写回**的消息（payload 已是新的那一份）。 */
  messages: Message[]
  eligible: number
  computed: number
  failed: number
  deferred: number
  remaining: number
  error: string | null
}

type Candidate = {
  row: MessageRow
  payload: MessagePayload
  courseId: string
  announcementId: string
}

const EMPTY: EnsureExamProposalsOutcome = {
  messages: [],
  eligible: 0,
  computed: 0,
  failed: 0,
  deferred: 0,
  remaining: 0,
  error: null,
}

/**
 * 筛出"真的待算"的公告。
 *
 * 条件：类型对 + 仍 pending + **有落点**（无落点的摘要消息没有考试可谈）
 * + 定位字段齐全 + 状态还是 `pending`（算过的 `ready` / `clean` / `failed` 不再重算）。
 */
function toCandidates(rows: MessageRow[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const row of rows) {
    if (row.type !== 'announcement') continue
    if (row.status !== 'pending') continue

    const payload = (row.payload ?? {}) as MessagePayload
    if (payload.landing !== true) continue
    if (
      payload.examProposalsStatus === 'ready' ||
      payload.examProposalsStatus === 'clean' ||
      payload.examProposalsStatus === 'failed'
    ) {
      continue
    }

    const courseId = typeof payload.courseId === 'string' ? payload.courseId : ''
    const announcementId = typeof payload.announcementId === 'string' ? payload.announcementId : ''
    if (courseId === '' || announcementId === '') continue

    candidates.push({ row, payload, courseId, announcementId })
  }
  return candidates
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** payload 是 jsonb，读出来的提案**每一项都要当"可能是任何形状"**。 */
export function readExamProposals(payload: MessagePayload): MessageExamProposal[] {
  const raw = payload.examProposals
  if (!Array.isArray(raw)) return []
  const items: MessageExamProposal[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const examName = text(record.examName)
    if (examName === null) continue
    const kind = record.kind
    if (
      kind !== 'create' &&
      kind !== 'update' &&
      kind !== 'duplicate' &&
      kind !== 'ambiguous' &&
      kind !== 'unidentifiable' &&
      kind !== 'missing'
    ) {
      continue
    }
    const candidates = Array.isArray(record.candidates)
      ? record.candidates.flatMap((item) => {
          if (typeof item !== 'object' || item === null) return []
          const c = item as Record<string, unknown>
          const id = text(c.id)
          const label = text(c.label)
          return id && label ? [{ id, label }] : []
        })
      : []
    items.push({
      examName,
      examDate: text(record.examDate),
      examTime: text(record.examTime),
      location: text(record.location),
      sourceExcerpt: text(record.sourceExcerpt) ?? '',
      kind,
      targetId: text(record.targetId),
      beforeLabel: text(record.beforeLabel),
      afterLabel: text(record.afterLabel) ?? examName,
      candidates,
      reason: text(record.reason),
    })
  }
  return items
}

export function readComponentProposals(payload: MessagePayload): MessageComponentProposal[] {
  const raw = payload.componentProposals
  if (!Array.isArray(raw)) return []
  const items: MessageComponentProposal[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = text(record.name)
    if (name === null) continue
    const weight = record.weightPercent
    items.push({
      name,
      weightPercent:
        typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 100
          ? weight
          : null,
      notes: text(record.notes),
      sourceExcerpt: text(record.sourceExcerpt) ?? '',
    })
  }
  return items
}

export async function ensureExamProposals(input: {
  supabase: ServerSupabase
  userId: string
  messageIds: string[]
}): Promise<EnsureExamProposalsOutcome> {
  const { supabase, userId, messageIds } = input

  const uniqueIds = [...new Set(messageIds)].slice(0, MAX_INPUT_IDS)
  if (uniqueIds.length === 0) return EMPTY

  const { data, error } = await supabase.from('messages').select(MESSAGE_COLUMNS).in('id', uniqueIds)
  if (error) return { ...EMPTY, error: error.message }

  const candidates = toCandidates((data ?? []) as MessageRow[])
  if (candidates.length === 0) return EMPTY

  const batch = candidates.slice(0, MAX_EXAM_PROPOSALS_PER_REQUEST)
  const outcome: EnsureExamProposalsOutcome = {
    ...EMPTY,
    eligible: candidates.length,
    remaining: candidates.length - batch.length,
  }

  for (let i = 0; i < batch.length; i += EXAM_PROPOSALS_CONCURRENCY) {
    const chunk = batch.slice(i, i + EXAM_PROPOSALS_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((candidate) => computeOne({ supabase, userId, candidate })),
    )
    for (const message of results) {
      if (!message) {
        outcome.deferred += 1
        continue
      }
      outcome.messages.push(message)
      if (message.payload.examProposalsStatus === 'failed') outcome.failed += 1
      else outcome.computed += 1
    }
  }

  return outcome
}

/** 算一条并写回。**暂时性失败返回 null**（下次再试）。 */
async function computeOne(input: {
  supabase: ServerSupabase
  userId: string
  candidate: Candidate
}): Promise<Message | null> {
  const { supabase, userId, candidate } = input

  // ---------- 1) 回查公告正文（RLS 保证它属于我） ----------
  const { data: announcement, error: loadError } = await supabase
    .from('course_announcements')
    .select('id, course_id, body_text')
    .eq('id', candidate.announcementId)
    .maybeSingle()

  if (loadError || !announcement) {
    return writePatch(
      supabase,
      candidate,
      {
        examProposalsStatus: 'failed',
        examProposalsError: '找不到这条公告的记录（可能已被清理），无法解析',
      },
      ['考试提案：找不到这条公告的记录，请到课程页手动处理'],
    )
  }

  const row = announcement as { id: string; course_id: string; body_text: string | null }
  // 归属一致性：payload 说的课与账上的课必须一致，不一致就停下来（绝不"以账为准"）。
  if (row.course_id !== candidate.courseId) {
    return writePatch(
      supabase,
      candidate,
      {
        examProposalsStatus: 'failed',
        examProposalsError: '这条公告所属课程与消息记录不一致，已停止解析',
      },
      ['考试提案：这条公告的课程对不上，请到课程页手动处理'],
    )
  }

  const body = (row.body_text ?? '').trim()
  if (body === '') {
    return writePatch(
      supabase,
      candidate,
      {
        examProposalsStatus: 'failed',
        examProposalsError: '这条公告没有正文（可能只发了标题或附件）',
      },
      ['考试提案：这条公告没有正文，没有可解析的内容'],
    )
  }

  // ---------- 2) 解析（模型不可用 → 什么都不写，下次重试） ----------
  const parsed = await parseCourseUpdate({
    userId,
    text: body,
    purpose: 'announcement_proposals',
  })
  if (!parsed.ok) {
    console.warn('[exam-proposals] 本轮没能解析（下次会重试）:', candidate.row.id, parsed.reason)
    return null
  }

  const examItems = (Array.isArray(parsed.data.exams) ? parsed.data.exams : []).flatMap((raw) => {
    const result = validateExamInput(raw)
    return result.ok ? [result.value] : []
  })
  const componentItems = (
    Array.isArray(parsed.data.gradeComponents) ? parsed.data.gradeComponents : []
  ).flatMap((raw) => {
    const result = validateGradeComponentInput(raw)
    return result.ok ? [result.value] : []
  })

  // ---------- 3) 读这门课现有的考试行 → 解析"落到哪一行" ----------
  const { data: existingRows, error: examError } = await supabase
    .from('exam_dates')
    .select(EXAM_DATE_COLUMNS)
    .eq('course_id', candidate.courseId)
  if (examError) {
    console.warn('[exam-proposals] 读考试记录失败（下次会重试）:', candidate.row.id, examError.message)
    return null
  }
  const rows: ExamRowRef[] = ((existingRows ?? []) as ExamDateRow[]).map(toExamDate).map((item) => ({
    id: item.id,
    examName: item.examName,
    examDate: item.examDate,
    examTime: item.examTime,
    location: item.location,
  }))

  const resolutions = resolveExamTargets(examItems, rows)

  const proposals: MessageExamProposal[] = resolutions.map((resolution, index) => ({
    examName: resolution.exam.examName,
    examDate: resolution.exam.examDate,
    examTime: resolution.exam.examTime,
    location: resolution.exam.location,
    // 摘录不在 `ExamMatchInput` 里（匹配用不到它），按下标回原条目取。
    sourceExcerpt: examItems[index]?.sourceExcerpt ?? '',
    kind: resolution.kind,
    targetId: resolution.target?.id ?? null,
    beforeLabel:
      resolution.kind === 'update' && resolution.target
        ? examScheduleLabel({
            examName: resolution.target.examName,
            examDate: resolution.target.examDate,
            examTime: resolution.target.examTime,
            location: resolution.target.location,
          })
        : null,
    afterLabel: examScheduleLabel({
      examName: resolution.exam.examName,
      examDate: resolution.exam.examDate,
      examTime: resolution.exam.examTime,
      location: resolution.exam.location,
    }),
    candidates: resolution.candidates.map((item) => ({
      id: item.id,
      label: examScheduleLabel({
        examName: item.examName,
        examDate: item.examDate,
        examTime: item.examTime,
        location: item.location,
      }),
    })),
    reason: resolution.reason,
  }))

  const components: MessageComponentProposal[] = componentItems.map((item) => ({
    name: item.name,
    weightPercent: item.weightPercent,
    notes: item.notes,
    sourceExcerpt: item.sourceExcerpt ?? '',
  }))

  const writable = proposals.filter((item) => item.kind === 'create' || item.kind === 'update')
  const status: 'ready' | 'clean' =
    writable.length > 0 || components.length > 0 ? 'ready' : 'clean'

  const lines: string[] = []
  for (const item of proposals) {
    if (item.kind === 'update') {
      lines.push(`考试改期：${item.examName} ${item.beforeLabel ?? ''} → ${item.afterLabel}`)
    } else if (item.kind === 'create') {
      lines.push(`新增考试：${item.afterLabel}`)
    } else {
      lines.push(`${item.examName}：${item.reason ?? '未写入'}`)
    }
  }
  if (components.length > 0) {
    lines.push(`成绩构成 ${components.length} 条：${components.map((c) => c.name).join('、')}`)
  }
  if (writable.length === 0 && components.length === 0 && proposals.length === 0) {
    lines.push('这条公告里没有可写入的考试 / 成绩构成')
  }

  return writePatch(
    supabase,
    candidate,
    {
      examProposals: proposals,
      componentProposals: components,
      examProposalsStatus: status,
    },
    lines,
  )
}

/**
 * 把补丁写回 payload 并返回更新后的 `Message`。
 *
 * `details` 是**追加**而不是替换：前面几行是公告正文的摘录（同步时写的），
 * 提案是对它的结论 —— 两条信息都要在，替换掉等于把原文的可见部分删了。
 */
async function writePatch(
  supabase: ServerSupabase,
  candidate: Candidate,
  patch: Partial<MessagePayload>,
  lines: string[],
): Promise<Message | null> {
  const existingDetails = Array.isArray(candidate.payload.details) ? candidate.payload.details : []
  const payload: MessagePayload = {
    ...candidate.payload,
    ...patch,
    details: [...existingDetails, ...lines],
  }

  const { data, error } = await supabase
    .from('messages')
    .update({ payload })
    .eq('id', candidate.row.id)
    .select(MESSAGE_COLUMNS)
    .maybeSingle()

  if (error || !data) {
    console.error('[exam-proposals] 提案写回失败（状态仍是 pending，下次会重试）:', candidate.row.id, error?.message)
    return null
  }

  const base = toMessage(data as MessageRow)
  if (!base) return null
  return { ...base, payload }
}
