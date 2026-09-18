/**
 * 公告要点的生成（P0-3-25b）—— 懒生成 + 落库缓存。
 *
 * ### 触发时机：**不是同步，是"用户真的要看到它"**
 * Steven 2026-09-18 拍板走「打开消息栏时静默补」。理由是三条硬约束：
 * 1. **T1 是用户在等的路径**（打开 dashboard 会触发同步）：往里面塞模型调用 =
 *    打开明显变慢，而公告本身早已落库、并不需要等要点；
 * 2. **定时同步跑在 service role**（无 cookies）：`runStructured()` 的审计写入走会话 client，
 *    那一轮的 `llm_runs` 直接写不进去 —— ADR-003 复审要的样本就断了；
 * 3. **要点算一次就够**：公告正文不可变（老师改了内容会是**一条新公告**，
 *    去重键是 Canvas 公告 id），所以缓存命中率会很快趋近 100%。
 *
 * ### 一轮最多算几条（`MAX_MESSAGES_PER_REQUEST`）
 * 一次请求里每条消息各打一次模型（见下"为什么不是一次批量调用"），必须有上限：
 * 否则一个积压了 40 条公告的消息栏会在一次打开里打出 40 次调用。
 * 超出的一部分**如实回报**在 `remaining` 里，下次打开继续补 ——
 * 收敛靠"已生成的部分被缓存"，不需要额外的进度状态。
 *
 * ### 为什么一条消息一次调用（而不是一次调用处理 N 条消息）
 * 失败隔离：一次批量调用里某一条消息的正文把模型带偏（schema 不符），
 * 整批就都拿不到结果；而 **失败是要落库的**（`status = 'failed'` = 别再重试），
 * 一次批量失败会把"N 条消息"全标成失败，代价是它们从此永远没有要点。
 * 单条失败只损失一条，且下次不会再试 —— 损失可控、可解释。
 *
 * ### 调用方必须用**会话 client**
 * 归属全靠 RLS（`messages.user_id = auth.uid()` / `course_announcements → courses.user_id`）。
 * 换成 service role 就变成"能读别人的消息"，而这里的入参 id 来自**客户端**
 * —— 那是把越权读写在明面上的错，不是"隐式隔离"能兜住的（Sync-Strategy §3 的同一纪律）。
 */

import { runStructured } from '@/lib/llm/run'
import type { SummaryLocale } from '@/lib/messages/summary/locale'
import type { MessageSummary } from '@/types/message'

import { validateSummaryOutput } from './normalize'
import {
  SUMMARY_PROMPT_VERSION,
  buildSummaryInput,
  buildSummaryMessages,
  summarySchema,
} from './prompt'
import {
  loadAnnouncementsForMessages,
  loadSummaryCandidates,
  loadSummaries,
  saveSummary,
  type LinkedAnnouncement,
  type SummaryCandidate,
} from './store'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * 一轮请求最多生成几条。**刻意小**：
 * 生成是后台请求（不挡首屏），但一次调用 3 条 × 每条 3 秒串起来也是 9 秒，
 * 而 Vercel 函数有超时上限。宁可分几轮收敛，也不要一次赌到底。
 */
export const MAX_MESSAGES_PER_REQUEST = 3

/** 同时在飞的模型调用数。既压住耗时，也别把 provider 的限流打爆。 */
export const GENERATE_CONCURRENCY = 3

/** 写进 `llm_runs.purpose`（那列没有 CHECK 约束，新用途直接加字面量）。 */
const PURPOSE = 'announcement_summary'

/** `error_message` 上限（同 `llm_runs.error_message` 的纪律：精简、不含用户内容）。 */
const ERROR_MESSAGE_MAX = 200

export type SummaryResult = { messageId: string; summary: MessageSummary }

export type EnsureSummariesOutcome = {
  /** 本轮**可用**的要点：缓存命中的 + 刚生成的。 */
  summaries: SummaryResult[]
  /** 有生成资格的消息条数（pending 的公告消息）。 */
  eligible: number
  /** 其中缓存命中的条数。 */
  cached: number
  /** 本轮新生成成功的条数。 */
  generated: number
  /** 本轮尝试但失败的条数（已落 `failed` 行，不会重试）。 */
  failed: number
  /** 还没轮到的条数（超出本轮上限）—— 下次打开继续补。 */
  remaining: number
  /** 读库层面的错误（有值时上面所有计数都不可信）。 */
  error: string | null
}

/** 单条要点生成的内部结果。 */
type GeneratedOne = {
  summary: MessageSummary | null
  /** null = 成功；非 null = 失败原因（会写进 `error_message`）。 */
  error: string | null
}

/** 一条消息生成一次要点，**永不抛**（失败一律落 `failed` 行 + 日志）。 */
async function generateOne(input: {
  supabase: ServerSupabase
  userId: string
  candidate: SummaryCandidate
  sources: LinkedAnnouncement[]
  locale: SummaryLocale
}): Promise<GeneratedOne> {
  const { supabase, userId, candidate, sources, locale } = input

  // 消息挂着 0 条公告：不可能是这条路产生的（有落点/摘要都必然回填 message_id），
  // 但**不能因此去问模型** —— 没有原文就只会是编的。落 failed 行 = 别再重试。
  if (sources.length === 0) {
    const error = '这条消息没有关联的公告正文'
    await saveSummary({
      supabase,
      messageId: candidate.id,
      locale,
      status: 'failed',
      points: [],
      itemsUsed: 0,
      itemsTotal: 0,
      model: null,
      errorMessage: error,
    })
    console.warn('[summary] 消息没有关联公告，无法生成要点:', candidate.id)
    return { summary: null, error }
  }

  const summaryInput = buildSummaryInput({
    messageTitle: candidate.title,
    announcements: sources.map((source) => ({
      title: source.title,
      courseName: source.courseName,
      postedAt: source.postedAt,
      bodyText: source.bodyText,
    })),
    locale,
  })

  const result = await runStructured<unknown>({
    userId,
    purpose: PURPOSE,
    promptVersion: SUMMARY_PROMPT_VERSION,
    capability: 'text',
    schema: summarySchema(locale),
    schemaName: 'AnnouncementSummary',
    messages: buildSummaryMessages(summaryInput, locale),
    // 要的是稳定复述，不是创作。温度高一点就会出现"原文没说的建议"。
    temperature: 0,
    maxOutputTokens: 320,
  })

  const persist = async (fields: {
    status: 'ok' | 'failed'
    points: string[]
    model: string | null
    errorMessage: string | null
  }): Promise<void> => {
    const { error } = await saveSummary({
      supabase,
      messageId: candidate.id,
      locale,
      status: fields.status,
      points: fields.points,
      itemsUsed: summaryInput.itemsUsed,
      itemsTotal: summaryInput.itemsTotal,
      model: fields.model,
      errorMessage: fields.errorMessage,
    })
    if (error) {
      // 写不进去 = 这次白算（下次还要重算）。降级继续：本次结果照样返回给用户，
      // 但日志必须响 —— 典型原因是迁移没跑（message_summaries 不存在）。
      console.error('[summary] 要点写入失败（本次结果仍会显示，但下次会重算）:', error)
    }
  }

  if (!result.ok) {
    const message = `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX)
    await persist({ status: 'failed', points: [], model: null, errorMessage: message })
    console.error('[summary] 生成失败:', candidate.id, message)
    return { summary: null, error: message }
  }

  const validated = validateSummaryOutput(result.data)
  if (!validated.ok) {
    const message = validated.message.slice(0, ERROR_MESSAGE_MAX)
    await persist({ status: 'failed', points: [], model: result.usage.model, errorMessage: message })
    console.error('[summary] 模型输出不符合 schema:', candidate.id, message)
    return { summary: null, error: message }
  }

  const { points, dropped, truncated } = validated.value
  if (dropped > 0 || truncated > 0) {
    // 不拦下来（能用的部分照常展示），但一定要留痕：
    // "模型开始写超长/写废话"是 prompt 需要修的早期信号。
    console.warn(
      `[summary] 模型输出有偏差：丢弃 ${dropped} 条 / 截断 ${truncated} 条（消息 ${candidate.id}）`,
    )
  }

  await persist({
    status: 'ok',
    points,
    model: result.usage.model,
    errorMessage: null,
  })

  return {
    summary: {
      points,
      itemsUsed: summaryInput.itemsUsed,
      itemsTotal: summaryInput.itemsTotal,
      status: 'ok',
      createdAt: new Date().toISOString(),
    },
    error: null,
  }
}

/**
 * 给一批消息补齐要点（消息栏打开时调一次）。
 *
 * 流程：**先读缓存**（有的直接返回）→ 只对缺的生成 → 超出上限的记 `remaining`。
 * 因此重复调用是幂等的、且代价随缓存命中率迅速降到 0。
 *
 * **不抛异常**：任何失败都降级成"这次没有要点"，消息栏照常可用。
 */
export async function ensureSummaries(input: {
  supabase: ServerSupabase
  userId: string
  messageIds: string[]
  locale: SummaryLocale
}): Promise<EnsureSummariesOutcome> {
  const { supabase, userId, messageIds, locale } = input

  const empty: EnsureSummariesOutcome = {
    summaries: [],
    eligible: 0,
    cached: 0,
    generated: 0,
    failed: 0,
    remaining: 0,
    error: null,
  }
  if (messageIds.length === 0) return empty

  // ---------- 1) 有资格的消息（类型 / 状态 / 归属都在 SQL 里收口，见 store.ts） ----------
  const { candidates, error: candidateError } = await loadSummaryCandidates(supabase, messageIds)
  if (candidateError) {
    return { ...empty, error: candidateError }
  }
  if (candidates.length === 0) return empty

  // ---------- 2) 缓存命中 ----------
  const candidateIds = candidates.map((candidate) => candidate.id)
  const cached = await loadSummaries(supabase, candidateIds, locale)

  const summaries: SummaryResult[] = [...cached.entries()].map(([messageId, summary]) => ({
    messageId,
    summary,
  }))

  const missing = candidates.filter((candidate) => !cached.has(candidate.id))
  const batch = missing.slice(0, MAX_MESSAGES_PER_REQUEST)
  const remaining = missing.length - batch.length

  const outcome: EnsureSummariesOutcome = {
    ...empty,
    summaries,
    eligible: candidates.length,
    cached: summaries.length,
    remaining,
  }
  if (batch.length === 0) return outcome

  // ---------- 3) 一次查完这批消息的公告正文（不逐条往返） ----------
  const { byMessage, error: announcementError } = await loadAnnouncementsForMessages(
    supabase,
    batch.map((candidate) => candidate.id),
  )
  if (announcementError) {
    // 读公告失败：这一轮什么都生成不了。**不写 failed 行** ——
    // 那是"模型说不了"的标记，而这里只是读库失败（下一轮可能就好了）。
    console.error('[summary] 读取公告正文失败，本轮跳过生成:', announcementError)
    return { ...outcome, error: announcementError }
  }

  // ---------- 4) 分批并发生成（每批 GENERATE_CONCURRENCY 条） ----------
  for (let i = 0; i < batch.length; i += GENERATE_CONCURRENCY) {
    const chunk = batch.slice(i, i + GENERATE_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((candidate) =>
        generateOne({
          supabase,
          userId,
          candidate,
          sources: byMessage.get(candidate.id) ?? [],
          locale,
        }),
      ),
    )
    for (const [index, result] of results.entries()) {
      if (result.summary) {
        outcome.summaries.push({ messageId: chunk[index].id, summary: result.summary })
        outcome.generated += 1
      } else {
        outcome.failed += 1
      }
    }
  }

  return outcome
}
