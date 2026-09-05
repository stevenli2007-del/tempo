import { encryptSecret } from '@/lib/canvas/crypto'
import {
  CREDENTIAL_META_COLUMNS,
  loadCredentialMeta,
  toCredentialMeta,
  type CanvasCredentialRow,
} from '@/lib/canvas/credentials'
import { validateCanvasDomain, validateCanvasToken, validateExpiresAt } from '@/lib/canvas/validate'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * Canvas 凭据端点（API-Contract.md 第 6 节，P0-2-2）。
 *
 * POST 保存（加密后入库）｜ GET 读元数据（不含任何密钥字段）
 *
 * ### 🔴 响应式红线（Security-Privacy 第 4 节）
 * 两个端点的响应体都来自 `toCredentialMeta()`，它的返回类型 `CanvasCredentialMeta`
 * **没有**密文字段。token 只进不出：请求体里进来，加密后入库，之后永不再出现。
 *
 * ### 关于 `expiresAt` 必填
 * 契约 §6 原文写"未填则存 null"，这是被 2026-09-04 P0-2-1b 实测推翻的旧描述 ——
 * bCourses 的 token 过期时间是强制必填项。以实测为准，校验器要求必填。
 *
 * ### 关于 upsert
 * 一个用户只应有一条凭据。表上有 unique(user_id) 时可以用 upsert，
 * 但该约束在迁移文件里等待执行，为了让代码在约束就位前后都能工作，
 * 这里用"先查后写"而不是 `upsert({ onConflict })`（后者在无约束时会直接报错）。
 */

export async function POST(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }

    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }
    const raw = body as Record<string, unknown>

    // 三项校验：域名（含 SSRF 防护）→ token → 过期时间。
    const domain = validateCanvasDomain(raw.canvasDomain)
    if (!domain.ok) return jsonError(request, 400, 'validation_failed', domain.message)

    const token = validateCanvasToken(raw.token)
    if (!token.ok) return jsonError(request, 400, 'validation_failed', token.message)

    const expiresAt = validateExpiresAt(raw.expiresAt)
    if (!expiresAt.ok) return jsonError(request, 400, 'validation_failed', expiresAt.message)

    // 明文 token 的最后一步：加密之后，本函数就再也不碰它了。
    const secretEncrypted = encryptSecret(token.value)

    const payload = {
      user_id: user.id,
      secret_encrypted: secretEncrypted,
      credential_type: 'pat',
      canvas_domain: domain.value,
      expires_at: expiresAt.value,
      // 重新连接（换 token）时把上一次的失败痕迹清掉，否则用户会看到
      // 一条早已不适用的旧错误。status 回到 active 由同步结果决定，不在这里假设。
      status: 'active',
      last_error_at: null,
      last_error_message: null,
    }

    const existing = await loadCredentialMeta(supabase, user.id)
    const query = existing
      ? supabase
          .from('canvas_credentials')
          .update(payload)
          .eq('id', existing.id)
          .select(CREDENTIAL_META_COLUMNS)
          .maybeSingle()
      : supabase
          .from('canvas_credentials')
          .insert(payload)
          .select(CREDENTIAL_META_COLUMNS)
          .maybeSingle()

    const { data, error } = await query
    if (error) {
      throw error
    }
    if (!data) {
      // 走到这里说明更新目标行消失了（并发删除）。不猜，交给用户重试。
      return jsonError(request, 409, 'conflict', '凭据状态已变化，请重试')
    }

    // 契约：201，且绝不回显 token。
    return jsonOk(request, toCredentialMeta(data as CanvasCredentialRow), 201)
  } catch (error) {
    return internalError(request, error)
  }
}

export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const credential = await loadCredentialMeta(supabase, user.id)
    if (!credential) {
      // ADR-010 的口径：不存在与越权统一 404。这里没有越权可能（RLS 只放行自己的行）。
      return jsonError(request, 404, 'not_found', '还没有连接 Canvas')
    }

    return jsonOk(request, credential)
  } catch (error) {
    return internalError(request, error)
  }
}
