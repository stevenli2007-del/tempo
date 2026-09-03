/**
 * 带审计的 LLM 调用（P0-1-3）。
 *
 * `getLLMProvider()` 只管调模型；真正被业务调用的是这里的 `runStructured()`，
 * 因为它顺手把**每次调用**都写进 `llm_runs`（`TechStack.md` 5.2 硬性要求 4）。
 *
 * 为什么必须每次都记：ADR-003 的复审条件是「DeepSeek 解析准确率不足 → 切 Claude」，
 * 而"不足"两个字必须有数据支撑 —— provider / 模型 / token / 耗时 / 失败原因。
 * 没有这张表，将来换模型就只能拍脑袋（`Database.md` 3.12）。
 *
 * ⚠️ **只存元数据，不存 prompt 与响应原文**（`Security-Privacy.md` 第 8 节）。
 * 出错时 `error_message` 里也只有错误分类与精简说明，不含 syllabus 内容。
 */

import { createClient } from '@/lib/supabase/server'

import { LLMConfigError, getLLMProvider } from './index'

import type { LLMExtractParams, LLMResult, LLMUsage } from './types'

export type LLMRunParams = LLMExtractParams & {
  /** 写进 `llm_runs.user_id`。必须来自当前会话，否则 RLS 会拒掉这一行。 */
  userId: string
  /** 调用用途，如 `syllabus_parse` / `syllabus_reparse`。列上没有 CHECK 约束，新用途直接加字面量。 */
  purpose: string
  /** prompt 版本号，如 `v1`。修正数据要能归因到具体版本，所以**必填**。 */
  promptVersion: string
  syllabusId?: string | null
}

type LLMRunInsert = {
  user_id: string
  purpose: string
  syllabus_id: string | null
  provider: string
  model: string
  prompt_version: string
  input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  status: 'success' | 'failed'
  error_message: string | null
}

const ERROR_MESSAGE_MAX_LENGTH = 500

/**
 * 落审计行。
 *
 * **失败只记日志，绝不影响调用结果** —— 度量表写不进去，不该让用户这次解析白跑一遍。
 * 用会话 client 而不是 service role：这样 RLS 依然生效，
 * 即便 `user_id` 传错了也只是写不进去，不会污染别人的数据。
 */
async function recordRun(row: LLMRunInsert): Promise<void> {
  try {
    const supabase = await createClient()
    const { error } = await supabase.from('llm_runs').insert(row)
    if (error) {
      console.error('[llm] 写入 llm_runs 失败（不影响本次调用结果）:', error.message)
    }
  } catch (error) {
    console.error('[llm] 写入 llm_runs 时抛错（不影响本次调用结果）:', error)
  }
}

/**
 * 跑一次结构化抽取并记审计。
 *
 * **不会抛异常**：配置错误、网络失败、厂商错误、schema 不符，一律回到
 * `LLMResult` 的 error 分支。调用方只看 `ok`。
 */
export async function runStructured<T>(params: LLMRunParams): Promise<LLMResult<T>> {
  const { userId, purpose, promptVersion, syllabusId = null, ...extractParams } = params

  let provider
  try {
    provider = getLLMProvider()
  } catch (error) {
    // 配置坏了：provider / model 都还不知道，而 llm_runs 这两列是 NOT NULL，
    // 编不出有意义的值，因此**不落审计行**，只留服务端日志。
    const message = error instanceof LLMConfigError ? error.message : 'LLM 配置读取失败'
    console.error('[llm] 配置错误，未发起调用:', message)
    return {
      ok: false,
      error: { code: 'config_error', message, retryable: false },
      usage: null,
    }
  }

  const startedAt = Date.now()
  const result = await provider.extractStructured<T>(extractParams)
  const fallbackLatencyMs = Date.now() - startedAt

  const usage: LLMUsage = result.usage ?? {
    provider: provider.name,
    model: provider.model,
    inputTokens: null,
    outputTokens: null,
    latencyMs: fallbackLatencyMs,
  }

  await recordRun({
    user_id: userId,
    purpose,
    syllabus_id: syllabusId,
    // ⚠️ 用 usage 里「实际服务的模型」，而不是 provider 上「请求时填的模型」：
    // `deepseek-chat` 这类别名会静默指向不同底座（本次实测返回 `deepseek-v4-flash`），
    // 记别名的话将来按模型对比准确率就失真了。只有拿不到 usage 时才退回配置值。
    provider: usage.provider,
    model: usage.model,
    prompt_version: promptVersion,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    latency_ms: usage.latencyMs,
    status: result.ok ? 'success' : 'failed',
    error_message: result.ok
      ? null
      : `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX_LENGTH),
  })

  if (!result.ok) {
    console.error('[llm] 调用失败:', {
      purpose,
      provider: provider.name,
      model: provider.model,
      code: result.error.code,
      message: result.error.message,
    })
  }

  return result
}
