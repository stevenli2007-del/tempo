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
import { resolveTaskTargets, type TaskMatchInput } from '@/lib/course-update/task-match'
import { readAttachmentExams } from '@/lib/messages/announcement-attachments'
import { t } from '@/lib/i18n/translate'
import type { TaskCandidate } from '@/types/task'
import type {
  Message,
  MessageComponentProposal,
  MessageExamProposal,
  MessagePayload,
  MessageRow,
  MessageTaskProposal,
  TaskProposalKind,
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

/**
 * 读作业改期提案（P0-5-5 ②）—— 与 `readExamProposals` 同一套防御式解析。
 *
 * `payload` 是 jsonb：客户端可以提交任意形状，所以每个字段都独立校验，
 * 不认识的 `kind` 直接丢弃（"认不出就当没有"，绝不退化成新增）。
 */
export function readTaskProposals(payload: MessagePayload): MessageTaskProposal[] {
  const raw = payload.taskProposals
  if (!Array.isArray(raw)) return []
  const kinds: TaskProposalKind[] = [
    'update',
    'duplicate',
    'ambiguous',
    'unmatched',
    'blocked_canvas',
    'blocked_derived',
    'missing',
  ]
  const items: MessageTaskProposal[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const title = text(record.title)
    if (title === null) continue
    const kind = record.kind
    if (typeof kind !== 'string' || !kinds.includes(kind as TaskProposalKind)) continue
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
      title,
      dueDate: text(record.dueDate),
      notes: text(record.notes),
      sourceExcerpt: text(record.sourceExcerpt) ?? '',
      kind: kind as TaskProposalKind,
      targetId: text(record.targetId),
      beforeLabel: text(record.beforeLabel),
      afterLabel: text(record.afterLabel) ?? title,
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

/**
 * 作业改期提案（P0-5-5 ②）。
 *
 * ### 🔴 只在解析真有作业类内容时才查 tasks 表
 * 绝大多数公告没有作业改期，白查一次纯属浪费；而 `resolveTaskTargets` 需要
 * 这门课现有任务做候选，所以必须查 —— 用「有没有解析出作业」决定查不查。
 *
 * ### 🔴 查不到任务 = 暂时性失败（返回 null，下次重试）
 * 与考试那边同一条二分法：读库失败不是"这门课没有作业"，
 * 写成 `clean` 会让用户以为"确实没得改"（ADR-016 R3 的诬告）。
 */
async function buildTaskProposals(input: {
  supabase: ServerSupabase
  courseId: string
  rawTasks: unknown
  messageId: string
}): Promise<MessageTaskProposal[]> {
  const { supabase, courseId, rawTasks, messageId } = input

  const items: TaskMatchInput[] = (Array.isArray(rawTasks) ? rawTasks : []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const record = raw as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    // 没有标题就没有可匹配的字面；没有截止日的"作业"谈不上改期（那是新建，本卡不做）。
    if (title === '') return []
    const dueDate = typeof record.dueDate === 'string' ? record.dueDate : null
    if (dueDate === null) return []
    return [
      {
        title,
        dueDate,
        notes: typeof record.notes === 'string' ? record.notes : null,
        sourceExcerpt: typeof record.sourceExcerpt === 'string' ? record.sourceExcerpt : '',
      },
    ]
  })
  if (items.length === 0) return []

  const { data: taskRows, error } = await supabase
    .from('tasks')
    .select('id, title, due_date, task_type, source, is_derived')
    .eq('course_id', courseId)
    .eq('is_deleted', false)
  if (error) {
    console.warn('[exam-proposals] 读任务失败（下次会重试）:', messageId, error.message)
    return []
  }

  const existing: TaskCandidate[] = ((taskRows ?? []) as {
    id: string
    title: string
    due_date: string | null
    task_type: TaskCandidate['taskType']
    source: TaskCandidate['source']
    is_derived: boolean
  }[]).map((row) => ({
    id: row.id,
    title: row.title,
    dueDate: row.due_date,
    taskType: row.task_type,
    source: row.source,
    isDerived: row.is_derived,
  }))

  const dueLabel = (value: string | null): string => value ?? t('zh', 'exam.tbd')

  return resolveTaskTargets(items, existing).map((resolution) => ({
    title: resolution.task.title,
    dueDate: resolution.task.dueDate,
    notes: resolution.task.notes,
    sourceExcerpt: resolution.task.sourceExcerpt,
    kind: resolution.kind,
    targetId: resolution.target?.id ?? null,
    beforeLabel:
      resolution.kind === 'update' && resolution.target ? dueLabel(resolution.target.dueDate) : null,
    afterLabel: dueLabel(resolution.task.dueDate),
    candidates: resolution.candidates.map((item) => ({
      id: item.id,
      label: `${item.title} · ${dueLabel(item.dueDate)}`,
    })),
    reason: resolution.reason,
  }))
}

/**
 * 本地课程 uuid → Canvas 课程 id（读附件要用它拼单条公告端点）。
 *
 * 查不到返回 null，调用方按"读不了附件"处理 —— 这门课没关联 Canvas，
 * 本来也就没有附件可读。
 */
async function loadCanvasCourseId(
  supabase: ServerSupabase,
  courseId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('courses')
    .select('canvas_course_id')
    .eq('id', courseId)
    .maybeSingle()
  const row = data as { canvas_course_id: string | null } | null
  return row?.canvas_course_id ?? null
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
    .select('id, course_id, body_text, canvas_announcement_id')
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

  const row = announcement as {
    id: string
    course_id: string
    body_text: string | null
    canvas_announcement_id: string | null
  }
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

  // ---------- 3a) P0-5-5 ①：正文里没说地点，而地点常常在 **PDF 附件**里 ----------
  //
  // 触发条件刻意收得很紧：只有「解析出了考试，但它没带地点」时才去读附件。
  // 每条公告都下 PDF 会同时烧 Canvas 限流、模型与用户的等待时间；
  // 而"已经有地点了"还去读，纯属浪费（且可能用附件里的旧值覆盖正文的新值）。
  let attachmentNote: string | null = null
  let allExamItems = examItems
  const canvasCourseId = examItems.some((item) => (item.location ?? null) === null)
    ? await loadCanvasCourseId(supabase, candidate.courseId)
    : null
  const externalAnnouncementId = row.canvas_announcement_id ?? ''
  // 缺 Canvas 课程 id 或外部公告 id → 这条路走不了（不读附件，也不算失败：
  // 正文那批提案照常出，用户不会因为"附件读不了"而失去处理正文的能力）。
  if (canvasCourseId && externalAnnouncementId !== '') {
    const fromAttachments = await readAttachmentExams({
      supabase,
      userId,
      canvasCourseId,
      externalAnnouncementId,
    })
    if (fromAttachments.exams.length > 0) {
      // 🔴 附件抽出的考试**追加**在正文那批之后：同一场会被 `resolveExamTargets`
      // 的"批内占位"挡成 duplicate（不会连写两次），名字对不上的才会各归各。
      allExamItems = [...examItems, ...fromAttachments.exams]
    } else if (fromAttachments.note) {
      attachmentNote = fromAttachments.note
    }
  }

  const resolutions = resolveExamTargets(allExamItems, rows)

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

  // ---------- 3b) P0-5-5 ②：作业改期提案（同一次解析，零额外模型调用） ----------
  //
  // 与考试提案**同一份** `parsed.data` 的不同数组 —— 一次解析同时喂两条通道，
  // 不为作业再打一次模型（钱和延迟都是双份，且两次解析可能给出不一致的结论）。
  const taskProposals = await buildTaskProposals({
    supabase,
    courseId: candidate.courseId,
    rawTasks: parsed.data.tasks,
    messageId: candidate.row.id,
  })

  const writable = proposals.filter((item) => item.kind === 'create' || item.kind === 'update')
  /**
   * P0-3-36：带候选、等用户挑一条的提案（`ambiguous` / `unidentifiable`）。
   *
   * 它们本身不可写，但**算 ready** —— 否则 applier 会走「知道了」那条路，
   * 用户在界面上挑了半天点确认，结果一个字都没写（R3 的静默失败）。
   * 真正的写入判据在 applier 里：挑过之后 `kind` 会变成 `update` / `create` 才可写。
   */
  const needsChoice = proposals.some(
    (item) =>
      (item.kind === 'ambiguous' || item.kind === 'unidentifiable') && item.candidates.length > 0,
  )
  // 作业改期里「可写」的只有 `update`（本卡不新增作业）；多命中同样算待挑。
  const writableTasks = taskProposals.filter((item) => item.kind === 'update')
  const taskNeedsChoice = taskProposals.some(
    (item) => item.kind === 'ambiguous' && item.candidates.length > 0,
  )
  const status: 'ready' | 'clean' =
    writable.length > 0 ||
    components.length > 0 ||
    needsChoice ||
    writableTasks.length > 0 ||
    taskNeedsChoice
      ? 'ready'
      : 'clean'

  const lines: string[] = []
  for (const item of proposals) {
    if (item.kind === 'update') {
      lines.push(`考试改期：${item.examName} ${item.beforeLabel ?? ''} → ${item.afterLabel}`)
    } else if (item.kind === 'create') {
      lines.push(`新增考试：${item.afterLabel}`)
    } else if (item.candidates.length > 0) {
      // 待指定：先把"要你做什么"说在前面，原因跟在后面。
      lines.push(`待你指定：${item.examName}（${item.reason ?? '请指定要改哪一条，或新增一条'}）`)
    } else {
      lines.push(`${item.examName}：${item.reason ?? '未写入'}`)
    }
  }
  if (components.length > 0) {
    lines.push(`成绩构成 ${components.length} 条：${components.map((c) => c.name).join('、')}`)
  }
  // 附件读了但没读出东西 → 如实说一句（R3：不做没意义的事可以，静默不行）。
  if (attachmentNote) {
    lines.push(`附件：${attachmentNote}`)
  }
  // 作业改期：改期的那句「旧 → 新」必须出现，写不了的那句也要出现（R3）。
  for (const item of taskProposals) {
    if (item.kind === 'update') {
      lines.push(`作业改期：${item.title} ${item.beforeLabel ?? ''} → ${item.afterLabel}`)
    } else if (item.kind === 'ambiguous') {
      lines.push(`待你指定：${item.title}（${item.reason ?? '请指定要改哪一条'}）`)
    } else {
      lines.push(`${item.title}：${item.reason ?? '未写入'}`)
    }
  }
  if (
    writable.length === 0 &&
    components.length === 0 &&
    proposals.length === 0 &&
    taskProposals.length === 0
  ) {
    lines.push('这条公告里没有可写入的考试 / 成绩构成')
  }

  return writePatch(
    supabase,
    candidate,
    {
      examProposals: proposals,
      componentProposals: components,
      examProposalsStatus: status,
      ...(taskProposals.length > 0 ? { taskProposals } : {}),
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
