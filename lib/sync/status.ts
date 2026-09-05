import type { Course } from '@/types/course'

/**
 * 同步状态的视图模型（P0-2-7，Sync-Strategy §9「失败可见性」的落点）。
 *
 * ### 为什么单独拆一层纯函数
 * 状态条与课程卡片要展示的东西，本质上都是「把 `courses` 的三列 + 凭证状态翻译成人话」。
 * 放进组件里就只能靠起一个 Next 运行时 + 造数据才能验证；拆成纯函数后可以直接在
 * Node 里跑断言（本卡自测就是这么做的），也能保证顶部汇总与卡片行**用同一套判定**，
 * 不会出现「顶部说同步成功、卡片说同步失败」这种自相矛盾。
 *
 * ### 三条硬规则（来自 Sync-Strategy §9 与 PRD F4）
 * 1. **绝不静默展示旧数据**：失败或陈旧必须说出来，且要说出数据停留在什么时候。
 * 2. **`never` 不等于「没有任务」**：从未同步成功过，必须引导同步，不能显示"近期没有待办"了事。
 * 3. **失败要分级**：用户能修的（重新连接 Canvas）与只能等的（网络 / Canvas 挂了）
 *    给不同的行动建议 —— 对一个你无能为力的故障喊"请处理"只是制造焦虑。
 *
 * ⚠️ 本文件**只做纯计算**，`now` 由调用方传入（服务端算好），
 * 不在内部调 `new Date()` —— 服务端与客户端各算一遍必然 hydration mismatch。
 */

/** 陈旧阈值：超过 24 小时没成功同步就要在顶部提示（Sync-Strategy §9）。 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * 失败分级。
 *
 * - `fixable`：用户能修 —— Canvas 连接失效（token 过期 / 被撤销 / 被 Canvas 拒绝）。
 *   行动是「重新连接 Canvas」，不说"稍后重试"，因为重试一万次也不会成功。
 * - `transient`：用户只能等 —— 网络超时、Canvas 5xx、限流、熔断。
 *   行动是「系统会自动重试」，不说"请重新连接"，因为连接本身没问题。
 */
export type SyncFailureKind = 'fixable' | 'transient'

/** 与 `courses.sync_status` 的 CHECK 约束一致（迁移 20260902003000 :59-60）。 */
export type CourseSyncState = 'never' | 'success' | 'failed'

/** 一门已关联 Canvas 的课，从用户视角看的同步状态。 */
export type CourseSyncView = {
  courseId: string
  courseName: string
  state: CourseSyncState
  /**
   * 最后一次**成功**同步的时间；null = 从未成功过。
   *
   * ⚠️ 这个语义依赖 `last_synced_at` 只在成功时写入 —— 本卡把同步编排里
   * 「失败也写 `last_synced_at`」的行为改掉了，否则失败后"数据停留在 X"永远指的是
   * 失败那一刻，等于把旧数据伪装成刚同步过的样子（详见 `lib/sync/canvas-sync.ts`）。
   */
  lastSuccessAt: string | null
  /** 失败原因（给用户看的原文）；非失败态为 null。 */
  errorMessage: string | null
  failureKind: SyncFailureKind | null
}

export type SyncOverviewLevel =
  /** 没有任何已关联 Canvas 的课程 —— 状态条整体不渲染。 */
  | 'not_linked'
  /** 关联了但一门都没成功同步过。 */
  | 'never'
  /** 全部正常且数据是新的。 */
  | 'ok'
  /** 能同步，但数据不是新的（超过 24h 或有课从未成功过）。 */
  | 'stale'
  /** 至少一门课同步失败。 */
  | 'failed'

export type SyncOverview = {
  /** 参与同步的课程数（已关联 Canvas 且未归档）。 */
  total: number
  syncedCount: number
  neverCount: number
  failedCount: number
  /** 失败课程明细（按课程列表原序）。 */
  failedCourses: CourseSyncView[]
  /** 所有课程里最近的一次成功同步时间（含"失败前成功过"的课）；全都没成功过则为 null。 */
  lastSuccessAt: string | null
  level: SyncOverviewLevel
  /** level = 'stale' 时说明原因。 */
  staleReason: 'outdated' | 'never_synced' | null
  /** 失败分级：只要有课是 fixable 就取 fixable（能修的优先展示，它才有行动价值）。 */
  failureKind: SyncFailureKind | null
}

/** 卡片上的一行状态文案。由服务端算好再传进客户端组件，避免时区导致 hydration mismatch。 */
export type CourseSyncLine = {
  text: string
  tone: 'muted' | 'error'
  /** hover 时展示的细节（失败原文）。 */
  hint: string | null
}

/**
 * 相对时间文案。
 *
 * 绝对时间用 **UTC** 渲染（与 dashboard 的 `DUE_FORMATTER` 同款取舍）——
 * 服务端与浏览器时区不同会 hydration mismatch，Phase 0 接受这个偏差。
 */
const pad = (value: number) => String(value).padStart(2, '0')

/**
 * 超过 24 小时的用「9月5日 21:47」这种绝对时间，按 **UTC** 渲染。
 *
 * 不用 `Intl.DateTimeFormat('zh-CN')`：它把月日渲染成 `9/5`，中文界面里偏机器味；
 * 这里要的是"哪天几点"，手写两行比跟格式化器较劲省事。
 */
function formatAbsoluteUtc(date: Date): string {
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}（UTC）`
}

/** 把 ISO 时间渲染成「3 分钟前 / 5 小时前 / 9月5日 21:47」。 */
export function formatSyncTime(iso: string, now: Date): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    // 库里的时间串不该解析失败；真出现了也不能编一个"刚刚"出来（静默的错误数据）。
    return '时间未知'
  }
  const elapsed = now.getTime() - then
  if (elapsed < 0) {
    // 时钟回拨 / 未来时间。宁可说"刚刚"也不要渲染成负数。
    return '刚刚'
  }
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < STALE_AFTER_MS) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`
  return formatAbsoluteUtc(new Date(then))
}

/**
 * 单门课 → 状态视图。
 *
 * @param credentialUsable 凭证是否存在且 `status === 'active'`。它决定失败分级：
 *   连接本身坏了 → 用户能修；连接是好的却同步失败 → 用户只能等。
 */
export function toCourseSyncView(
  course: Course,
  options: { credentialUsable: boolean },
): CourseSyncView {
  const state = course.syncStatus
  return {
    courseId: course.id,
    courseName: course.courseName,
    state,
    // never 时即便库里残留了 last_synced_at 也不采信 —— 那可能是修语义之前写进去的
    // 失败时间，当成"最后同步于"展示就是把旧数据伪装成新的。
    lastSuccessAt: state === 'never' ? null : course.lastSyncedAt,
    errorMessage: state === 'failed' ? course.syncError : null,
    failureKind: state === 'failed' ? (options.credentialUsable ? 'transient' : 'fixable') : null,
  }
}

/**
 * 汇总。
 *
 * 优先级：**failed > never > stale > ok**。
 * 失败最该被看见；"一门都没同步过"次之（用户看到的是空任务列表，最容易误判成"这周没作业"）；
 * 然后才是陈旧；全绿才是 ok。
 */
export function summarizeSyncStatus(views: CourseSyncView[], now: Date): SyncOverview {
  const failedCourses = views.filter((view) => view.state === 'failed')
  const successViews = views.filter((view) => view.state === 'success')
  const neverViews = views.filter((view) => view.state === 'never')

  // 🔴 遍历**所有**课，不只是成功的课。
  // 只有一门课且它刚失败时（成功过 2 小时前，随后挂了），若只看成功课就会得出
  // lastSuccessAt = null → UI 说"这些课还没有成功同步过"，与事实相反。
  // 失败的课同样带着"上一次成功是什么时候"，那正是"数据停留在 X"要的答案。
  let lastSuccessAt: string | null = null
  for (const view of views) {
    if (view.lastSuccessAt === null) continue
    if (lastSuccessAt === null || Date.parse(view.lastSuccessAt) > Date.parse(lastSuccessAt)) {
      lastSuccessAt = view.lastSuccessAt
    }
  }

  const failureKind: SyncFailureKind | null =
    failedCourses.length === 0
      ? null
      : failedCourses.some((view) => view.failureKind === 'fixable')
        ? 'fixable'
        : 'transient'

  if (views.length === 0) {
    return {
      total: 0,
      syncedCount: 0,
      neverCount: 0,
      failedCount: 0,
      failedCourses: [],
      lastSuccessAt: null,
      level: 'not_linked',
      staleReason: null,
      failureKind: null,
    }
  }

  let level: SyncOverviewLevel
  let staleReason: 'outdated' | 'never_synced' | null = null

  if (failedCourses.length > 0) {
    level = 'failed'
  } else if (successViews.length === 0) {
    level = 'never'
  } else {
    // 有课从未成功同步过 → 它的作业根本没进列表，比"数据旧"更值得提示。
    if (neverViews.length > 0) {
      level = 'stale'
      staleReason = 'never_synced'
    } else if (
      lastSuccessAt === null ||
      now.getTime() - Date.parse(lastSuccessAt) > STALE_AFTER_MS
    ) {
      level = 'stale'
      staleReason = 'outdated'
    } else {
      level = 'ok'
    }
  }

  return {
    total: views.length,
    syncedCount: successViews.length,
    neverCount: neverViews.length,
    failedCount: failedCourses.length,
    failedCourses,
    lastSuccessAt,
    level,
    staleReason,
    failureKind,
  }
}

/**
 * 课程卡片那一行状态。
 *
 * 未关联 Canvas 的课**不该**调用它 —— 那种课没有"同步"这回事，
 * 给它显示一行同步状态是无意义的噪声（调用方负责过滤）。
 */
export function toCourseSyncLine(view: CourseSyncView, now: Date): CourseSyncLine {
  if (view.state === 'never') {
    return { text: 'Canvas 作业还没同步', tone: 'muted', hint: null }
  }

  if (view.state === 'success') {
    const when = view.lastSuccessAt === null ? null : formatSyncTime(view.lastSuccessAt, now)
    return {
      text: when === null ? 'Canvas 已同步' : `Canvas 已同步 · ${when}`,
      tone: 'muted',
      hint: null,
    }
  }

  // 失败态：文案必须说出"数据停留在什么时候"，否则用户会以为列表是新的。
  if (view.failureKind === 'fixable') {
    return {
      text: 'Canvas 同步失败 · 需要重新连接',
      tone: 'error',
      hint: view.errorMessage ?? '需要重新生成 Canvas token',
    }
  }

  const when = view.lastSuccessAt === null ? null : formatSyncTime(view.lastSuccessAt, now)
  return {
    text:
      when === null
        ? 'Canvas 同步失败 · 还没同步成功过'
        : `Canvas 同步失败 · 数据停留在 ${when}`,
    tone: 'error',
    hint: view.errorMessage,
  }
}

/**
 * 状态条里"失败课程名"的列表文案，最多列 3 个。
 *
 * 六门课全挂时把六个名字铺在顶部不是信息，是压迫感。列出前三个 + "等 N 门"。
 */
export function formatFailedCourseNames(views: CourseSyncView[], max = 3): string {
  const names = views.slice(0, max).map((view) => view.courseName)
  const rest = views.length - names.length
  return rest > 0 ? `${names.join('、')} 等 ${views.length} 门` : names.join('、')
}
