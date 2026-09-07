import type { createClient } from '@/lib/supabase/server'

/**
 * 量化指标埋点的写侧（P0-3-1，PRD 8.1）。
 *
 * ### 为什么只有这三类事件
 * 四项指标里有两项**不需要新埋点** —— `parse_corrections`（编辑修正率）与
 * `courses.canvas_course_id`（人均关联课程数）早就落库了，再记一遍就是两份口径。
 * 所以这里只为另外两项服务：
 *
 * - **7 日回访次数** → `dashboard_view`：此前没有任何地方记录"用户打开过总览页"。
 * - **token 续期完成率** → `expiry_reminder_shown` + `credential_renewed`：
 *   分母是"被提醒过的人"，分子是"提醒之后真的去重新授权的人"，两个事件缺一个
 *   就算不出这个比例。
 *
 * ### 🔴 埋点绝不能拖垮产品
 * 三个写入点全部吞掉异常（只 `console.warn`）：埋点是**度量**，不是功能。
 * 表还没迁移、RLS 写不进、网络抖一下 —— 任何情况下都不该让总览页白屏、
 * 也不该让"保存 Canvas token"失败。宁可少一条数据，不能坏一次体验。
 *
 * 反面是有意的：**指标缺失必须能被看见**。`GET /api/v1/metrics` 读数时若表不存在
 * 会直接 500，而不是返回一堆 0 —— 静默的 0 会被当成"用户一次都没回来"，
 * 那是比报错危险得多的假信号（CodingRules 7）。
 */

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

/**
 * 与 `usage_events.event_type` 的 CHECK 约束一致（迁移
 * `20260907120000_usage_events.sql`）。加取值要同步改迁移与 `Database.md` 3.14。
 */
export type UsageEventType = 'dashboard_view' | 'expiry_reminder_shown' | 'credential_renewed'

/** UTC 日期串（`YYYY-MM-DD`）。库里的时间戳带时区，取前 10 位即 UTC 日历日。 */
function utcDay(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * 记一条事件。
 *
 * 失败只告警：埋点不是功能，坏了也不能影响调用方的请求。
 */
export async function recordUsageEvent(
  supabase: SupabaseClient,
  userId: string,
  eventType: UsageEventType,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('usage_events')
      .insert({ user_id: userId, event_type: eventType })

    if (error) {
      console.warn(`[usage-events] 写入 ${eventType} 失败：${error.message}`)
    }
  } catch (cause) {
    // 表不存在 / RLS 拒绝 / 网络错误都落到这里 —— 一律降级成告警。
    console.warn(
      `[usage-events] 写入 ${eventType} 异常：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/**
 * 同一 UTC 日历日内**最多记一条**（用于"过期提醒展示过"这类会反复触发的事件）。
 *
 * 为什么按天去重而不是每条都记：横幅在 T-14 到过期当天一直挂着，用户一天开五次
 * 总览页就是五行。而这项指标的口径是"**被提醒过的人**"（人数），同一天记五次
 * 对分母没有任何贡献，只会把表撑大。
 *
 * 口径取舍：分母按"人"算，所以这里去重只影响存储量，不影响指标数值。
 */
export async function recordUsageEventOncePerUtcDay(
  supabase: SupabaseClient,
  userId: string,
  eventType: UsageEventType,
  now: Date,
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('usage_events')
      .select('created_at')
      .eq('user_id', userId)
      .eq('event_type', eventType)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.warn(`[usage-events] 读取 ${eventType} 最近记录失败：${error.message}`)
      // 读不到就照写：宁可多一条，也不要因为一次读失败就永远不记。
    } else if (data) {
      const latest = (data as { created_at: string }).created_at
      if (utcDay(latest) === utcDay(now.toISOString())) {
        return
      }
    }

    await recordUsageEvent(supabase, userId, eventType)
  } catch (cause) {
    console.warn(
      `[usage-events] 每日去重写入 ${eventType} 异常：${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}
