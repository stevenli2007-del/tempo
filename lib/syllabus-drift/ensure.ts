import { MESSAGE_COLUMNS, toMessage } from '@/lib/messages'
import { computeDrift, persistDrift } from '@/lib/syllabus-drift/generate'
import type { Message, MessagePayload, MessageRow } from '@/types/message'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * 大纲漂移的**懒补**编排（P0-3-20）—— 与 ADR-024（公告要点）同一条范式。
 *
 * ### 为什么差异不在同步时算
 * ADR-026 把路径切成两半：**批量/后台零下载**，用户触发的路径才读内容。
 * 同步侧（`lib/sync/syllabus-drift.ts`）只做"文件版本变了没有"这个元数据判断，
 * 建一条 `driftStatus: 'pending'` 的提案；真正下载那份 PDF、抽文本、调模型
 * 算出「新增 X / 变动 Y」，是**用户打开消息栏时**才发生的（本文件）。
 *
 * 所以消息栏里那条提案的 `details` 一开始是一句占位（「正在核对差异…」），
 * 算完之后被服务端**整段改写**成差异清单 —— 客户端不需要为漂移另写一套渲染，
 * 它读的还是 `payload.details`（3-18 是唯一提案出口）。
 *
 * ### 一轮最多算几条
 * 一条漂移的成本比一条公告要点重得多：**一次下载（可能几 MB）+ 一次带 30k 字符
 * 正文的模型调用**。所以上限压得比要点更紧的并发（2），条数同为 3。
 * 超出的一部分如实回报在 `remaining` 里，客户端再补一轮 —— 收敛靠
 * "算完的已经离开 `pending`"，不需要额外的进度状态。
 *
 * ### 🔴 重复调用是安全的
 * 资格判定里 `driftStatus === 'pending'` 本身就是闸：算完的（`ready` / `clean` /
 * `failed`）不会再被选中，所以"多打几次"最多重算一次刚好被写掉的那几条。
 * 失败二分法在这里体现为两种计数：
 * - `failed`：**确定性失败**（抽不出文字、类型不支持、文件已删）→ 已写回 `failed`，不再重试；
 * - `deferred`：**暂时性失败**（网络 / 5xx / 限流 / token 临时不可用）→ **不写回**，
 *   状态仍是 `pending`，下次打开消息栏自然重试。
 * 把两者混成一个"失败"数，用户（和我们）就分不清"这份大纲读不了"和"刚才网抖了一下"。
 *
 * ### 🔴 归属靠会话 client
 * 入参 messageIds 来自**客户端**，因此绝不能用 service role（那会读到别人的消息、
 * 还用别人的大纲去跑模型）。会话 client + RLS 下，别人的 id 直接查不出来 ——
 * 静默不在候选里，不回 404、不确认 id 是否存在（ADR-010）。
 */

/**
 * 一轮最多算几条差异。
 *
 * 单条 = 1 次 Canvas 下载 + 1 次模型调用，比要点重。最坏情况也在 Vercel
 * 函数的超时之内；剩下的下一轮补。
 */
export const MAX_DRIFT_PER_REQUEST = 3

/** 同时在飞的核对数。比要点低：每条都要下载文件，别把带宽和限流一起打满。 */
export const DRIFT_CONCURRENCY = 2

/**
 * 单次请求最多看多少条 id。
 *
 * 防御性的上限：客户端只会送来**它正在渲染的**漂移提案（个位数），
 * 但这是个接收客户端数组的端点，不能假设对面守规矩。
 */
const MAX_INPUT_IDS = 50

export type EnsureDriftOutcome = {
  /**
   * 本轮**算出结果并写回**的那些消息（payload 已是新的那一份）。
   *
   * 客户端直接按 id 替换本地那几条即可 —— 差异就住在 `payload` 里，
   * 不需要像要点那样另开一张 map（`toMessageView` 会重新派生视图）。
   */
  messages: Message[]
  /** 有核对资格的条数（类型 / 状态 / 定位字段都齐）。 */
  eligible: number
  /** 算完并写回的条数（含"核对完发现没有差异"的 `clean`）。 */
  computed: number
  /** 确定性失败、已写回 `failed` 的条数（不会重试）。 */
  failed: number
  /** 暂时性失败、**没写回**的条数（下次打开消息栏会重试）。 */
  deferred: number
  /** 还没轮到的条数（超出本轮上限）—— 客户端再补一轮。 */
  remaining: number
  /** 读库层面的错误（有值时上面所有计数都不可信）。 */
  error: string | null
}

/** 能进核对流水线的一条（`row` 原样带着，供 `toMessage` 复用同一份映射）。 */
type DriftCandidate = {
  row: MessageRow
  payload: MessagePayload
  courseId: string
  courseName: string
  syllabusFileId: string
}

const EMPTY: EnsureDriftOutcome = {
  messages: [],
  eligible: 0,
  computed: 0,
  failed: 0,
  deferred: 0,
  remaining: 0,
  error: null,
}

/**
 * 从库里读出来的行筛出"真的待核对"的漂移提案。
 *
 * 🔴 筛选**刻意放在内存里**，而不是 SQL 的 `payload->>driftStatus`：
 * 后者依赖 PostgREST 的箭头语法，写错了在本地看不出来（要么报错、
 * 要么静默少筛几条），而这里的数据量是个位数 —— 用一行 JS 换掉一整类
 * "查询条件悄悄不生效"的风险，划算。
 *
 * 缺 `courseId` / `syllabusFileId` 的**不算候选**：那是老数据或半截写入，
 * 请求过去也只会被判失败，不如不请求（也免得白花一次下载）。
 */
function toCandidates(rows: MessageRow[]): DriftCandidate[] {
  const candidates: DriftCandidate[] = []
  for (const row of rows) {
    if (row.type !== 'syllabus_drift') continue
    if (row.status !== 'pending') continue

    const payload = (row.payload ?? {}) as MessagePayload
    if (payload.driftStatus !== 'pending') continue

    const courseId = typeof payload.courseId === 'string' ? payload.courseId : ''
    const syllabusFileId = typeof payload.syllabusFileId === 'string' ? payload.syllabusFileId : ''
    if (courseId === '' || syllabusFileId === '') continue

    candidates.push({
      row,
      payload,
      courseId,
      courseName: typeof payload.courseName === 'string' ? payload.courseName : '',
      syllabusFileId,
    })
  }
  return candidates
}

/**
 * 给一批消息补齐差异（消息栏打开时调一次）。
 *
 * **不抛异常**：任何失败都降级成"这次没算出来"，消息栏照常可用。
 * 但降级不等于吞掉 —— 确定的失败写进 payload（界面上看得见），
 * 暂时性的失败留日志（排障看得见）。
 */
export async function ensureDrift(input: {
  supabase: ServerSupabase
  userId: string
  messageIds: string[]
}): Promise<EnsureDriftOutcome> {
  const { supabase, userId, messageIds } = input

  // 去重：客户端可能把同一个 id 送两次（两个标签页 / 一次重渲染），
  // 不去重就会对**同一条**消息跑两遍下载 + 模型。
  const uniqueIds = [...new Set(messageIds)].slice(0, MAX_INPUT_IDS)
  if (uniqueIds.length === 0) return EMPTY

  // ---------- 1) 读候选（类型 / 状态 / 归属都在会话 client + RLS 下收口） ----------
  const { data, error } = await supabase.from('messages').select(MESSAGE_COLUMNS).in('id', uniqueIds)
  if (error) return { ...EMPTY, error: error.message }

  const candidates = toCandidates((data ?? []) as MessageRow[])
  if (candidates.length === 0) return EMPTY

  const batch = candidates.slice(0, MAX_DRIFT_PER_REQUEST)
  const outcome: EnsureDriftOutcome = {
    ...EMPTY,
    eligible: candidates.length,
    remaining: candidates.length - batch.length,
  }

  // ---------- 2) 分批并发核对（每批 DRIFT_CONCURRENCY 条） ----------
  for (let i = 0; i < batch.length; i += DRIFT_CONCURRENCY) {
    const chunk = batch.slice(i, i + DRIFT_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((candidate) => computeOne({ supabase, userId, candidate })),
    )

    for (const message of results) {
      if (!message) {
        outcome.deferred += 1
        continue
      }
      outcome.messages.push(message)
      // `clean`（核对完发现没有差异）也算"算完了"：它同样写回了 payload、
      // 同样离开了 `pending`，只是没有要写库的条目。
      if (message.payload.driftStatus === 'failed') outcome.failed += 1
      else outcome.computed += 1
    }
  }

  return outcome
}

/**
 * 算一条并写回。返回更新后的 `Message`；**暂时性失败返回 null**（下次再试）。
 *
 * 返回的 `Message` 用 `toMessage(row)` 现做再换掉 payload —— 映射（type/status/
 * createdAt/decidedAt）只此一处，不在这里手抄一遍列名。
 *
 * 也不重查库：`persistDrift` 已经把"写进去的那一份"还给我们了。再 `select` 一次
 * 既多一次往返，又引入"读到的是不是刚写的那份"的疑问（两次读之间可能被别的请求改过）。
 */
async function computeOne(input: {
  supabase: ServerSupabase
  userId: string
  candidate: DriftCandidate
}): Promise<Message | null> {
  const { supabase, userId, candidate } = input

  const outcome = await computeDrift({
    supabase,
    userId,
    courseId: candidate.courseId,
    courseName: candidate.courseName,
    syllabusFileId: candidate.syllabusFileId,
  })

  // 暂时性失败：**什么都不写**（状置留在 pending，下次打开自然重试）。
  if (outcome.status === 'skipped') {
    console.warn('[syllabus-drift] 本轮没能核对（下次会重试）:', candidate.row.id, outcome.reason)
    return null
  }

  const written = await persistDrift(supabase, candidate.row.id, candidate.payload, outcome.patch)
  if (written.error || !written.payload) {
    console.error(
      '[syllabus-drift] 差异写回失败（状态仍是 pending，下次会重试）:',
      candidate.row.id,
      written.error,
    )
    return null
  }

  const base = toMessage(candidate.row)
  if (!base) {
    // 类型 / 状态越界 —— 但候选是从同一行筛出来的，这里不可能发生。
    // 真发生了说明库里的枚举与代码不同步：留日志，别假装成功。
    console.warn('[syllabus-drift] 候选行无法映射成 Message:', candidate.row.id)
    return null
  }
  return { ...base, payload: written.payload }
}
