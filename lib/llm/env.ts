/**
 * LLM 环境变量读取与校验（P0-1-3）。
 *
 * 与 `lib/supabase/env.ts` 同构：变量缺失时**立刻抛明确错误**，
 * 而不是让 undefined 流进请求，变成一句看不懂的 401。
 *
 * ⚠️ 这些变量**绝不能**加 `NEXT_PUBLIC_` 前缀 —— LLM key 是密钥，
 * 打了前缀就会进前端产物（`Security-Privacy.md` 第 5 节）。
 */

import type { LLMCapability, LLMProviderName } from './types'

export type LLMEnv = {
  provider: LLMProviderName
  apiKey: string
  model: string
  timeoutMs: number
}

/** 配置问题专用错误类型：`runStructured()` 靠它区分「配置坏了」与「厂商出错了」。 */
export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LLMConfigError'
  }
}

/**
 * 能力 → provider 配置映射（[ADR-018](../../docs/Decisions.md#adr-018)）。
 *
 * - `text`：默认 `deepseek`（高频 + 量大，走便宜那家）
 * - `vision`：默认 `claude`（多模态；DeepSeek 无视觉）
 *
 * 每条含：provider 名、API key 变量、模型覆盖变量、默认模型。
 * Claude 的默认模型 `claude-sonnet-5` 取自 Anthropic 官方文档（非凭印象）。
 */
const CAPABILITY_CONFIG: Record<
  LLMCapability,
  { providerEnv: string; defaultProvider: LLMProviderName; keyEnv: string; modelEnv: string; defaultModel: string }
> = {
  text: {
    providerEnv: 'LLM_PROVIDER',
    defaultProvider: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'LLM_MODEL',
    defaultModel: 'deepseek-chat',
  },
  vision: {
    providerEnv: 'LLM_PROVIDER_VISION',
    defaultProvider: 'claude',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'LLM_MODEL_VISION',
    defaultModel: 'claude-sonnet-5',
  },
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 已实现的 provider。Claude adapter 已在 P0-3-9（关闭 O-11）补上，
 * 因此这里同时放 `deepseek` 与 `claude`。
 */
const IMPLEMENTED_PROVIDERS: LLMProviderName[] = ['deepseek', 'claude']

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new LLMConfigError(
      `环境变量 LLM_TIMEOUT_MS 必须是正整数毫秒，当前是 "${raw}"。` +
        '不设置即使用默认值 120000（2 分钟）。'
    )
  }
  return parsed
}

/**
 * 按**能力**读取 provider 配置（[ADR-018](../../docs/Decisions.md#adr-018)）。
 *
 * 与旧 `getLLMEnv()`（全局单一开关）不同：文本档与图片档可走不同 provider，
 * 互不干扰。调用方必须显式传 `capability`，否则无法决定读哪组变量。
 *
 * @throws {LLMConfigError} 变量缺失 / provider 名不认识 / adapter 未实现。
 */
export function getLLMEnv(capability: LLMCapability): LLMEnv {
  const cfg = CAPABILITY_CONFIG[capability]
  const rawProvider = (process.env[cfg.providerEnv] ?? cfg.defaultProvider).trim().toLowerCase()

  if (rawProvider !== 'deepseek' && rawProvider !== 'claude') {
    throw new LLMConfigError(
      `环境变量 ${cfg.providerEnv} 只支持 deepseek / claude，当前是 "${rawProvider}"。`
    )
  }
  const provider: LLMProviderName = rawProvider

  if (!IMPLEMENTED_PROVIDERS.includes(provider)) {
    throw new LLMConfigError(
      `能力 ${capability} 选定的 ${cfg.providerEnv}=${provider}，但 ${provider} adapter 尚未实现。` +
        '要启用需先补 adapter 并自测（见 docs/TechStack.md 5.2）。'
    )
  }

  const apiKey = process.env[cfg.keyEnv]?.trim()

  if (!apiKey) {
    throw new LLMConfigError(
      `能力 ${capability} 需要环境变量 ${cfg.keyEnv}（当前缺）。本地在 .env.local 填入；` +
        'Vercel 在 Project Settings → Environment Variables 配置后**必须手动 Redeploy**才会生效。'
    )
  }

  const model = process.env[cfg.modelEnv]?.trim() || cfg.defaultModel
  if (!model) {
    throw new LLMConfigError(`provider ${provider} 没有默认模型，请用 ${cfg.modelEnv} 显式指定。`)
  }

  return {
    provider,
    apiKey,
    model,
    timeoutMs: parseTimeoutMs(process.env.LLM_TIMEOUT_MS),
  }
}
