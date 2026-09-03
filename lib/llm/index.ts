/**
 * LLM 抽象层对外入口（P0-1-3）。
 *
 * 业务代码**只**从这里拿 provider：
 *
 * ```ts
 * import { getLLMProvider } from '@/lib/llm'
 * const result = await getLLMProvider().extractStructured({ schema, messages })
 * ```
 *
 * 需要把调用写进 `llm_runs`（绝大多数情况）时改用 `@/lib/llm/run` 的 `runStructured()`，
 * 它会在调用前后自动落审计行。
 *
 * 切换 provider 只改环境变量 `LLM_PROVIDER`，**不改任何业务代码**（[ADR-003](../../docs/Decisions.md#adr-003)）。
 */

import { LLMConfigError, getLLMEnv } from './env'
import { createDeepSeekProvider } from './providers/deepseek'

import type { LLMProvider } from './types'

export { LLMConfigError } from './env'
export { validateJsonSchema } from './schema'
export type {
  JSONSchema,
  JSONSchemaType,
  LLMError,
  LLMErrorCode,
  LLMExtractParams,
  LLMMessage,
  LLMMessageRole,
  LLMProvider,
  LLMProviderName,
  LLMResult,
  LLMUsage,
} from './types'

/**
 * 按环境变量构造当前 provider。
 *
 * @throws {LLMConfigError} 环境变量缺失、`LLM_PROVIDER` 不认识、或该 provider 的 adapter 未实现。
 *   这是**故意**的快速失败：key 没配对属于部署问题，早崩好过让每个请求都失败一次。
 *   不想接异常的话用 `runStructured()`，它会把配置错误统一收敛成 `config_error` 结果。
 */
export function getLLMProvider(): LLMProvider {
  const env = getLLMEnv()

  switch (env.provider) {
    case 'deepseek':
      return createDeepSeekProvider({
        apiKey: env.apiKey,
        model: env.model,
        timeoutMs: env.timeoutMs,
      })
    case 'claude':
      // getLLMEnv() 已经用 IMPLEMENTED_PROVIDERS 拦过一道，这里只是让类型穷尽。
      throw new LLMConfigError('claude adapter 尚未实现，请先将 LLM_PROVIDER 设为 deepseek。')
  }
}
