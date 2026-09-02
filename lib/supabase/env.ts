/**
 * Supabase 环境变量统一读取与校验。
 *
 * 存在的意义：环境变量缺失时立刻抛明确错误，而不是让 undefined 流进 client，
 * 变成难以定位的网络错误。
 */

export type SupabaseEnv = {
  url: string
  anonKey: string
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url) {
    throw new Error(
      '缺少环境变量 NEXT_PUBLIC_SUPABASE_URL。' +
        '请执行 cp .env.example .env.local 并填入 Supabase Project URL。'
    )
  }

  if (!anonKey) {
    throw new Error(
      '缺少环境变量 NEXT_PUBLIC_SUPABASE_ANON_KEY。' +
        '请执行 cp .env.example .env.local 并填入 Supabase anon key。'
    )
  }

  return { url, anonKey }
}
