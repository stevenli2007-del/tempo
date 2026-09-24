/**
 * course_links 读写层（P0-5-3，服务端专用）。
 *
 * ### 安全
 * - `validateLinkUrl` 复用 `lib/ingest/url-fetch.ts` 的 SSRF 主机拦截
 *   （169.254 / 10. / 127. / 172.16-31 / 192.168 / localhost / .local / .internal …），
 *   再加协议 + 凭据检查。三道闸门在发请求前（ADR-026 / ADR-013）。
 * - 写入只存 URL + 分段指纹（`fingerprint.ts`），**原文绝不落库**。
 *
 * ### 归属 / RLS
 * 表无 `user_id` 列，归属靠 `course_id → courses.user_id`，策略在迁移里。
 * 用户态调用（POST/DELETE）走会话客户端，RLS 自然挡越权；
 * Cron 遍历走 service_role 客户端（绕过 RLS），但只作用于用户自己的课程链接。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isBlockedHostname } from '@/lib/ingest/url-fetch'
import type { LinkFingerprint } from './fingerprint'
import type { MessagePayload } from '@/types/message'

export type LinkCheckStatus = 'pending' | 'ok' | 'unreachable' | 'blocked' | 'unsupported'

/** 视图层用的链接行（camelCase，已映射自 DB 行）。 */
export type CourseLinkView = {
  id: string
  courseId: string
  url: string
  label: string | null
  pageTitle: string | null
  fingerprint: LinkFingerprint | null
  lastCheckedAt: string | null
  lastStatus: LinkCheckStatus
  lastError: string | null
  createdAt: string
}

export type LinkValidation =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string }

/**
 * 校验用户贴的链接：**只放行公开的 http(s) 网页**，挡本机 / 内网（SSRF 底线）。
 *
 * 注意：只做**字面量**层面的协议 + 主机拦截（不做 DNS 解析）。
 * DNS 解析后的真实 IP 拦截在 `fetchUrlText` 发请求前那一关（Cron / 首抓都走它），
 * 所以即便这里放过了某个字面量合法的域名，真去抓时仍会被 `checkDestination` 拦下。
 */
export function validateLinkUrl(raw: string): LinkValidation {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, code: 'bad_request', message: '链接格式不正确' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'bad_request', message: '只支持 http / https 链接' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'bad_request', message: '链接里不能带账号密码' }
  }
  if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      code: 'blocked_url',
      message: '出于安全考虑，不能监控本机 / 内网地址',
    }
  }
  // 规整一下（去尾斜杠差异、小写 host 已在 URL 构造里处理）。
  return { ok: true, url: url.toString() }
}

function mapRow(row: Record<string, unknown>): CourseLinkView {
  return {
    id: row.id as string,
    courseId: row.course_id as string,
    url: row.url as string,
    label: (row.label as string | null) ?? null,
    pageTitle: (row.page_title as string | null) ?? null,
    fingerprint: (row.fingerprint as LinkFingerprint | null) ?? null,
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    lastStatus: (row.last_status as LinkCheckStatus) ?? 'pending',
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
  }
}

export type InsertResult =
  | { ok: true; link: CourseLinkView }
  | { ok: false; code: string; message: string }

/** 新增一条监控链接（会话客户端：RLS 保证只属于当前用户的课程）。 */
export async function insertCourseLink(
  supabase: SupabaseClient,
  args: { courseId: string; userId: string; url: string; label?: string | null },
): Promise<InsertResult> {
  const { data, error } = await supabase
    .from('course_links')
    .insert({
      course_id: args.courseId,
      url: args.url,
      label: args.label && args.label.trim() !== '' ? args.label.trim().slice(0, 80) : null,
      last_status: 'pending',
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return { ok: false, code: 'duplicate', message: '这个链接已经在监控列表中了' }
    }
    return { ok: false, code: error.code ?? 'db_error', message: error.message }
  }
  return { ok: true, link: mapRow(data as Record<string, unknown>) }
}

/**
 * 列出某门课的监控链接（会话客户端：只返回当前用户可见的）。
 *
 * 与 `loadCourseFiles` 同约定：返回 `{ links, error }` 而非裸数组 ——
 * 查询失败必须显式暴露（CodingRules 7），调用方画错而非静默空列表。
 */
export async function listCourseLinks(
  supabase: SupabaseClient,
  courseId: string,
): Promise<{ links: CourseLinkView[]; error: string | null }> {
  const { data, error } = await supabase
    .from('course_links')
    .select('*')
    .eq('course_id', courseId)
    .order('created_at', { ascending: true })

  if (error) {
    return { links: [], error: error.message }
  }
  return { links: (data as Record<string, unknown>[]).map(mapRow), error: null }
}

export type DeleteResult = { ok: true; deleted: boolean } | { ok: false; code: string; message: string }

/** 删除一条监控链接（同时按 course_id 收口，确保只删本课程的链接）。 */
export async function deleteCourseLink(
  supabase: SupabaseClient,
  courseId: string,
  linkId: string,
): Promise<DeleteResult> {
  const { error, count } = await supabase
    .from('course_links')
    .delete()
    .eq('id', linkId)
    .eq('course_id', courseId)

  if (error) {
    return { ok: false, code: error.code ?? 'db_error', message: error.message }
  }
  return { ok: true, deleted: (count ?? 0) > 0 }
}

/** Cron 遍历用的一行（含归属课程的用户与课名，用于发消息栏提案）。 */
export type LinkCheckTarget = {
  id: string
  courseId: string
  userId: string
  courseName: string | null
  url: string
  /** 用户给的备注名（可空）；变化时消息标题优先用它做展示名。 */
  label: string | null
  fingerprint: LinkFingerprint | null
}

/**
 * 拉全部待检查的链接（service_role 客户端：绕过 RLS 遍历所有用户）。
 *
 * 经 `course_links → courses` 取出归属用户与课名，消息栏提案按这个 userId 投。
 */
export async function loadLinksForCheck(supabase: SupabaseClient): Promise<LinkCheckTarget[]> {
  const { data, error } = await supabase
    .from('course_links')
    .select('id, url, label, fingerprint, course_id, courses(user_id, course_name)')

  if (error) {
    console.error('[links/check] 拉取监控链接失败:', error.message)
    return []
  }

  const out: LinkCheckTarget[] = []
  for (const row of data as Array<Record<string, unknown>>) {
    const courses = (row.courses as { user_id: string; course_name: string | null } | null) ?? null
    if (!courses) continue // 课程已被删 → 链接 CASCADE 也该没了，兜底跳过
    out.push({
      id: row.id as string,
      courseId: row.course_id as string,
      userId: courses.user_id,
      courseName: courses.course_name ?? null,
      url: row.url as string,
      label: (row.label as string | null) ?? null,
      fingerprint: (row.fingerprint as LinkFingerprint | null) ?? null,
    })
  }
  return out
}

/** 写入一次检查结果（fingerprint 只在拿到新值时更新；失败时保留旧指纹）。 */
export async function applyCheckResult(
  supabase: SupabaseClient,
  id: string,
  args: { fingerprint?: LinkFingerprint | null; status: LinkCheckStatus; error?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {
    last_checked_at: new Date().toISOString(),
    last_status: args.status,
    last_error: args.error ?? null,
  }
  if (args.fingerprint !== undefined) {
    patch.fingerprint = args.fingerprint
  }
  const { error } = await supabase.from('course_links').update(patch).eq('id', id)
  if (error) {
    console.error('[links/check] 写入检查结果失败:', id, error.message)
  }
}

/**
 * 建一条「链接变更」消息（append-only，无落点 → 用户点「知道了」即收走）。
 *
 * 只报「变了 / 哪块变了」，不做全文摘要（卡面红线）。
 */
export async function insertLinkChangeMessage(
  supabase: SupabaseClient,
  args: {
    userId: string
    courseId: string
    courseName: string | null
    url: string
    displayName: string
    details: string[]
  },
): Promise<string | null> {
  const payload: MessagePayload = {
    title: `「${args.displayName}」内容有更新`,
    details: args.details,
    courseId: args.courseId,
    courseName: args.courseName ?? undefined,
    sourceUrl: args.url,
    landing: false,
    confidence: 'high',
  }
  const { data, error } = await supabase
    .from('messages')
    .insert({ user_id: args.userId, type: 'link_change', payload, status: 'pending' })
    .select('id')
    .single()

  if (error) {
    console.error('[links/check] 链接变更消息创建失败:', error.message)
    return null
  }
  return (data as { id: string }).id
}
