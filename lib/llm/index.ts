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
import { createClaudeProvider } from './providers/claude'
import { createDeepSeekProvider } from './providers/deepseek'
import { createQwenProvider } from './providers/qwen'

import type { LLMCapability, LLMProvider } from './types'

export { LLMConfigError } from './env'
export { validateJsonSchema } from './schema'
export type {
  JSONSchema,
  JSONSchemaType,
  LLMContentPart,
  LLMCapability,
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
 * 按**能力**构造 provider（[ADR-018](../../docs/Decisions.md#adr-018)）。
 *
 * 文本档默认 DeepSeek、截图档默认 Qwen（通义千问，中国区），二者并存互不干扰。
 * 若选中的 provider 不支持请求的能力（例如有人把 `LLM_PROVIDER_VISION` 设成 `deepseek`），
 * **立刻抛 `LLMConfigError`** —— 不许一个无视觉的 provider 静默接到图片请求、然后返回一个
 * 看起来像「没识别出任务」的空结果（那会把「服务坏了」伪装成「你这张图没内容」）。
 *
 * @throws {LLMConfigError} 环境变量缺失 / provider 不认识 / adapter 未实现 / **能力不匹配**。
 *   这是**故意**的快速失败：配置坏了早崩，好过让每个请求都失败一次或静默返回空。
 *   不想接异常的话用 `runStructured()`，它会把配置错误统一收敛成 `config_error` 结果。
 */
export function getLLMProvider(capability: LLMCapability): LLMProvider {
  const env = getLLMEnv(capability)

  let provider: LLMProvider
  switch (env.provider) {
    case 'deepseek':
      provider = createDeepSeekProvider({
        apiKey: env.apiKey,
        model: env.model,
        timeoutMs: env.timeoutMs,
      })
      break
    case 'claude':
      provider = createClaudeProvider({
        apiKey: env.apiKey,
        model: env.model,
        timeoutMs: env.timeoutMs,
      })
      break
    case 'qwen':
      provider = createQwenProvider({
        apiKey: env.apiKey,
        model: env.model,
        timeoutMs: env.timeoutMs,
      })
      break
    default:
      // getLLMEnv() 已用 IMPLEMENTED_PROVIDERS 拦过一道；这里只是让类型穷尽。
      throw new LLMConfigError(`provider ${env.provider} 尚未实现。`)
  }

  if (!provider.capabilities.includes(capability)) {
    throw new LLMConfigError(
      `能力 ${capability} 需要支持该能力的 provider，但选中的 ${provider.name} 只支持 ` +
        `[${provider.capabilities.join(', ')}]。请检查 ${capability === 'vision' ? 'LLM_PROVIDER_VISION' : 'LLM_PROVIDER'} 的配置。`
    )
  }

  return provider
}
