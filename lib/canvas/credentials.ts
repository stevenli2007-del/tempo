import type { createClient } from '@/lib/supabase/server'

import { decryptSecret } from '@/lib/canvas/crypto'
import type {
  CanvasCredentialMeta,
  CredentialStatus,
  CredentialType,
} from '@/types/canvas'

/**
 * 服务端 client 的类型，与 `lib/tasks.ts` / `lib/course-detail.ts` 同款写法。
 * 必须带这个具体类型而不是裸 `SupabaseClient`：后者缺少 Database 泛型，
 * select 的返回类型会退化成 `GenericStringError`，每行都要强转才能用。
 */
type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * `canvas_credentials` 表的**唯一** snake_case ↔ camelCase 映射点（P0-2-2）。
 *
 * 与 `lib/courses.ts` / `lib/tasks.ts` 同构：别处不写裸列名，改表只改这一个文件。
 */

/**
 * 元数据查询的列。⚠️ 刻意**不含** `secret_encrypted` —— 读元数据不该把密文取出来。
 *
 * 必须写成**字符串字面量**而不是数组 join：Supabase 的类型推导靠字面量类型
 * 决定 select 的返回形状，拼出来的 `string` 会退化成 `GenericStringError`。
 */
export const CREDENTIAL_META_COLUMNS =
  'id, canvas_domain, credential_type, expires_at, status, last_used_at, last_error_at, last_error_message'

/** 含密文的完整列集，只在必须解密时才用。同理保持字面量。 */
export const CREDENTIAL_FULL_COLUMNS =
  'id, canvas_domain, credential_type, expires_at, status, last_used_at, last_error_at, last_error_message, secret_encrypted'

export type CanvasCredentialRow = {
  id: string
  canvas_domain: string
  credential_type: string
  expires_at: string
  status: string
  last_used_at: string | null
  last_error_at: string | null
  last_error_message: string | null
  secret_encrypted?: string
}

/**
 * 行 → 对外元数据。
 *
 * 这是**密钥不外泄的类型级保证**：返回类型是 `CanvasCredentialMeta`，
 * 它根本没有密文字段。即使 row 里带着 `secret_encrypted`（完整列集查出来的情况），
 * 也在这道函数被挡住，不会流进响应。
 */
export function toCredentialMeta(row: CanvasCredentialRow): CanvasCredentialMeta {
  return {
    id: row.id,
    canvasDomain: row.canvas_domain,
    credentialType: row.credential_type as CredentialType,
    expiresAt: row.expires_at,
    status: row.status as CredentialStatus,
    lastUsedAt: row.last_used_at,
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
  }
}

/** 取当前用户的凭据元数据；没有则返回 null。RLS 保证只能读到自己的。 */
export async function loadCredentialMeta(
  supabase: ServerSupabase,
): Promise<CanvasCredentialMeta | null> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .select(CREDENTIAL_META_COLUMNS)
    .maybeSingle()

  if (error) {
    throw error
  }
  return data ? toCredentialMeta(data as CanvasCredentialRow) : null
}

/**
 * 取凭据并解密出明文 token，供服务端发起 Canvas 请求。
 *
 * 明文只存在于这个函数调用方的栈上，**不落盘、不进日志、不进响应**。
 *
 * @throws 密文格式损坏 / 密钥不匹配时抛错（消息不含明文，见 `decryptSecret`）。
 *         调用方（同步流程）应捕获并把凭据标记为 `error` 状态。
 */
export async function loadDecryptedCredential(
  supabase: ServerSupabase,
): Promise<{ id: string; canvasDomain: string; token: string; expiresAt: string; status: string } | null> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .select(CREDENTIAL_FULL_COLUMNS)
    .maybeSingle()

  if (error) {
    throw error
  }
  if (!data) {
    return null
  }

  const row = data as CanvasCredentialRow
  return {
    id: row.id,
    canvasDomain: row.canvas_domain,
    token: decryptSecret(row.secret_encrypted ?? ''),
    expiresAt: row.expires_at,
    // P0-2-5 加：同步编排要先看 status 再决定发不发请求（失效的 token 一个请求都不该发），
    // 顺带返回省一次往返。这是纯新增字段，不影响既有调用方。
    status: row.status,
  }
}

// ---------- 同步结果回写（P0-2-5） ----------

/**
 * 一次成功的 Canvas 调用后刷新 `last_used_at`。
 *
 * 这个字段是排障时唯一能回答"这个 token 到底有没有真的用过"的东西 ——
 * `expires_at` 只能说明它该什么时候失效。
 */
export async function touchCredentialSuccess(
  supabase: ServerSupabase,
  credentialId: string,
): Promise<void> {
  const { error } = await supabase
    .from('canvas_credentials')
    .update({ last_used_at: new Date().toISOString(), last_error_message: null })
    .eq('id', credentialId)

  if (error) {
    throw error
  }
}

/**
 * 凭证被 Canvas 拒绝 / 解密失败 → 置 `status = 'error'` 并记下原因。
 *
 * Sync-Strategy §8：401 / 403 **绝不重试**，立即停止该用户的同步。
 * 状态落到库里，UI（P0-2-7）才有东西可展示；靠抛异常只在当次请求里可见，
 * 用户下次打开应用时看到的是一个静默的"没同步"。
 */
export async function markCredentialFailed(
  supabase: ServerSupabase,
  credentialId: string,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from('canvas_credentials')
    .update({
      status: 'error',
      last_error_at: new Date().toISOString(),
      last_error_message: message,
    })
    .eq('id', credentialId)

  if (error) {
    throw error
  }
}
