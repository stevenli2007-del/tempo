/**
 * DeepSeek provider（P0-1-3，默认 provider，见 [ADR-003](../../../docs/Decisions.md#adr-003)）。
 *
 * **为什么用原生 fetch 而不是官方 SDK**：抽象层的意义就是业务代码不碰厂商概念。
 * DeepSeek 的 `/chat/completions` 是 OpenAI 兼容格式，一个 fetch 就够，
 * 没必要为此多一个依赖（`CodingRules`：不引未经批准的依赖）。
 * 切换到 Claude 时同理 —— 只换这个文件的实现，接口不动。
 *
 * **关于结构化输出**：用 DeepSeek 的 JSON Output 模式（`response_format: { type: 'json_object' }`）。
 * 它只保证「返回合法 JSON」，不保证符合 schema，所以拿到内容后**必须**再跑一遍
 * `validateJsonSchema()` —— 见 `lib/llm/schema.ts` 顶部注释。
 *
 * ⚠️ 隐私红线（`Security-Privacy.md` 第 8 节）：本文件**不打印 prompt、不打印响应正文、
 * 不打印 API key**。排障信息只取 HTTP 状态与厂商的 error.message。
 */

import { validateJsonSchema } from '../schema'
import type {
  JSONSchema,
  LLMError,
  LLMExtractParams,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMUsage,
} from '../types'

const BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
/** 抽取要稳定不要发散。调用方需要创造性时再显式传 temperature。 */
const DEFAULT_TEMPERATURE = 0

/** 错误信息里保留的响应正文长度上限。正文可能很长且含用户数据，够定位就行。 */
const DETAIL_MAX_LENGTH = 500

export type DeepSeekConfig = {
  apiKey: string
  model: string
  /** 单次请求的超时时间。超时按 `request_failed` 处理（可重试）。 */
  timeoutMs: number
  baseUrl?: string
}

type DeepSeekResponse = {
  /** 实际服务的模型。可能与请求的别名不同 —— `deepseek-chat` 这类别名会随厂商升级漂移。 */
  model?: string | null
  choices?: Array<{
    finish_reason?: string | null
    message?: { role?: string; content?: string | null } | null
  } | null>
  usage?: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
  } | null
  error?: { message?: string | null; type?: string | null; code?: string | null } | null
}

function truncate(value: string): string {
  return value.length > DETAIL_MAX_LENGTH ? `${value.slice(0, DETAIL_MAX_LENGTH)}…` : value
}

function failure(error: LLMError, usage: LLMUsage | null = null): LLMResult<never> {
  return { ok: false, error, usage }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function describeFetchError(error: unknown): string {
  if (isAbortError(error)) return '请求超时'
  if (error instanceof Error) {
    // TypeError 在这一层基本等于 DNS / 连接 / TLS 失败，message 里不含密钥，可以透出。
    return error.message
  }
  return String(error)
}

/**
 * 把厂商返回的错误体转成一句人话。
 *
 * 状态码已经能覆盖绝大多数情况，正文只作补充 —— 因为正文是厂商写的英文，
 * 直接抛给前端等于把内部细节漏出去。
 */
function describeHttpStatus(status: number, body: string): { message: string; retryable: boolean } {
  const detail = extractErrorMessage(body)
  switch (status) {
    case 401:
    case 403:
      return { message: 'LLM 服务认证失败（API key 无效或已被撤销）', retryable: false }
    case 402:
      return { message: 'LLM 服务账户余额不足，请充值后重试', retryable: false }
    case 422:
      return {
        message: `LLM 服务拒绝了请求参数${detail ? `：${detail}` : ''}`,
        retryable: false,
      }
    case 429:
      return { message: 'LLM 服务限流，请稍后重试', retryable: true }
    default:
      return {
        message: status >= 500 ? 'LLM 服务端出错，请稍后重试' : `LLM 服务返回异常状态 ${status}`,
        retryable: status >= 500,
      }
  }
}

function extractErrorMessage(body: string): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as DeepSeekResponse
    if (parsed.error?.message) return truncate(parsed.error.message)
  } catch {
    // 非 JSON 正文（例如网关的 HTML 错误页）：退化为截断后的纯文本。
  }
  return truncate(body)
}

/**
 * 模型偶尔会给 JSON 套一层 ```json 代码块。JSON Output 模式下不该发生，
 * 但剥一下的成本远低于"偶发解析失败却查不出为什么"。
 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

/**
 * 拼结构化输出指令。
 *
 * DeepSeek 的 JSON Output 模式**要求 prompt 里出现 "json" 字样**，否则可能不生效 ——
 * 这段指令天然满足，也顺手把"缺失就填 null，禁止编造"这条写死，
 * 这是 P0-1-4 五板块抽取的共同前提。
 */
function buildSchemaInstruction(schema: JSONSchema, schemaName?: string): LLMMessage {
  const name = schemaName ? `（${schemaName}）` : ''
  return {
    role: 'system',
    content: [
      '你是一个严格的 JSON 抽取器。',
      `只输出一个 JSON 对象${name}，不要输出任何解释、前后缀或 Markdown 代码块。`,
      '该对象必须符合以下 JSON Schema：',
      JSON.stringify(schema),
      '规则：',
      '1. 输出必须是可直接解析的 JSON；',
      '2. 原文中找不到或无法确定的字段一律填 null，**禁止编造**；',
      '3. 不要输出 schema 里没有的字段。',
    ].join('\n'),
  }
}

type CallOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; message: string }

/**
 * 发一次 `/chat/completions`。
 *
 * 抽成独立函数是为了让主流程保持线性：网络层的错误（超时 / 连不上）在这里就地收敛成
 * `CallOutcome`，调用方不需要靠 try/catch 的作用域推断"变量到底赋值了没有"。
 */
async function callChatCompletions(
  config: DeepSeekConfig,
  baseUrl: string,
  body: unknown,
): Promise<CallOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return { ok: true, status: response.status, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      message: `调用 DeepSeek 失败：${describeFetchError(error)}（超时上限 ${config.timeoutMs}ms）`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function createDeepSeekProvider(config: DeepSeekConfig): LLMProvider {
  const baseUrl = config.baseUrl ?? BASE_URL

  return {
    name: 'deepseek',
    model: config.model,

    async extractStructured<T>(params: LLMExtractParams): Promise<LLMResult<T>> {
      const startedAt = Date.now()

      const call = await callChatCompletions(config, baseUrl, {
        model: config.model,
        messages: [buildSchemaInstruction(params.schema, params.schemaName), ...params.messages],
        response_format: { type: 'json_object' },
        temperature: params.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
      })
      if (!call.ok) {
        return failure({ code: 'request_failed', message: call.message, retryable: true })
      }
      const responseText = call.text
      const status = call.status

      const latencyMs = Date.now() - startedAt
      // 优先记厂商实际服务的模型：别名（如 deepseek-chat）会随厂商升级悄悄换底层模型，
      // 只记别名的话，将来对比「换模型前后准确率」时数据是不可信的。
      // 失败路径拿不到响应，退回请求时的模型名。
      let servedModel = config.model
      const buildUsage = (input: number | null, output: number | null): LLMUsage => ({
        provider: 'deepseek',
        model: servedModel,
        inputTokens: input,
        outputTokens: output,
        latencyMs,
      })

      if (status < 200 || status >= 300) {
        const described = describeHttpStatus(status, responseText)
        const detail = extractErrorMessage(responseText)
        return failure({
          code: 'provider_error',
          message: described.message,
          retryable: described.retryable,
          ...(detail ? { detail } : {}),
        })
      }

      let payload: DeepSeekResponse
      try {
        payload = JSON.parse(responseText) as DeepSeekResponse
      } catch {
        return failure({
          code: 'invalid_response',
          message: 'DeepSeek 返回的不是合法 JSON',
          retryable: true,
          detail: truncate(responseText),
        })
      }

      if (payload.model) {
        servedModel = payload.model
      }

      const usage = buildUsage(
        payload.usage?.prompt_tokens ?? null,
        payload.usage?.completion_tokens ?? null,
      )

      const choice = payload.choices?.[0]
      if (choice?.finish_reason === 'content_filter') {
        return failure(
          { code: 'refused', message: 'DeepSeek 的内容安全策略拦截了这次请求', retryable: false },
          usage,
        )
      }

      const content = choice?.message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        return failure(
          {
            code: 'invalid_response',
            message: 'DeepSeek 没有返回文本内容',
            retryable: true,
            detail: choice?.finish_reason
              ? `finish_reason=${choice.finish_reason}`
              : undefined,
          },
          usage,
        )
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(stripCodeFence(content))
      } catch {
        return failure(
          {
            code: 'invalid_response',
            message: 'DeepSeek 返回的内容不是合法 JSON（可能是输出长度被截断）',
            retryable: true,
            detail: truncate(stripCodeFence(content)),
          },
          usage,
        )
      }

      const schemaError = validateJsonSchema(parsed, params.schema)
      if (schemaError) {
        return failure(
          {
            code: 'schema_mismatch',
            message: `DeepSeek 的输出不符合约定结构：${schemaError}`,
            retryable: true,
            detail: truncate(stripCodeFence(content)),
          },
          usage,
        )
      }

      return { ok: true, data: parsed as T, usage }
    },
  }
}
