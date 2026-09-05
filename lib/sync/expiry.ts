/**
 * Canvas token 过期提醒的视图模型（P0-2-8，Sync-Strategy §10「Token 生命周期」）。
 *
 * ### 为什么又是一层纯函数
 * 跟 P0-2-7 的 `lib/sync/status.ts` 同理由：横幅要展示的东西本质是
 * 「把 `expires_at` + `status` 翻译成人话」。放进组件就只能起 Next 运行时 + 造数据验证；
 * 拆成纯函数后能在 Node 里直跑断言（本卡自测这么干），也保证 dashboard 只算一次、
 * 不与客户端各算一遍导致 hydration mismatch。
 *
 * ### 三条硬规则（来自 §10）
 * 1. **提醒基于用户实际填的 `expires_at`**，不写死天数。窗口 T-14 / T-7 / T-3 / T-1 / 当天。
 * 2. **一个请求都不该为过期 token 发**（已过期 → 跳过同步）。那是 T3 / T1 的职责，
 *    本文件只负责"算给人看"，不负责发请求。
 * 3. **`status === 'error'**（token 被 Canvas 拒绝）由 P0-2-7 的失败横幅独占 ——
 *    这里返回 null，避免同一个"连接坏了"的问题出现两份不同文案（一个说失效、一个说过期）。
 *
 * ⚠️ 只做纯计算，`now` 由调用方传入（服务端算好），不在内部 `new Date()`。
 */

/** 提前提醒窗口（天）。§10：T-14 / T-7 / T-3 / T-1 / 当天。落到这里 = 14 天内都开始提示。 */
export const EXPIRY_WARNING_WINDOW_DAYS = 14

const DAY_MS = 86_400_000

export type CredentialExpiryLevel = 'ok' | 'warning' | 'expired'

/** 给用户的横幅视图。`level === 'ok'` 时 `message` 为 null（不渲染横幅）。 */
export type CredentialExpiryView = {
  level: CredentialExpiryLevel
  /**
   * 距过期的整天数（向下取整）。负 = 已过期。
   * 仅 `warning` / `expired` 有展示意义；`ok` 时也可能 > 0 但无意义。
   */
  daysLeft: number
  /** 给人看的横幅文案；`ok` 时为 null。 */
  message: string | null
  /** 引导动作（当前只有「去重新连接 Canvas」一条）。 */
  action: 'reconnect'
}

/** 过期日期按 UTC 渲染（与 `status.ts` 的 `formatSyncTime` 同款取舍，防 hydration mismatch）。 */
function formatExpiryDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
}

/**
 * 凭据 → 过期提醒视图。
 *
 * @param expiresAt `canvas_credentials.expires_at`（ISO 8601）。理论上 NOT NULL，但防御性处理 null。
 * @param status    凭据状态。`error` 时返回 null（让失败横幅独占）。
 * @param now       调用方注入的"现在"。
 */
export function toCredentialExpiryView(
  expiresAt: string | null,
  status: string,
  now: Date,
): CredentialExpiryView | null {
  // 同步已失败（token 被 Canvas 拒绝）→ 那是 P0-2-7 失败横幅的活，不重复提示。
  if (status === 'error') {
    return null
  }

  // 防御：库里没填过期时间（不该发生，NOT NULL），不编造提醒。
  if (expiresAt === null) {
    return null
  }
  const then = Date.parse(expiresAt)
  if (Number.isNaN(then)) {
    return null
  }

  const daysLeft = Math.floor((then - now.getTime()) / DAY_MS)

  // 已过期：最该被看见，destructive 卡 + 引导重连。
  if (daysLeft < 0) {
    return {
      level: 'expired',
      daysLeft,
      message: `Canvas 访问令牌已于 ${formatExpiryDate(expiresAt)} 过期，请重新连接以继续同步`,
      action: 'reconnect',
    }
  }

  // 当天过期（T-0）。
  if (daysLeft === 0) {
    return {
      level: 'warning',
      daysLeft,
      message: 'Canvas 访问令牌今天过期，请尽快重新连接',
      action: 'reconnect',
    }
  }

  // 提醒窗口内（T-14 ~ T-1）：中性卡，给出确切日期方便用户安排。
  if (daysLeft <= EXPIRY_WARNING_WINDOW_DAYS) {
    return {
      level: 'warning',
      daysLeft,
      message: `Canvas 访问令牌将在 ${daysLeft} 天后过期（${formatExpiryDate(expiresAt)}），记得在 bCourses 重新生成`,
      action: 'reconnect',
    }
  }

  // 还早，无提示。
  return { level: 'ok', daysLeft, message: null, action: 'reconnect' }
}
