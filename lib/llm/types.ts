/**
 * LLM 抽象层类型（P0-1-3）。
 *
 * 依据 [ADR-003](../../docs/Decisions.md#adr-003)：默认 DeepSeek，效果不达标可切 Claude，
 * **切换只改环境变量，不动业务代码**。因此这一层的类型不能出现任何厂商特有的概念。
 *
 * 硬性要求（`TechStack.md` 5.2）：
 * 1. 业务代码只依赖 `LLMProvider` 接口，不 import 厂商 SDK
 * 2. 切换 provider 只改配置
 * 3. 返回 `LLMResult<T>`，**不允许厂商异常穿透到业务层**
 * 4. 每次调用记录 provider / 模型 / token / 耗时（写 `llm_runs`，见 `run.ts`）
 * 5. 结构化输出走 JSON schema 约束，**禁止"自由描述 + 正则解析"**
 */

/**
 * 已支持的 provider 标识。
 *
 * ⚠️ 目前**只有 `deepseek` 真正实现了 adapter**；`claude` 是 ADR-003 的兜底方案，
 * 先占好位置，切换时不需要改类型。
 */
export type LLMProviderName = 'deepseek' | 'claude'

// ---------------------------------------------------------------
// JSON Schema（受支持的子集）
// ---------------------------------------------------------------

export type JSONSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'

/**
 * 受支持的 JSON Schema 子集。
 *
 * 只覆盖抽取场景真正会用到的关键字：**不是完整的 JSON Schema 实现**，
 * 缺 `oneOf` / `pattern` / `minimum` 等。加关键字前先想清楚是否真的需要 ——
 * schema 同时会拼进 prompt 发给模型，越复杂模型越容易跑偏。
 *
 * 数组字段一律接受 readonly：schema 通常是模块级 `as const` 常量，
 * 不给这个口子的话每个调用方都得被迫去掉 `as const`。
 */
export type JSONSchema = {
  /** 允许数组形式（如 `['string', 'null']`）表达可空字段 —— 抽取场景里"没有就填 null"是常态。 */
  type?: JSONSchemaType | readonly JSONSchemaType[]
  description?: string
  properties?: Record<string, JSONSchema>
  required?: readonly string[]
  items?: JSONSchema
  enum?: readonly (string | number | boolean | null)[]
}

// ---------------------------------------------------------------
// 请求 / 响应
// ---------------------------------------------------------------

export type LLMMessageRole = 'system' | 'user' | 'assistant'

export type LLMMessage = {
  role: LLMMessageRole
  content: string
}

export type LLMExtractParams = {
  /** 输出必须匹配的 schema。会同时用于约束模型输出与校验返回值。 */
  schema: JSONSchema
  /** schema 的名字，拼进指令里帮模型理解（如 `GradeComposition`）。可选。 */
  schemaName?: string
  messages: LLMMessage[]
  /** 抽取场景默认 0（要稳定不要发散），调用方需要创造性时再调高。 */
  temperature?: number
  maxOutputTokens?: number
}

/** 单次调用的资源消耗。ADR-003 的复审条件（要不要切 Claude）依赖这些数据。 */
export type LLMUsage = {
  provider: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number
}

export type LLMErrorCode =
  /** 环境变量缺失 / provider 名不认识 / provider 未实现。**配置问题，重试无用。** */
  | 'config_error'
  /** 网络不可达或超时。可重试。 */
  | 'request_failed'
  /** 厂商返回非 2xx（401 key 无效 / 429 限流 / 5xx）。429 与 5xx 可重试。 */
  | 'provider_error'
  /** 响应结构不对，或内容不是合法 JSON。 */
  | 'invalid_response'
  /** JSON 合法但不符合 schema —— 模型跑了偏。可重试（换次采样可能就对了）。 */
  | 'schema_mismatch'
  /** 被内容安全策略拦截。 */
  | 'refused'

export type LLMError = {
  code: LLMErrorCode
  /** 面向人的中文说明。可直接进日志；**不含密钥、不含 syllabus 原文**。 */
  message: string
  retryable: boolean
  /** 厂商返回的原始错误摘要（已剔除密钥），排障用。可能为空。 */
  detail?: string
}

/**
 * 统一结果类型。业务层必须判 `ok`，**不会有任何厂商异常从这里抛出去**。
 */
export type LLMResult<T> =
  | { ok: true; data: T; usage: LLMUsage }
  | { ok: false; error: LLMError; usage: LLMUsage | null }

// ---------------------------------------------------------------
// Provider 接口
// ---------------------------------------------------------------

/**
 * 所有 LLM provider 的统一接口。
 *
 * ⚠️ 业务代码**只能**依赖这个接口，不得 import 任何厂商 SDK。
 * 目前只有 DeepSeek 实现；Claude adapter 尚未实现，`getLLMProvider()` 会给出明确报错。
 */
export interface LLMProvider {
  /** 写进 `llm_runs.provider` 的名字，如 `deepseek`。 */
  readonly name: string
  /** 写进 `llm_runs.model` 的具体模型名，如 `deepseek-chat`。 */
  readonly model: string

  /**
   * 结构化抽取：传入 messages + JSON schema，返回**符合 schema** 的对象。
   *
   * 失败一律降级为 `LLMResult` 的 error 分支，**不抛异常**。
   */
  extractStructured<T>(params: LLMExtractParams): Promise<LLMResult<T>>
}
