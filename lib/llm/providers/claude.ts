/**
 * Claude provider（P0-3-9，关闭 O-11，见 [ADR-018](../../../docs/Decisions.md#adr-018)）。
 *
 * **为什么用原生 fetch 而不是官方 SDK**：与 `deepseek.ts` 同构 —— 抽象层的意义就是
 * 业务代码不碰厂商概念。Anthropic Messages API 一个 fetch 就够，没必要多一个依赖
 * （`CodingRules`：不引未经批准的依赖）。
 *
 * **两个与 OpenAI 兼容格式的关键差异**（写错就 400）：
 * 1. `system` 是**顶层参数**，不是 messages 里的一个 role。
 * 2. `max_tokens` **必填**（没有「不限制」这回事）。
 * 3. 多模态图片块：`{ type:'image', source:{ type:'base64', media_type, data } }`。
 *
 * 默认模型 `claude-sonnet-5` 取自 Anthropic 官方文档（所有当前模型均支持图像输入），
 * 可用 `LLM_MODEL_VISION` 覆写为更省的 `claude-haiku-4-5`。
 *
 * ⚠️ 隐私红线（`Security-Privacy.md` 第 8 节）：本文件**不打印 prompt、不打印响应正文、
 * 不打印 API key**。排障信息只取 HTTP 状态与厂商的 error.message。
 */

import { validateJsonSchema } from '../schema'
import type {
  JSONSchema,
  LLMError,
  LLMCapability,
  LLMExtractParams,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMUsage,
} from '../types'

const BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
/** 抽取要稳定不要发散。调用方需要创造性时再显式传 temperature。 */
const DEFAULT_TEMPERATURE = 0

/** 错误信息里保留的响应正文长度上限。正文可能很长且含用户数据，够定位就行。 */
const DETAIL_MAX_LENGTH = 500

export type ClaudeConfig = {
  apiKey: string
  model: string
  /** 单次请求的超时时间。超时按 `request_failed` 处理（可重试）。 */
  timeoutMs: number
  baseUrl?: string
}

type ClaudeResponse = {
  /** 实际服务的模型。可能与请求的别名不同。 */
  model?: string | null
  type?: string | null
  /** text 型消息回 `content: [{ type:'text', text }]`，这里只取 text 块。 */
  content?: Array<{ type?: string | null; text?: string | null } | null> | null
  stop_reason?: string | null
  usage?: {
    input_tokens?: number | null
    output_tokens?: number | null
    input_tokens_details?: { images?: number | null } | null
  } | null
  error?: { message?: string | null; type?: string | null } | null
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
    const parsed = JSON.parse(body) as ClaudeResponse
    if (parsed.error?.message) return truncate(parsed.error.message)
  } catch {
    // 非 JSON 正文（例如网关的 HTML 错误页）：退化为截断后的纯文本。
  }
  return truncate(body)
}

/**
 * 拼结构化输出指令（作为顶层 `system`）。
 *
 * 与 DeepSeek 同构：要求只输出 JSON、缺失填 null、禁止编造 ——
 * 这是 P0-1-4 五板块抽取与本卡截图抽取的共同前提。
 */
function buildSchemaInstruction(schema: JSONSchema, schemaName?: string): string {
  const name = schemaName ? `（${schemaName}）` : ''
  return [
    '你是一个严格的 JSON 抽取器。',
    `只输出一个 JSON 对象${name}，不要输出任何解释、前后缀或 Markdown 代码块。`,
    '该对象必须符合以下 JSON Schema：',
    JSON.stringify(schema),
    '规则：',
    '1. 输出必须是可直接解析的 JSON；',
    '2. 原文中找不到或无法确定的字段一律填 null，**禁止编造**；',
    '3. 不要输出 schema 里没有的字段。',
  ].join('\n')
}

/**
 * 把业务侧的 `LLMMessage.content`（`string | LLMContentPart[]`）映射到 Claude 的 content 数组。
 *
 * - 纯 `string` → `[{ type:'text', text }]`
 * - 块数组 → text 块直接透传；image 块转成 Claude 的 base64 source 格式。
 */
function toClaudeContent(content: LLMMessage['content']): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mediaType,
        data: part.dataBase64,
      },
    }
  })
}

type CallOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; message: string }

/**
 * 发一次 `/v1/messages`。抽成独立函数是为了让主流程保持线性（与 DeepSeek 同构）。
 */
async function callMessages(
  config: ClaudeConfig,
  baseUrl: string,
  body: unknown,
): Promise<CallOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': API_VERSION,
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return { ok: true, status: response.status, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      message: `调用 Claude 失败：${describeFetchError(error)}（超时上限 ${config.timeoutMs}ms）`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function createClaudeProvider(config: ClaudeConfig): LLMProvider {
  const baseUrl = config.baseUrl ?? BASE_URL
  const capabilities: readonly LLMCapability[] = ['text', 'vision']

  return {
    name: 'claude',
    model: config.model,
    capabilities,

    async extractStructured<T>(params: LLMExtractParams): Promise<LLMResult<T>> {
      const startedAt = Date.now()

      // 把 messages 拆成顶层 system + 其余消息。Claude 的 system 是顶层参数，不是 role。
      const systemParts = params.messages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')))
      const system = systemParts.join('\n\n') || undefined

      const nonSystemMessages = params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: toClaudeContent(m.content) }))

      // 顶层 system 与 messages 里的 system 二选一：Messages API 不允许 system 出现在 messages 里。
      const call = await callMessages(config, baseUrl, {
        model: config.model,
        system,
        messages: nonSystemMessages,
        max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: params.temperature ?? DEFAULT_TEMPERATURE,
      })
      if (!call.ok) {
        return failure({ code: 'request_failed', message: call.message, retryable: true })
      }
      const responseText = call.text
      const status = call.status

      const latencyMs = Date.now() - startedAt
      let servedModel = config.model
      const buildUsage = (input: number | null, output: number | null): LLMUsage => ({
        provider: 'claude',
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

      let payload: ClaudeResponse
      try {
        payload = JSON.parse(responseText) as ClaudeResponse
      } catch {
        return failure({
          code: 'invalid_response',
          message: 'Claude 返回的不是合法 JSON',
          retryable: true,
          detail: truncate(responseText),
        })
      }

      if (payload.model) {
        servedModel = payload.model
      }

      // 图片 token 计入 input_tokens（Anthropic 在 input_tokens_details.images 另给明细，但总数已在 input_tokens）。
      const usage = buildUsage(
        payload.usage?.input_tokens ?? null,
        payload.usage?.output_tokens ?? null,
      )

      if (payload.type === 'error') {
        const detail = payload.error?.message ? truncate(payload.error.message) : undefined
        return failure(
          { code: 'provider_error', message: 'Claude 返回了错误响应', retryable: false, ...(detail ? { detail } : {}) },
          usage,
        )
      }

      if (payload.stop_reason === 'content_filter') {
        return failure(
          { code: 'refused', message: 'Claude 的内容安全策略拦截了这次请求', retryable: false },
          usage,
        )
      }

      const text = payload.content
        ?.filter((block) => block?.type === 'text')
        .map((block) => block?.text ?? '')
        .join('')
        .trim()

      if (!text) {
        return failure(
          {
            code: 'invalid_response',
            message: 'Claude 没有返回文本内容',
            retryable: true,
            detail: payload.stop_reason ? `stop_reason=${payload.stop_reason}` : undefined,
          },
          usage,
        )
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return failure(
          {
            code: 'invalid_response',
            message: 'Claude 返回的内容不是合法 JSON（可能是输出长度被截断）',
            retryable: true,
            detail: truncate(text),
          },
          usage,
        )
      }

      const schemaError = validateJsonSchema(parsed, params.schema)
      if (schemaError) {
        return failure(
          {
            code: 'schema_mismatch',
            message: `Claude 的输出不符合约定结构：${schemaError}`,
            retryable: true,
            detail: truncate(text),
          },
          usage,
        )
      }

      return { ok: true, data: parsed as T, usage }
    },
  }
}
