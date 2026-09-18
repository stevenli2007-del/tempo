/**
 * 逐题「讲解这道题的解法」的生成（P0-3-23）—— 懒生成 + 落库缓存。
 *
 * ### 触发时机：用户点了某一题的「讲解」
 * 卷子可能有二十道题，而他要讲的通常只有一两道。所以讲解**不进生成路径**：
 * 生成时只切题 + 配答案（那是**事实**），讲解是**按需的增强**。
 * 范式与 ADR-024（公告要点）/ ADR-026（课件总结）完全一致：点开才算、算完落库、
 * 之后再点就走缓存。
 *
 * ### 🔴 与切题那一层最大的不同：讲解**不需要碰 Canvas**
 * 题干与答案已经在 `practice_tests.paper` 里了，所以这条链路只有"读缓存 → 调模型 → 写缓存"，
 * 没有下载、没有抽取、没有凭据。快得多（一次模型调用），也少一整类失败。
 *
 * ### 🔴 `status = 'failed'` 的语义是"别再问了"
 * 模型对某一题持续给不出符合 schema 的结果时，落一行 `failed`；
 * 下次点它直接返回那个结论，**不再打模型**。否则用户每点一次都在为一个
 * 模型解不动的题重复烧钱，而他看不出任何异常。
 * 要重试就删掉那一行：
 *   `delete from practice_test_explanations where practice_test_id = '…' and question_key = 'q3'`
 */

import { DEFAULT_SUMMARY_LOCALE } from '@/lib/course-files/summary/locale'
import { runStructured } from '@/lib/llm/run'

import type { PracticeExplanation, PracticePaper, PracticeQuestion } from './paper'
import type { SummaryLocale } from '@/lib/course-files/summary/locale'

import {
  EXPLANATION_PROMPT_VERSION,
  buildExplanationInput,
  buildExplanationMessages,
  explanationSchema,
  validateExplanationOutput,
} from './prompt'
import { loadExplanation, saveExplanation } from './store'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 写进 `llm_runs.purpose`（那列没有 CHECK 约束，新用途直接加字面量）。 */
const PURPOSE = 'practice_explanation'

/** `error_message` 上限（同 `llm_runs` 的纪律：精简、不含用户内容）。 */
const ERROR_MESSAGE_MAX = 200

export type ExplanationOutcome =
  | { status: 'ready'; explanation: PracticeExplanation; cached: boolean }
  | { status: 'failed'; message: string }

/** 在卷面上按稳定键找一题。找不到返回 `null`（调用方必须当 400 处理，不是静默忽略）。 */
export function findQuestion(
  paper: PracticePaper,
  questionKey: string,
): PracticeQuestion | null {
  return paper.questions.find((question) => question.key === questionKey) ?? null
}

/**
 * 生成（或命中缓存）一题的讲解。**不抛异常**，失败一律收敛成 `ExplanationOutcome`。
 *
 * 幂等：同一题重复点，缓存命中直接返回（`cached: true`），不花钱。
 */
export async function ensureExplanation(params: {
  supabase: ServerSupabase
  userId: string
  practiceTestId: string
  courseName: string
  paper: PracticePaper
  questionKey: string
  locale?: SummaryLocale
}): Promise<ExplanationOutcome> {
  const locale = params.locale ?? DEFAULT_SUMMARY_LOCALE
  const { supabase, userId, practiceTestId, questionKey } = params

  const question = findQuestion(params.paper, questionKey)
  if (!question) {
    // 题号对不上**只可能是**卷面被重新生成过（键按顺序走，见 `questionKey()` 的注释）。
    // 这时缓存里的讲解属于另一道题 —— 宁可让用户刷新，也不能拿旧讲解去配新题。
    return { status: 'failed', message: '找不到这道题（卷面可能已更新，刷新页面再试）。' }
  }

  // ---------- 1) 缓存 ----------
  const { explanation: cached, error: cacheError } = await loadExplanation(
    supabase,
    practiceTestId,
    questionKey,
    locale,
  )
  if (cacheError) {
    // 迁移没跑（42P01）会走到这里。**不降级成"没缓存"直接开算** ——
    // 那会让用户看到一个结果、但每次点开都重新花钱。如实报出来。
    return { status: 'failed', message: `读取讲解缓存失败：${cacheError}` }
  }
  if (cached) {
    if (cached.status === 'ok') {
      return { status: 'ready', explanation: cached.explanation, cached: true }
    }
    return { status: 'failed', message: cached.errorMessage ?? '这一题上次没能讲出来。' }
  }

  // ---------- 2) 调模型 ----------
  const input = buildExplanationInput({
    courseName: params.courseName,
    paperTitle: params.paper.title,
    questionNumber: question.number,
    questionText: question.text,
    officialAnswer: question.answer,
  })

  const result = await runStructured<unknown>({
    userId,
    purpose: PURPOSE,
    promptVersion: EXPLANATION_PROMPT_VERSION,
    capability: 'text',
    schema: explanationSchema(),
    schemaName: 'PracticeExplanation',
    messages: buildExplanationMessages(input),
    // 要的是**跟着给定答案讲一遍**，不是自由发挥；温度一高就会开始"补充知识点"。
    temperature: 0,
    maxOutputTokens: 900,
  })

  if (!result.ok) {
    const message = `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX)
    console.error('[practice-test] 讲解调用模型失败:', practiceTestId, questionKey, message)
    // ⚠️ 429 / 超时 / 5xx **不落 failed 行**：下次可能就好了。
    if (result.error.code === 'schema_mismatch' || result.error.code === 'refused') {
      await persistFailure({ supabase, practiceTestId, questionKey, locale, message })
    }
    return { status: 'failed', message: `讲解生成失败：${result.error.message}` }
  }

  const validated = validateExplanationOutput(result.data)
  if (!validated.ok) {
    const message = validated.message.slice(0, ERROR_MESSAGE_MAX)
    await persistFailure({ supabase, practiceTestId, questionKey, locale, message })
    return { status: 'failed', message: `AI 没能讲出这一题（${validated.message}）。` }
  }

  if (validated.dropped > 0) {
    // 不拦（已给的照常展示），但留痕：模型开始写超长/写废话是 prompt 该修的早期信号。
    console.warn(
      `[practice-test] 讲解多写/写超了 ${validated.dropped} 条，已丢弃:`,
      practiceTestId,
      questionKey,
    )
  }

  // ---------- 3) 落库 ----------
  const saved = await saveExplanation({
    supabase,
    practiceTestId,
    questionKey,
    locale,
    status: 'ok',
    explanation: validated.value,
    model: result.usage.model,
    errorMessage: null,
  })
  if (saved.error) {
    // 写不进去 = 这次白算（下次还要重算）。降级继续：本次结果照样给用户看，但日志要响。
    console.error('[practice-test] 讲解写入缓存失败（本次结果仍会显示，但下次会重算）:', saved.error)
  }

  return { status: 'ready', explanation: validated.value, cached: false }
}

/** 落一行确定性失败（= 别再问了）。 */
async function persistFailure(params: {
  supabase: ServerSupabase
  practiceTestId: string
  questionKey: string
  locale: SummaryLocale
  message: string
}): Promise<void> {
  const { error } = await saveExplanation({
    supabase: params.supabase,
    practiceTestId: params.practiceTestId,
    questionKey: params.questionKey,
    locale: params.locale,
    status: 'failed',
    explanation: { steps: [], concepts: [] },
    model: null,
    errorMessage: params.message.slice(0, ERROR_MESSAGE_MAX),
  })

  if (error) {
    console.error('[practice-test] 写入讲解失败标记失败（会导致下次重试）:', error)
  }
}
