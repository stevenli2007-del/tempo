import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import type { ApiErrorBody } from '@/types/course'

/**
 * API Route 的响应辅助。
 *
 * 对应 API-Contract.md 的 1.3（统一错误结构）与 1.5（x-request-id 原样回传）。
 * 所有业务端点都走这里的 jsonOk / jsonError，保证错误形状不会在各处各写一套。
 */

/** 请求带了 x-request-id 就原样回传，便于前后端对账排障（契约 1.5 规则 3）。 */
function echoRequestId<T extends NextResponse>(request: Request, response: T): T {
  const requestId = request.headers.get('x-request-id')
  if (requestId) {
    response.headers.set('x-request-id', requestId)
  }
  return response
}

export function jsonOk<T>(request: Request, data: T, status = 200): NextResponse<T> {
  return echoRequestId(request, NextResponse.json(data, { status }))
}

export function jsonError(
  request: Request,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: { code, message } }
  if (details !== undefined) {
    body.error.details = details
  }
  return echoRequestId(request, NextResponse.json(body, { status }))
}

/**
 * 未处理异常的统一出口：服务端记日志，前端只拿到不含内部细节的通用文案。
 *
 * 记日志而不是静默吞掉（CodingRules 7）；message 不回传堆栈或 SQL（Security-Privacy 第 8 节）。
 */
export function internalError(request: Request, error: unknown): NextResponse<ApiErrorBody> {
  console.error('[api] 未处理异常:', error)
  return jsonError(request, 500, 'internal_error', '服务器出了点问题，请稍后重试')
}

/**
 * 取当前会话用户。
 *
 * 用 `auth.getUser()` 而不是 `getSession()` —— 后者只解本地 cookie，伪造可绕过
 * （P0-0-3 已踩过并写进执行卡）。
 *
 * 越权访问无需在应用层判断：所有业务表都开了 RLS，别人的行根本查不出来。
 */
export async function getCurrentUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { supabase, user }
}
