import type { SyncSummary } from '@/types/sync'
import type { Lang } from '@/lib/i18n/types'
import { t } from '@/lib/i18n/translate'

/**
 * 浏览器端调 `POST /api/v1/sync/now` 的**唯一**封装。
 *
 * P0-2-7 之前这段逻辑只存在于 `components/sync/sync-controls.tsx` 内部。
 * 状态条需要一个「重试」按钮（Sync-Strategy §9 对 failed / partial 的硬性要求），
 * 与其把响应解析再抄一遍，不如抽出来共用 —— 抄一遍的后果是两处对同一份响应
 * 给出不同的失败文案。
 *
 * ⚠️ 只在客户端组件里 import（它用的是浏览器 `fetch`）。
 */

/** 一次同步调用的结果，按「可展示」预分类。 */
export type SyncCallResult =
  | { ok: true; summary: SyncSummary }
  | { ok: false; status: number; message: string }

/** 从响应体里安全取 `error.message`（服务端是我们自己的，但响应可能被代理改写）。 */
function extractErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const message = (body as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  return fallback
}

/** 弱校验响应是不是 SyncSummary —— 形状不对宁可说"响应异常"也不渲染成 NaN。 */
function toSyncSummary(body: unknown): SyncSummary | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const b = body as Record<string, unknown>
  if (
    typeof b.status !== 'string' ||
    typeof b.coursesSynced !== 'number' ||
    !Array.isArray(b.failures)
  ) {
    return null
  }
  return body as SyncSummary
}

export async function callSyncNow(
  trigger: 'manual' | 'app_open',
  lang: Lang = 'zh',
): Promise<SyncCallResult> {
  let res: Response
  try {
    res = await fetch('/api/v1/sync/now', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trigger }),
    })
  } catch {
    return { ok: false, status: 0, message: t(lang, 'sync.networkError') }
  }

  const body: unknown = await res.json().catch(() => null)
  if (res.ok) {
    const summary = toSyncSummary(body)
    if (summary) {
      return { ok: true, summary }
    }
    return { ok: false, status: res.status, message: t(lang, 'sync.responseMalformed') }
  }

  return {
    ok: false,
    status: res.status,
    message: extractErrorMessage(body, t(lang, 'sync.failedHttp', { status: res.status })),
  }
}

/**
 * 公告那一步的结果压成一句话（P0-3-25）。
 *
 * 🔴 公告失败**必须出现在这里**：它的逻辑是"下次同步会重试"，用户看不到任何异常 ——
 * 而"老师发了公告、Tempo 没抓到、界面上一片正常"正是 ADR-016 R3 点名的那种静默失败。
 *
 * `announcements` 缺失按"没跑"处理（弱校验过的响应可能来自老版本服务端 / 被代理改写）。
 *
 * ⚠️ C 口径（2026-09-18）之后 `created` 是**消息**条数、不是公告条数：
 * 40 条通知类公告只产出 1 条摘要消息。只说 `created` 会让用户以为"只收到 1 条公告"，
 * 所以有摘要时把折进去的条数一并说出来。
 */
function announcementLine(summary: SyncSummary, lang: Lang): string {
  const a = summary.announcements
  if (!a) return ''
  if (a.error) return t(lang, 'sync.announcementFailed', { err: a.error })
  if (a.created === 0) return ''
  if (a.digested > 0) {
    return t(lang, 'sync.announcementsCreated', { n: a.created, digested: a.digested })
  }
  return t(lang, 'sync.announcementsPlain', { n: a.created })
}

/**
 * 资料索引那一步的结果压成一句话（P0-3-19）。
 *
 * ⚠️ 与公告相反：**这里只在出错时才出声**。
 * 实测 14 门课里 8 门 `/files` 是 403（压根没开 Files 区）——
 * 「跳过」是本功能的常态结果，说出来只会让用户以为出事了。
 * 只有 `error`（端点真的挂了 / 写库失败）才需要让人看见（ADR-016 R3 防静默失败）。
 */
function filesLine(summary: SyncSummary, lang: Lang): string {
  const f = summary.files
  if (!f) return ''
  if (f.error) return t(lang, 'sync.filesFailed', { err: f.error })
  return ''
}

/** 把一次成功的同步结果压成一行人话。 */
export function summarize(summary: SyncSummary, lang: Lang = 'zh'): string {
  if (summary.coursesSynced === 0 && summary.coursesFailed === 0) {
    return t(lang, 'sync.noCourses')
  }
  const joiner = lang === 'zh' ? '，' : ', '
  const changes: string[] = []
  if (summary.tasksCreated > 0) changes.push(t(lang, 'sync.changeAdded', { n: summary.tasksCreated }))
  if (summary.tasksUpdated > 0) changes.push(t(lang, 'sync.changeUpdated', { n: summary.tasksUpdated }))
  if (summary.tasksDeleted > 0) changes.push(t(lang, 'sync.changeRemoved', { n: summary.tasksDeleted }))
  const changeLine = changes.length > 0 ? changes.join(joiner) : t(lang, 'sync.noChanges')
  const failureLine =
    summary.failures.length > 0
      ? t(lang, 'sync.failures', {
          n: summary.failures.length,
          course: summary.failures[0].courseName,
          msg: summary.failures[0].message,
        })
      : ''
  return `${t(lang, 'sync.summaryPrefix', { n: summary.coursesSynced })}${changeLine}${failureLine}${announcementLine(summary, lang)}${filesLine(summary, lang)}${driftLine(summary, lang)}`
}

/**
 * 大纲漂移那一步的结果压成一句话（P0-3-20）。
 *
 * ⚠️ 与资料（`filesLine`）**刻意不同**：资料只在出错时出声，漂移则是**主动报喜**。
 *
 * 为什么这一条值得说：它是本卡唯一真正"产品化"的信号 ——
 * 「老师把期中挪了两周」这种事，Tempo 的价值就在于**替用户发现**。
 * 只把提案静静塞进消息栏、同步提示里一个字不提，用户不点开消息栏就等于没发现，
 * 那这个功能在体感上就不存在（ADR-016 hands-off 的前提是"发现了要让人知道"）。
 *
 * 反过来，`baselined` / `noFile` / `unchanged` 一律**闭嘴**：
 * 首次核对 6~13 门课全在 `baselined` 里，报出来就是"13 门课有更新"的假警 ——
 * 与 `announcementLine` 只认 `created`、`filesLine` 只认 `error` 是同一种克制。
 */
function driftLine(summary: SyncSummary, lang: Lang): string {
  const d = summary.drift
  if (!d) return ''
  if (d.error) return t(lang, 'sync.driftFailed', { err: d.error })
  if (d.proposed > 0) return t(lang, 'sync.driftProposed', { n: d.proposed })
  return ''
}
