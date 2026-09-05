import { createHash, timingSafeEqual } from 'node:crypto'

import { internalError, jsonError, jsonOk } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { runScheduledSync } from '@/lib/sync/scheduled'

/**
 * `GET|POST /api/v1/sync/scheduled` —— T3 平台定时兜底（API-Contract.md §6）。
 *
 * ### 为什么 GET 和 POST 都支持
 * - **Vercel Cron 只发 GET**，这是平台行为，改不了（Sync-Strategy §3.1）。
 * - 契约 §6 原文写的是 POST，而 Sync-Strategy §3.2 的 T4 外部调度器示例写的又是 GET
 *   —— 两份文档本来就打架。两个方法都导出，谁都能调，省掉一次"到底该用哪个"的往返。
 *
 * ### 鉴权：CRON_SECRET + 恒定时间比较
 * - **Vercel Cron 会自动带上 `Authorization: Bearer ${CRON_SECRET}`** ——
 *   只要项目里配了同名环境变量，平台自己加，代码不用管它从哪来。
 * - 用 `timingSafeEqual` 而不是 `===`：普通字符串比较在第一个不同字节就返回，
 *   攻击者靠响应耗时能逐字节猜出 secret。这里两边先 sha256 成定长 32 字节再比，
 *   既恒定时间，又不会因为长度不等而抛错（长度差本身也是信息）。
 * - 🔴 **secret 没配 = 拒绝执行（fail closed）**，返回 500 而不是放行 ——
 *   "忘了配环境变量"绝不能变成一个谁都能打的公开端点。
 */

/** cron 端点绝不缓存：万一被 CDN 缓存一次，后续定时扫描就全部落空。 */
export const dynamic = 'force-dynamic'

/** 请求带了正确的 CRON_SECRET 吗？ */
function isAuthorized(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(secret).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

async function handle(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret) {
      // 没配 secret 就开放端点是最坏的一种默认值，宁可 500 也不放行。
      return jsonError(
        request,
        500,
        'cron_not_configured',
        '服务端未配置 CRON_SECRET，定时同步已拒绝执行',
      )
    }

    if (!isAuthorized(request, secret)) {
      return jsonError(request, 401, 'unauthorized', '缺少或错误的调度凭证')
    }

    // 与上面同款 fail closed：配了 secret 却没配 service role key 时，
    // 明确说缺什么，而不是笼统的 500 internal_error（那种消息排障时等于没有）。
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonError(
        request,
        500,
        'service_role_key_missing',
        '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法遍历用户凭据',
      )
    }

    const supabase = createServiceRoleClient()
    const report = await runScheduledSync(supabase)
    return jsonOk(request, report)
  } catch (error) {
    return internalError(request, error)
  }
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
