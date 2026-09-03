/**
 * LLM 环境变量读取与校验（P0-1-3）。
 *
 * 与 `lib/supabase/env.ts` 同构：变量缺失时**立刻抛明确错误**，
 * 而不是让 undefined 流进请求，变成一句看不懂的 401。
 *
 * ⚠️ 这些变量**绝不能**加 `NEXT_PUBLIC_` 前缀 —— LLM key 是密钥，
 * 打了前缀就会进前端产物（`Security-Privacy.md` 第 5 节）。
 */

import type { LLMProviderName } from './types'

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

/** 各 provider 的默认模型。可用 `LLM_MODEL` 覆盖（换模型不改代码）。 */
const DEFAULT_MODEL: Record<LLMProviderName, string> = {
  deepseek: 'deepseek-chat',
  claude: '',
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 已实现的 provider。Claude 是 ADR-003 的兜底方案，**adapter 尚未实现** ——
 * 与其写一段从未真正调通过的死代码，不如在这里明确报错。
 * 要切 Claude 时，先写 adapter + 自测，再把它加进这个集合。
 */
const IMPLEMENTED_PROVIDERS: LLMProviderName[] = ['deepseek']

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

export function getLLMEnv(): LLMEnv {
  const rawProvider = (process.env.LLM_PROVIDER ?? 'deepseek').trim().toLowerCase()

  if (rawProvider !== 'deepseek' && rawProvider !== 'claude') {
    throw new LLMConfigError(
      `环境变量 LLM_PROVIDER 只支持 deepseek / claude，当前是 "${rawProvider}"。`
    )
  }
  const provider: LLMProviderName = rawProvider

  if (!IMPLEMENTED_PROVIDERS.includes(provider)) {
    throw new LLMConfigError(
      `LLM_PROVIDER=${provider}，但 ${provider} adapter 尚未实现。` +
        '当前只有 deepseek 可用。要启用需先补 adapter 并自测（见 docs/TechStack.md 5.2）。'
    )
  }

  const keyVarName = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY'
  const apiKey = process.env[keyVarName]?.trim()

  if (!apiKey) {
    throw new LLMConfigError(
      `缺少环境变量 ${keyVarName}。本地在 .env.local 填入；` +
        'Vercel 在 Project Settings → Environment Variables 配置后**必须手动 Redeploy**才会生效。'
    )
  }

  const model = process.env.LLM_MODEL?.trim() || DEFAULT_MODEL[provider]
  if (!model) {
    throw new LLMConfigError(`provider ${provider} 没有默认模型，请用 LLM_MODEL 显式指定。`)
  }

  return {
    provider,
    apiKey,
    model,
    timeoutMs: parseTimeoutMs(process.env.LLM_TIMEOUT_MS),
  }
}
