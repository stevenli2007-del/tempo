/**
 * Qwen (通义千问) provider（P0-3-9 视觉档默认 provider，见 [ADR-018](../../../docs/Decisions.md#adr-018)）。
 *
 * **为什么用原生 fetch 而不是官方 SDK**：与 `deepseek.ts` / `claude.ts` 同构 ——
 * 抽象层的意义就是业务代码不碰厂商概念。Qwen 的 DashScope 提供 **OpenAI 兼容端点**
 * （`/compatible-mode/v1/chat/completions`），格式与 DeepSeek 一致，一个 fetch 就够，
 * 没必要为此多一个依赖（`CodingRules`：不引未经批准的依赖）。
 *
 * **与 deepseek.ts 的唯一差异**：内容块映射。DeepSeek 是纯文本（不会收到图片块），
 * Qwen VL 会收到 `image` 块 —— 这里先把 `LLMContentPart[]` 转成 OpenAI 的
 * `{ type:'image_url', image_url:{ url:'data:...;base64,...' } }` 格式，再原样发。
 *
 * 默认模型 `qwen-vl-plus-latest` 取自 DashScope 官方文档（视觉多模态）。
 *
 * ⚠️ 隐私红线（`Security-Privacy.md` 第 8 节）：本文件**不打印 prompt、不打印响应正文、
 * 不打印 API key**。排障信息只取 HTTP 状态与厂商的 error.message。
 * ⚠️ 数据出境（O-08，已解决）：截图原图与识别结果**不出境**，全程走阿里云中国区 DashScope。
 */

import { validateJsonSchema } from '../schema'
import type {
  JSONSchema,
  LLMCapability,
  LLMError,
  LLMExtractParams,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMUsage,
} from '../types'

const BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
/** 抽取要稳定不要发散。调用方需要创造性时再显式传 temperature。 */
const DEFAULT_TEMPERATURE = 0

/** 错误信息里保留的响应正文长度上限。正文可能很长且含用户数据，够定位就行。 */
const DETAIL_MAX_LENGTH = 500

export type QwenConfig = {
  apiKey: string
  model: string
  /** 单次请求的超时时间。超时按 `request_failed` 处理（可重试）。 */
  timeoutMs: number
  baseUrl?: string
}

type QwenResponse = {
  /** 实际服务的模型。可能与请求的别名不同。 */
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
    const parsed = JSON.parse(body) as QwenResponse
    if (parsed.error?.message) return truncate(parsed.error.message)
  } catch {
    // 非 JSON 正文（例如网关的 HTML 错误页）：退化为截断后的纯文本。
  }
  return truncate(body)
}

/**
 * 拼结构化输出指令（system role）。与 DeepSeek 同构：要求只输出 JSON、缺失填 null、禁止编造。
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

/**
 * 把业务侧的 `LLMMessage.content`（`string | LLMContentPart[]`）映射到 OpenAI 兼容格式。
 *
 * - 纯 `string` → 原样（OpenAI 接受 `string` 或 `content` 块数组）
 * - 块数组 → text 块直传；image 块转成 `image_url`，base64 拼成 `data:` URL 直传即用即弃。
 */
function toOpenAIMessages(messages: LLMMessage[]): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content }
    }
    return {
      role: m.role,
      content: m.content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` } },
      ),
    }
  })
}

type CallOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; message: string }

/**
 * 发一次 `/compatible-mode/v1/chat/completions`。抽成独立函数是为了让主流程保持线性（与 DeepSeek 同构）。
 */
async function callChatCompletions(
  config: QwenConfig,
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
      message: `调用 Qwen 失败：${describeFetchError(error)}（超时上限 ${config.timeoutMs}ms）`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function createQwenProvider(config: QwenConfig): LLMProvider {
  const baseUrl = config.baseUrl ?? BASE_URL
  const capabilities: readonly LLMCapability[] = ['vision']

  return {
    name: 'qwen',
    model: config.model,
    capabilities,

    async extractStructured<T>(params: LLMExtractParams): Promise<LLMResult<T>> {
      const startedAt = Date.now()

      const call = await callChatCompletions(config, baseUrl, {
        model: config.model,
        messages: [buildSchemaInstruction(params.schema, params.schemaName), ...toOpenAIMessages(params.messages)],
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
      let servedModel = config.model
      const buildUsage = (input: number | null, output: number | null): LLMUsage => ({
        provider: 'qwen',
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

      let payload: QwenResponse
      try {
        payload = JSON.parse(responseText) as QwenResponse
      } catch {
        return failure({
          code: 'invalid_response',
          message: 'Qwen 返回的不是合法 JSON',
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
          { code: 'refused', message: 'Qwen 的内容安全策略拦截了这次请求', retryable: false },
          usage,
        )
      }

      const content = choice?.message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        return failure(
          {
            code: 'invalid_response',
            message: 'Qwen 没有返回文本内容',
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
        parsed = JSON.parse(content)
      } catch {
        return failure(
          {
            code: 'invalid_response',
            message: 'Qwen 返回的内容不是合法 JSON（可能是输出长度被截断）',
            retryable: true,
            detail: truncate(content),
          },
          usage,
        )
      }

      const schemaError = validateJsonSchema(parsed, params.schema)
      if (schemaError) {
        return failure(
          {
            code: 'schema_mismatch',
            message: `Qwen 的输出不符合约定结构：${schemaError}`,
            retryable: true,
            detail: truncate(content),
          },
          usage,
        )
      }

      return { ok: true, data: parsed as T, usage }
    },
  }
}
