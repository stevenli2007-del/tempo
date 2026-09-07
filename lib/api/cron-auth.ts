import { createHash, timingSafeEqual } from 'node:crypto'

import type { NextResponse } from 'next/server'

import type { ApiErrorBody } from '@/types/course'
import { jsonError } from './response'

/**
 * 定时/内部端点的统一鉴权（P0-2-6 建立，P0-3-1 抽出共用）。
 *
 * ### 为什么抽出来
 * `/api/v1/sync/scheduled` 与 `/api/v1/metrics` 是**仅有的两个**不走用户会话的端点，
 * 都用 `CRON_SECRET` 鉴权。这段逻辑（sha256 + `timingSafeEqual` + fail closed）
 * 抄第二遍时最容易丢的就是那条"没配 secret 就拒绝执行" —— 而它一旦丢了，
 * 端点就变成谁都能打的公开接口。安全逻辑只留一份。
 *
 * ### 三条硬规则（沿用 P0-2-6 的结论）
 * 1. **恒定时间比较**：`===` 在第一个不同字节就返回，响应耗时可被逐字节侧信道利用。
 *    两边先 sha256 成定长 32 字节再比，既恒定时间，也不会因长度不等抛错
 *    （长度差本身也是信息）。
 * 2. **fail closed**：没配 `CRON_SECRET` → 500（不管带什么凭证都拒绝执行）。
 *    "忘了配环境变量"绝不能退化成公开端点。
 * 3. **不猜来源**：Vercel Cron 会自动带 `Authorization: Bearer ${CRON_SECRET}`，
 *    代码只认 header，不管它是谁发的。
 */

export type CronAuthResult = { ok: true } | { ok: false; response: NextResponse<ApiErrorBody> }

function isAuthorized(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(secret).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

/**
 * 校验请求是否带了正确的 `CRON_SECRET`。
 *
 * @returns `ok: true` 放行；否则 `response` 已是可直接 return 的错误响应。
 */
export function authorizeCronRequest(
  request: Request,
  secret: string | undefined = process.env.CRON_SECRET,
): CronAuthResult {
  if (!secret) {
    return {
      ok: false,
      response: jsonError(
        request,
        500,
        'cron_not_configured',
        '服务端未配置 CRON_SECRET，已拒绝执行',
      ),
    }
  }

  if (!isAuthorized(request, secret)) {
    return {
      ok: false,
      response: jsonError(request, 401, 'unauthorized', '缺少或错误的调度凭证'),
    }
  }

  return { ok: true }
}
