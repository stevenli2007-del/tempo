import type { createClient } from '@/lib/supabase/server'

/**
 * 四项量化指标的计算（P0-3-1，口径与 `PRD.md` 8.1 一致）。
 *
 * ### 为什么拆成「纯函数 + loader」两层
 * 跟 `lib/sync/status.ts` / `lib/sync/expiry.ts` 同款理由：指标的判定逻辑
 * （谁算被提醒过、7 天窗口从哪天开始、哪些课程进分母）全是**容易出错的口径问题**，
 * 放进路由就只能起 Next + 造真实数据验证。拆成纯函数后能在 Node 里直跑断言，
 * 也能让 Steven 指着某条口径说"这里不该这么算"时改一处即可。
 *
 * `loadMetrics()` 只负责取数 + 映射，判定全部下沉到下面的四个 `compute*`。
 *
 * ### 四项的口径（逐条对应 PRD 8.1）
 * 1. **编辑修正率** = 解析成功的课程里，有过至少一条 `parse_corrections` 的比例。
 *    分母取「**解析完成**」而非「上传过」：解析失败的 syllabus 没有任何可被修正的
 *    结果，把它们算进分母只会稀释指标（PRD 原文"上传过 syllabus 的课程"按意图收敛）。
 * 2. **7 日回访次数** = 关联数据源后 7 天内打开总览页的次数，锚点取
 *    `canvas_credentials.created_at`（**连接 Canvas 那一刻**）—— 连都没连过的人
 *    不存在"回访"。同一天多次打开照算次数，另给 `activeDays`（去重天数）做对照口径。
 * 3. **人均关联课程数** = 未归档且 `canvas_course_id` 非空的课程数 ÷ **全部用户数**
 *    （含注册后什么都没做的，这才是"人均"；`perUser` 明细里能看到分布）。
 * 4. **token 续期完成率** = 被提醒过的人里，之后真的重新授权过的比例。
 *    分母 = 出现过过期横幅的人（`expiry_reminder_shown`），
 *    分子 = 其中在提醒之后产生过 `credential_renewed` 的人。
 *
 * ⚠️ 全部指标都是**跨用户**的，所以 `loadMetrics()` 必须用 service role 客户端
 * （`lib/supabase/admin.ts`）—— 用户级客户端在 RLS 下只看得见自己，算不出"人均"。
 */

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

/** 7 日回访窗口（天）。PRD 8.1 原话「关联数据源后 7 天内」。 */
export const RETURN_VISIT_WINDOW_DAYS = 7

const DAY_MS = 86_400_000

/** 单行上限。Phase 0 只有个位数用户，这不是真实限制，只为防止误用拖垮请求。 */
const ROW_LIMIT = 50_000

// ---------------------------------------------------------------- 行类型

/** `syllabi`：分母只认 `parse_status = 'completed'`。 */
export type SyllabusMetricRow = {
  id: string
  courseId: string
  parseStatus: string
}

/** `parse_corrections`：只需要知道它落在哪份 syllabus 上。 */
export type CorrectionMetricRow = {
  syllabusId: string | null
}

/** `usage_events`。`eventType` 用 string：库里可能有我们尚未定义的历史取值。 */
export type UsageEventMetricRow = {
  userId: string
  eventType: string
  createdAt: string
}

/** `canvas_credentials.created_at` = 连接数据源的时刻（7 日窗口锚点）。 */
export type CredentialMetricRow = {
  userId: string
  createdAt: string
}

export type CourseMetricRow = {
  userId: string
  canvasCourseId: string | null
  isArchived: boolean
}

export type ProfileMetricRow = {
  id: string
}

// ---------------------------------------------------------------- 纯函数

/**
 * 比率。分母为 0 时返回 **null 而不是 0** —— "一门解析过的课都没有"和
 * "有 10 门但一门都没改"是两个事实，返回 0 会把前者伪装成后者的最差值。
 */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 1000) / 1000
}

/** UTC 日历日（`YYYY-MM-DD`），用于"活跃天数"去重。 */
function utcDay(iso: string): string {
  return iso.slice(0, 10)
}

function timestamp(iso: string): number {
  return Date.parse(iso)
}

export type EditCorrectionRate = {
  /** 分母：解析成功的课程数（按 course 去重，一门课多份 syllabus 只算一次）。 */
  parsedCourses: number
  /** 分子：其中有过修正记录的课程数。 */
  correctedCourses: number
  /** `correctedCourses / parsedCourses`；分母 0 时为 null。 */
  rate: number | null
}

export function computeEditCorrectionRate(input: {
  syllabi: SyllabusMetricRow[]
  corrections: CorrectionMetricRow[]
}): EditCorrectionRate {
  const parsedCourseIds = new Set<string>()
  const courseBySyllabus = new Map<string, string>()
  for (const syllabus of input.syllabi) {
    courseBySyllabus.set(syllabus.id, syllabus.courseId)
    if (syllabus.parseStatus === 'completed') {
      parsedCourseIds.add(syllabus.courseId)
    }
  }

  const corrected = new Set<string>()
  for (const correction of input.corrections) {
    if (correction.syllabusId === null) continue
    const courseId = courseBySyllabus.get(correction.syllabusId)
    // 归因到已不存在的 syllabus（课程被删）→ 跳过，不计入分子。
    if (courseId === undefined) continue
    // 只认解析成功的课程：与分母同一集合，否则 rate 可能 > 1。
    if (!parsedCourseIds.has(courseId)) continue
    corrected.add(courseId)
  }

  return {
    parsedCourses: parsedCourseIds.size,
    correctedCourses: corrected.size,
    rate: ratio(corrected.size, parsedCourseIds.size),
  }
}

export type UserReturnVisits = {
  userId: string
  /** 窗口起点 = 该用户连接 Canvas 的时刻。 */
  windowStart: string
  windowEnd: string
  /** 窗口内打开总览页的次数（含同一天多次）。 */
  visits: number
  /** 对照口径：窗口内有多少个**不同日期**打开过。 */
  activeDays: number
}

export type ReturnVisits = {
  /** 分母：连过 Canvas 的用户数（没连过的人不存在"回访"）。 */
  users: number
  windowDays: number
  /** 人均打开次数。 */
  averageVisits: number | null
  /** 人均活跃天数（对照口径）。 */
  averageActiveDays: number | null
  perUser: UserReturnVisits[]
}

export function computeReturnVisits(input: {
  credentials: CredentialMetricRow[]
  events: UsageEventMetricRow[]
  windowDays?: number
}): ReturnVisits {
  const windowDays = input.windowDays ?? RETURN_VISIT_WINDOW_DAYS

  // 一个用户理论上只有一条凭据（迁移里有 unique），仍取最早那条兜底。
  const anchorByUser = new Map<string, number>()
  for (const credential of input.credentials) {
    const at = timestamp(credential.createdAt)
    if (Number.isNaN(at)) continue
    const current = anchorByUser.get(credential.userId)
    if (current === undefined || at < current) {
      anchorByUser.set(credential.userId, at)
    }
  }

  const perUser = Array.from(anchorByUser, ([userId, start]) => {
    const end = start + windowDays * DAY_MS
    const days = new Set<string>()
    let visits = 0
    for (const event of input.events) {
      if (event.userId !== userId) continue
      if (event.eventType !== 'dashboard_view') continue
      const at = timestamp(event.createdAt)
      if (Number.isNaN(at) || at < start || at >= end) continue
      visits += 1
      days.add(utcDay(event.createdAt))
    }
    return {
      userId,
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(end).toISOString(),
      visits,
      activeDays: days.size,
    }
  }).sort((a, b) => b.visits - a.visits)

  const totalVisits = perUser.reduce((sum, item) => sum + item.visits, 0)
  const totalDays = perUser.reduce((sum, item) => sum + item.activeDays, 0)

  return {
    users: perUser.length,
    windowDays,
    averageVisits: ratio(totalVisits, perUser.length),
    averageActiveDays: ratio(totalDays, perUser.length),
    perUser,
  }
}

export type LinkedCourses = {
  /** 分母：全部用户数（含注册后没建课的）。 */
  users: number
  /** 分子：未归档且已关联 Canvas 的课程数。 */
  linkedCourses: number
  /** `linkedCourses / users`。 */
  average: number | null
  perUser: { userId: string; linkedCourses: number }[]
}

export function computeLinkedCourses(input: {
  profiles: ProfileMetricRow[]
  courses: CourseMetricRow[]
}): LinkedCourses {
  const linkedByUser = new Map<string, number>()
  let linkedCourses = 0

  for (const course of input.courses) {
    // 归档课不计：它是上学期的历史，不该抬高"接入门槛可不可接受"这个信号。
    if (course.isArchived || course.canvasCourseId === null) continue
    linkedCourses += 1
    linkedByUser.set(course.userId, (linkedByUser.get(course.userId) ?? 0) + 1)
  }

  const perUser = input.profiles
    .map((profile) => ({
      userId: profile.id,
      linkedCourses: linkedByUser.get(profile.id) ?? 0,
    }))
    .sort((a, b) => b.linkedCourses - a.linkedCourses)

  return {
    users: input.profiles.length,
    linkedCourses,
    average: ratio(linkedCourses, input.profiles.length),
    perUser,
  }
}

export type TokenRenewal = {
  /** 分母：看到过期横幅的人。 */
  remindedUsers: number
  /** 分子：其中之后重新授权过的人。 */
  renewedUsers: number
  /** `renewedUsers / remindedUsers`；没人被提醒过时为 null（不是 0%）。 */
  rate: number | null
}

export function computeTokenRenewal(events: UsageEventMetricRow[]): TokenRenewal {
  const firstReminderByUser = new Map<string, number>()
  const renewalsByUser = new Map<string, number[]>()

  for (const event of events) {
    const at = timestamp(event.createdAt)
    if (Number.isNaN(at)) continue

    if (event.eventType === 'expiry_reminder_shown') {
      const current = firstReminderByUser.get(event.userId)
      if (current === undefined || at < current) {
        firstReminderByUser.set(event.userId, at)
      }
      continue
    }

    if (event.eventType === 'credential_renewed') {
      const list = renewalsByUser.get(event.userId)
      if (list) {
        list.push(at)
      } else {
        renewalsByUser.set(event.userId, [at])
      }
    }
  }

  let renewedUsers = 0
  for (const [userId, firstReminderAt] of firstReminderByUser) {
    const renewals = renewalsByUser.get(userId) ?? []
    // 续期必须发生在**被提醒之后**：之前就换过 token 的人不算"提醒促成"。
    if (renewals.some((at) => at >= firstReminderAt)) {
      renewedUsers += 1
    }
  }

  return {
    remindedUsers: firstReminderByUser.size,
    renewedUsers,
    rate: ratio(renewedUsers, firstReminderByUser.size),
  }
}

// ---------------------------------------------------------------- loader

export type MetricsReport = {
  generatedAt: string
  editCorrectionRate: EditCorrectionRate
  returnVisits: ReturnVisits
  linkedCourses: LinkedCourses
  tokenRenewal: TokenRenewal
}

/** 表 → 指标行的映射。字段名在这里从 snake_case 转成 camelCase，纯函数只看后者。 */
type Rows = {
  profiles: ProfileMetricRow[]
  syllabi: SyllabusMetricRow[]
  corrections: CorrectionMetricRow[]
  courses: CourseMetricRow[]
  credentials: CredentialMetricRow[]
  events: UsageEventMetricRow[]
}

/** 取数失败一律抛出：指标宁可报错，也不能在缺数据的情况下算出"看起来正常"的数。 */
async function loadRows(supabase: SupabaseClient): Promise<Rows> {
  const [
    profilesResult,
    syllabiResult,
    correctionsResult,
    coursesResult,
    credentialsResult,
    eventsResult,
  ] = await Promise.all([
    supabase.from('profiles').select('id').limit(ROW_LIMIT),
    supabase.from('syllabi').select('id, course_id, parse_status').limit(ROW_LIMIT),
    supabase.from('parse_corrections').select('syllabus_id').limit(ROW_LIMIT),
    supabase
      .from('courses')
      .select('user_id, canvas_course_id, is_archived')
      .limit(ROW_LIMIT),
    supabase.from('canvas_credentials').select('user_id, created_at').limit(ROW_LIMIT),
    supabase.from('usage_events').select('user_id, event_type, created_at').limit(ROW_LIMIT),
  ])

  const failures = [
    ['profiles', profilesResult.error],
    ['syllabi', syllabiResult.error],
    ['parse_corrections', correctionsResult.error],
    ['courses', coursesResult.error],
    ['canvas_credentials', credentialsResult.error],
    ['usage_events', eventsResult.error],
  ] as const

  for (const [table, error] of failures) {
    if (error) {
      throw new Error(`读取 ${table} 失败：${error.message}`)
    }
  }

  return {
    profiles: ((profilesResult.data ?? []) as { id: string }[]).map((row) => ({ id: row.id })),
    syllabi: ((syllabiResult.data ?? []) as {
      id: string
      course_id: string
      parse_status: string
    }[]).map((row) => ({
      id: row.id,
      courseId: row.course_id,
      parseStatus: row.parse_status,
    })),
    corrections: ((correctionsResult.data ?? []) as { syllabus_id: string | null }[]).map((row) => ({
      syllabusId: row.syllabus_id,
    })),
    courses: ((coursesResult.data ?? []) as {
      user_id: string
      canvas_course_id: string | null
      is_archived: boolean
    }[]).map((row) => ({
      userId: row.user_id,
      canvasCourseId: row.canvas_course_id,
      isArchived: row.is_archived,
    })),
    credentials: ((credentialsResult.data ?? []) as { user_id: string; created_at: string }[]).map(
      (row) => ({
        userId: row.user_id,
        createdAt: row.created_at,
      }),
    ),
    events: ((eventsResult.data ?? []) as {
      user_id: string
      event_type: string
      created_at: string
    }[]).map((row) => ({
      userId: row.user_id,
      eventType: row.event_type,
      createdAt: row.created_at,
    })),
  }
}

/**
 * 读全量数据 → 算四项指标。
 *
 * 必须用 service role 客户端调用（见文件头说明）；用用户级客户端会因为 RLS
 * 只看到自己，算出的是"我一个人"的指标。
 */
export async function loadMetrics(supabase: SupabaseClient): Promise<MetricsReport> {
  const rows = await loadRows(supabase)

  return {
    generatedAt: new Date().toISOString(),
    editCorrectionRate: computeEditCorrectionRate({
      syllabi: rows.syllabi,
      corrections: rows.corrections,
    }),
    returnVisits: computeReturnVisits({
      credentials: rows.credentials,
      events: rows.events,
    }),
    linkedCourses: computeLinkedCourses({
      profiles: rows.profiles,
      courses: rows.courses,
    }),
    tokenRenewal: computeTokenRenewal(rows.events),
  }
}
