/**
 * 每日链接重抓比对（P0-5-3 的 Cron 内核）。
 *
 * ### 流程（每条链接）
 * 1. `fetchUrlText` 重抓（复用 3-27 的 SSRF 守卫 + 超时 + 同源子页；原文不落库）。
 * 2. 抓到 → `segmentText` 算新指纹：
 *    - **没基线**（首次）→ 只记基线、不发消息（否则首轮必误报"变了"）；
 *    - 有基线且**无变化** → 更新指纹 + 可见状态，零消息；
 *    - 有变化 → 摊平 diff 成 details，建一条 `link_change` 消息，再更新指纹。
 * 3. 抓不到 → 记可见状态（`unreachable` / `blocked` / `unsupported`）+ 人话原因，**不发消息**（失败要可见，R3）。
 *
 * ### 🔴 幂等（验收第 3 条）
 * 变化一旦被报告，指纹随即更新为最新值 → 下一轮比对**无变化** → 零新消息。
 * 连跑两轮，第二轮必然 `messages: 0`。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchUrlText } from '@/lib/ingest/url-fetch'
import {
  applyCheckResult,
  insertLinkChangeMessage,
  loadLinksForCheck,
  type LinkCheckTarget,
} from './store'
import { diffFingerprints, diffToDetails, segmentText } from './fingerprint'

export type LinkCheckReport = {
  /** 实际检查的链接数。 */
  checked: number
  /** 检测到变化并发了消息的链接数。 */
  changed: number
  /** 发出的消息条数。 */
  messages: number
  /** 抓取失败的链接数（已记可见状态，未发消息）。 */
  errors: number
}

/** 把 `fetchUrlText` 的错误码映射到可见的 `last_status`。 */
function fetchErrorToStatus(code: string): 'unreachable' | 'blocked' | 'unsupported' {
  if (code === 'blocked_url') return 'blocked'
  if (code === 'unsupported_file_type') return 'unsupported'
  // bad_request / no_content / upstream_error / timeout / 等 → 统一"打不开"。
  return 'unreachable'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 单条链接的检查 + 可能发消息。返回本轮是否发了消息（用于计数）。 */
async function checkOne(supabase: SupabaseClient, link: LinkCheckTarget): Promise<boolean> {
  const fetched = await fetchUrlText(link.url)

  if (!fetched.ok) {
    await applyCheckResult(supabase, link.id, {
      status: fetchErrorToStatus(fetched.code),
      error: fetched.message,
    })
    return false
  }

  const newFingerprint = segmentText(fetched.text)
  const diff = diffFingerprints(link.fingerprint, newFingerprint)

  const hasChange = diff.changed.length > 0 || diff.added.length > 0 || diff.removed.length > 0

  if (!hasChange) {
    // 无变化：刷新指纹 + 状态，不发消息（幂等关键点）。
    await applyCheckResult(supabase, link.id, {
      fingerprint: newFingerprint,
      status: 'ok',
      error: null,
    })
    return false
  }

  // 有变化：先发消息（append-only，无落点），再推进指纹基线。
  const displayName = link.label?.trim() || hostOf(link.url)
  const details = diffToDetails(diff)
  const messageId = await insertLinkChangeMessage(supabase, {
    userId: link.userId,
    courseId: link.courseId,
    courseName: link.courseName,
    url: link.url,
    displayName,
    details,
  })
  await applyCheckResult(supabase, link.id, {
    fingerprint: newFingerprint,
    status: 'ok',
    error: null,
  })
  return messageId !== null
}

/**
 * 跑一轮全部链接检查（由 `/api/v1/links/check` 在 Cron 鉴权后调用）。
 *
 * 单条失败不影响其余（每条独立 try，异常本地吞掉并记日志——不静默整轮）。
 */
export async function runLinkCheck(supabase: SupabaseClient): Promise<LinkCheckReport> {
  const report: LinkCheckReport = { checked: 0, changed: 0, messages: 0, errors: 0 }
  const links = await loadLinksForCheck(supabase)

  for (const link of links) {
    report.checked += 1
    try {
      const posted = await checkOne(supabase, link)
      if (posted) {
        report.changed += 1
        report.messages += 1
      }
    } catch (error) {
      report.errors += 1
      console.error('[links/check] 单条检查异常:', link.id, error)
      // 失败也要给个可见状态，别无声消失（R3）。
      try {
        await applyCheckResult(supabase, link.id, {
          status: 'unreachable',
          error: '检查过程出错，稍后重试',
        })
      } catch {
        /* 连状态都写不进就只剩日志了 */
      }
    }
  }

  return report
}
