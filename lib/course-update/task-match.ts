import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import type { TaskCandidate, TaskMatch } from '@/types/task'
import { matchTasks } from '@/lib/tasks/match'

/**
 * 作业改期的**匹配判定层**（P0-5-5 ②）—— 纯函数，与 `exam-match.ts` 同构。
 *
 * ### 它解决什么
 * 老师说「Homework 3 改到 9/27」，而库里已有一条 `Homework 3 · 9/25`。
 * 公告路径原先对作业类**什么都不写**，只回一句「请用对话框确认」（P0-3-36 记档）。
 * 本模块在写之前回答：这条输入应当落到哪一行、那一行**能不能写**。
 *
 * ### 🔴 只做「改期」，不做「新增」
 * 与考试那张卡（3-29）不同，这里 0 命中就是 `unmatched`，**不新增任务**。
 * 理由：公告是**无人编辑**的通道，用户看到的只是「改哪一条」。凭一句公告凭空
 * 建一条作业，比"没写"危险 —— 而"没写"至少会被回执如实说出来。
 *
 * ### 🔴 可写判据只有一条，且与对话框共用
 * `canEditTask()` = `manual + 非派生`。它原先只活在客户端组件里
 * （`use-course-update-flow.ts` 的 `isEditable`），收到这里之后两端同一份：
 * - **canvas 来源**：改了会被下一轮同步按 Canvas 的值覆盖（同步是权威），
 *   写了也白写 —— 所以**出提案但标不可写**，并如实说明去 Canvas 改（Steven 拍板）；
 * - **派生（考试）**：内容归 `exam_dates` 管，改 tasks 会被派生链重写（ADR-004）。
 *
 * ### 匹配仍然复用 `matchTasks()`，不另写一套
 * 对话框的检索走的就是它（确定性、零 LLM）。两条路各判一次就是分叉
 * （CodingRules §10.1 第 21 条的形状）。
 * ⚠️ 它按相似度召回 —— 这条路**有人确认**（用户点的是写好的提案），召回优先是合理的；
 * 但多命中时绝不替用户挑，一律 `ambiguous` 列出来。
 */

/** 一条待写入的作业改期（只要匹配用得到的字段）。 */
export type TaskMatchInput = {
  title: string
  dueDate: string | null
  notes: string | null
  /** 逐字原文摘录（与考试同款，进回执让用户核对）。 */
  sourceExcerpt: string
  /**
   * 用户显式指定的目标行。
   * - `undefined` = 没挑 → 由本模块检索；
   * - `string` = 指定这一条 → 强制走它（不可写就报原因，绝不退化成新增）。
   */
  targetTaskId?: string | null
}

/**
 * 解析结果。
 *
 * | kind | 含义 | 写入器做什么 |
 * |---|---|---|
 * | `update` | 唯一命中**可写**行 → 改期 | update 那一行 + 留旧值快照 |
 * | `duplicate` | 命中且日期已经是这个值 | 不写，回执点名 |
 * | `ambiguous` | 多个可写候选 | 不写，列出来让人挑 |
 * | `unmatched` | 这门课没有对得上的任务 | 不写（本卡不新增） |
 * | `blocked_canvas` | 只命中 Canvas 同步来的行 | 不写，如实说明去 Canvas 改 |
 * | `blocked_derived` | 只命中派生行（考试） | 不写，指向课程页 |
 * | `missing` | 指定了目标行但它不在 | 不写，回执点名 |
 */
export type TaskResolutionKind =
  | 'update'
  | 'duplicate'
  | 'ambiguous'
  | 'unmatched'
  | 'blocked_canvas'
  | 'blocked_derived'
  | 'missing'

export type TaskResolution = {
  task: TaskMatchInput
  kind: TaskResolutionKind
  /** `update` / `duplicate` 时命中的那一行。 */
  target: TaskMatch | null
  /** `ambiguous` 时供人挑选的候选。 */
  candidates: TaskMatch[]
  /** 不写的原因（人话，直接进回执）。`update` 时为 null。 */
  reason: string | null
}

/**
 * 这一行**能被 Tempo 改期**吗 —— 全站唯一判据。
 *
 * 客户端对话框（候选列表里哪些可选）与服务端公告写入器共用它。
 * 各写一份的结果必然是：界面上能改的、公告里说不能写，用户不知道该信谁。
 */
export function canEditTask(row: Pick<TaskCandidate, 'source' | 'isDerived'>): boolean {
  return row.source === 'manual' && !row.isDerived
}

/** 不可写时的人话原因（可写则返回 null）。与 `canEditTask` 同源，不另判一次。 */
export function taskEditBlockedReason(
  row: Pick<TaskCandidate, 'source' | 'isDerived'>,
  lang: Lang = 'zh',
): string | null {
  if (canEditTask(row)) return null
  if (row.isDerived) return t(lang, 'task.blockedDerived')
  if (row.source === 'canvas') return t(lang, 'task.blockedCanvas')
  return t(lang, 'task.blockedSyllabus')
}

/** 只留下可写的候选（顺序保持 —— `matchTasks` 已按分降序，且 JS sort 稳定）。 */
function writableOnly(matches: TaskMatch[]): TaskMatch[] {
  return matches.filter(canEditTask)
}

export function resolveTaskTargets(
  inputs: TaskMatchInput[],
  existing: TaskCandidate[],
  options: { lang?: Lang } = {},
): TaskResolution[] {
  const lang = options.lang ?? 'zh'
  const claimed = new Set<string>()
  const results: TaskResolution[] = []

  for (const task of inputs) {
    // ---------- 用户显式指定 ----------
    if (typeof task.targetTaskId === 'string') {
      const row = existing.find((item) => item.id === task.targetTaskId)
      if (!row) {
        results.push({
          task,
          kind: 'missing',
          target: null,
          candidates: [],
          reason: t(lang, 'task.missing'),
        })
        continue
      }
      const blocked = taskEditBlockedReason(row, lang)
      if (blocked) {
        results.push({ task, kind: row.isDerived ? 'blocked_derived' : 'blocked_canvas', target: { ...row, score: 1 }, candidates: [], reason: blocked })
        continue
      }
      if (claimed.has(row.id)) {
        results.push({
          task,
          kind: 'duplicate',
          target: { ...row, score: 1 },
          candidates: [],
          reason: t(lang, 'task.claimed'),
        })
        continue
      }
      claimed.add(row.id)
      results.push({ task, kind: 'update', target: { ...row, score: 1 }, candidates: [], reason: null })
      continue
    }

    // ---------- 检索 ----------
    const matches = matchTasks(task.title, existing)
    if (matches.length === 0) {
      results.push({
        task,
        kind: 'unmatched',
        target: null,
        candidates: [],
        reason: t(lang, 'task.unmatched'),
      })
      continue
    }

    const writable = writableOnly(matches)
    const available = writable.filter((m) => !claimed.has(m.id))

    if (available.length === 1) {
      const row = available[0]!
      if (row.dueDate === task.dueDate) {
        results.push({
          task,
          kind: 'duplicate',
          target: row,
          candidates: [],
          reason: t(lang, 'task.sameDueDate'),
        })
        continue
      }
      claimed.add(row.id)
      results.push({ task, kind: 'update', target: row, candidates: [], reason: null })
      continue
    }

    if (available.length > 1) {
      results.push({
        task,
        kind: 'ambiguous',
        target: null,
        candidates: available,
        reason: t(lang, 'task.ambiguous', { count: available.length }),
      })
      continue
    }

    // 🔴 可写候选**存在**但已被本批前面那条占了 → 这是「已占」（duplicate），
    // 不是「不可写」（blocked）。两者给用户的行动完全不同：前者什么都不用做，
    // 后者得去 Canvas / 课程页改。混在一起会让用户白跑一趟。
    if (writable.length > 0) {
      results.push({
        task,
        kind: 'duplicate',
        target: writable[0]!,
        candidates: [],
        reason: t(lang, 'task.claimed'),
      })
      continue
    }

    // 有命中、但没有一条可写 → 如实说出"为什么写不了"，而不是当成"没匹配到"。
    //
    // 🔴 这里刻意区分 blocked 与 unmatched：两者在界面上都"不写"，
    // 但给用户的行动完全不同 —— 前者要去 Canvas / 课程页改，后者是 Tempo 里没这条。
    const first = matches[0]!
    results.push({
      task,
      kind: first.isDerived ? 'blocked_derived' : 'blocked_canvas',
      target: first,
      candidates: [],
      reason: taskEditBlockedReason(first, lang),
    })
  }

  return results
}

/** 改期的那句人话（`Homework 3 2026-09-25 → 2026-09-27`）。 */
export function taskChangeLabel(task: TaskMatchInput, target: TaskCandidate): string {
  const before = target.dueDate ?? t('zh', 'exam.tbd')
  const after = task.dueDate ?? t('zh', 'exam.tbd')
  return `${task.title} ${before} → ${after}`
}
