import type { createClient } from '@/lib/supabase/server'

import { decryptSecret, encryptSecret } from '@/lib/canvas/crypto'
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

/**
 * 取指定用户的凭据元数据；没有则返回 null。
 *
 * `userId` 强制显式（与 `loadDecryptedCredential` 同因）：service role 客户端下
 * RLS 不生效，靠"只能读到自己的"这种隐式保证会串到别人的行。
 */
export async function loadCredentialMeta(
  supabase: ServerSupabase,
  userId: string,
): Promise<CanvasCredentialMeta | null> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .select(CREDENTIAL_META_COLUMNS)
    .eq('user_id', userId)
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
 * 🔴 **`userId` 参数是强制的，不是可选**（P0-2-6 第二拍加的）：定时同步（T3）用
 * **service role** 客户端调它，而 service role **绕过 RLS**。此前这里靠 RLS 隐式
 * 隔离（"只能读到自己的那一行"），在那个场景下会直接读到**别人的凭据** —— 跨用户串号。
 * 显式 `eq('user_id', userId)` 让它在两种客户端下都正确，且由类型系统强制：
 * 不传 userId 编译不过，不存在"忘了传"的可能。
 *
 * @throws 密文格式损坏 / 密钥不匹配时抛错（消息不含明文，见 `decryptSecret`）。
 *         调用方（同步流程）应捕获并把凭据标记为 `error` 状态。
 */
export async function loadDecryptedCredential(
  supabase: ServerSupabase,
  userId: string,
): Promise<{ id: string; canvasDomain: string; token: string; expiresAt: string; status: string } | null> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .select(CREDENTIAL_FULL_COLUMNS)
    .eq('user_id', userId)
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

/**
 * 撤销后写入 `secret_encrypted` 的占位明文（P0-2-9）。
 *
 * 它会被正常加密成一份格式合法的密文，但解密回来只是这个字符串 ——
 * 不对应任何真人的 token。存在的唯一理由是满足 `NOT NULL`
 * 且让 `decryptSecret()` 不抛错（详见 `revokeCredential`）。
 */
export const REVOKED_PLACEHOLDER = 'revoked'

/**
 * 撤销凭据：占位密文覆盖 + `status = 'revoked'`（P0-2-9，P0-3-2「清除 Canvas 数据」复用）。
 *
 * ### 🔴 为什么密文是"覆盖"而不是"清空"
 * `secret_encrypted` 是 `text NOT NULL`，置 null 会直接违反约束。更关键的是
 * 置空串也不行：`runCanvasSync` 的顺序是 `loadDecryptedCredential()`（内部
 * **先 `decryptSecret()` 再返回 status**）→ 判空 → **才**判 `status !== 'active'`
 * （`lib/sync/canvas-sync.ts`）。空串会让 `decryptSecret('')` 抛错，
 * 同步从"优雅跳过（`credential_inactive`）"退化成"整趟崩溃"。
 *
 * 所以写入一个**格式合法、但不对应任何真实 token** 的占位密文：解密照常成功，
 * 随后被 `status !== 'active'` 拦下，一个请求都不会发给 Canvas。
 * 原来的 token 被覆盖掉，不可恢复 —— 这才是"删除加密凭证"的落地含义。
 *
 * 保留什么（契约原文 + Steven 2026-09-05 拍板）由调用方决定：
 * 已同步的 `tasks` 与各门课的 `canvas_course_id` 都**不动**，重新粘贴 token 后
 * 立刻恢复同步。要连 Canvas 导入的任务一起删，是 P0-3-2 的 `scope=canvas` 那一条。
 */
export async function revokeCredential(
  supabase: ServerSupabase,
  credentialId: string,
): Promise<CanvasCredentialRow> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .update({
      secret_encrypted: encryptSecret(REVOKED_PLACEHOLDER),
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      // 上一次失败的原因在"已撤销"这个终态下不再有意义，清掉免得误导。
      last_error_at: null,
      last_error_message: null,
    })
    .eq('id', credentialId)
    .select(CREDENTIAL_META_COLUMNS)
    .maybeSingle()

  if (error) {
    throw error
  }
  if (!data) {
    // 目标行在查与写之间消失了（并发）。不猜，交给调用方决定重试还是当成功。
    throw new Error('凭据状态已变化')
  }
  return data as CanvasCredentialRow
}

/**
 * Token 已过期（按 `expires_at` 判定）→ 置 `status = 'expired'`（P0-2-8，Sync-Strategy §10）。
 *
 * 与 `markCredentialFailed` 的区别：
 * - `error` 是 **Canvas 主动拒绝**（401/403），连接本身坏了，要引导用户重连；
 * - `expired` 是**时间到了**，连接可能还通，只是 token 失效——同样要重连，
 *   但语义是"该续期了"而不是"被拒了"。
 *
 * 置 `expired` 后，`runCanvasSync` 在 `status !== 'active'` 时直接跳过（不浪费请求去打
 * 一个注定失败的 token），T1 打开应用 / T3 定时都受益。用户重新连接（P0-2-4 的
 * 连接表单，先查后写）会把 status 写回 `active` 并立即触发一次同步。
 *
 * `credentialId` 是凭据主键，更新只看它——service role 下也不存在跨用户问题
 * （T3 循环里 `credential` 是按当前 userId 查出来的那一行）。
 */
export async function markCredentialExpired(
  supabase: ServerSupabase,
  credentialId: string,
): Promise<void> {
  const { error } = await supabase
    .from('canvas_credentials')
    .update({ status: 'expired' })
    .eq('id', credentialId)

  if (error) {
    throw error
  }
}
