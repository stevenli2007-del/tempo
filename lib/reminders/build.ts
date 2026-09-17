import type { TaskStatus, TaskSubmissionState, TaskType } from '@/types/task'
import { isEffectivelyDone } from '@/lib/tasks/progress'

/**
 * 提醒邮件的「内容渲染层」（P0-3-14）。
 *
 * ### 只放纯函数，零 IO、零数据库
 * 排序 / 可行动判定 / HTML·文本渲染都在这一个文件里，可被回归脚本直接 import 断言
 * （与 `lib/tasks.ts` 的 toTask、`lib/email/plan.ts` 同一条「业务逻辑与 IO 分离」约定）。
 *
 * ### 「优先级」口径 = 截止临近排序（Steven 拍板 2026-09-17）
 * 不碰 Phase 2 的 routine/今日任务权重体系。邮件里任务按 dueDate 升序排、TBD 排最后，
 * 最早到期的置顶 —— 直接回答「先做什么」，零歧义、零主观偏差。
 *
 * ### 准确优先于频繁（ADR-016 R3）
 * `computeActionable` 只把「逾期或 DUE_SOON_DAYS 天内到期」的任务算作「可行动」，
 * 没有这类任务就**不发**邮件（避免无意义的每日轰炸）。TBD（null）任务会显示，但
 * 不单独触发发送 —— 日期都未知，催它没意义。
 */

/**
 * 「这条任务值得进提醒邮件吗」—— 提醒层的可提醒判据（P0-3-14 验收回归 #1）。
 *
 * ### 🔴 为什么必须走 `isEffectivelyDone()` 而不是只看 `status`
 * 实测踩坑（2026-09-17 Steven 验收发现）：首版引擎 SQL 只筛 `status='pending'`，
 * **完全没看 `submission_state`** → 真发的那封信里 21 条有 **18 条是 Canvas 已判定完成
 * （submitted / graded / pending_review）**、`status` 仍是 `pending`（ADR-015：同步永不写
 * `status`，等用户手勾）→ 邮件把它们标成「已逾期 14 天」。**误报率 86%**，
 * 直接违反 ADR-016 R3「一次误报比不提醒更伤信任」。
 *
 * `isEffectivelyDone()` 是**全站唯一**的完成判定（`lib/tasks/progress.ts`，
 * dashboard / 周历 / 任务清单共用）。这里**复用它**而不是重写一遍 —— 各写一份迟早漂开，
 * 那就会出现「UI 说已完成、邮件说逾期」这种自相矛盾。
 *
 * ### `external_unconfirmed` 也不提醒（ADR-013 / ADR-015）
 * 外部平台（Gradescope 等 LTI）：Canvas 没有可信记录（无记录，或它说的"未交"只是推断，
 * 实测出现过已交却报未交）。把它当"已完成"是猜，当"未完成"是**诬告** ——
 * 所以既不算完成、也不该被催。dashboard 同样不给它标红（`knownIncomplete` 的排除项）。
 *
 * ### ⚠️ `submissionState === null` **要提醒**（别顺手"统一"掉）
 * `null` = Canvas 压根不追踪完成态（on_paper / not_graded / none），
 * 也包含**全部 syllabus 派生考试与手动任务**。考试是一学期只有 3-5 次的高风险事项，
 * 因为"没有外部真相"就不提醒是灾难性的。`null ≠ 不确定`，只表示"这事得靠用户自己勾"。
 * （`progress.ts` 文件头警告过"两个消费者对考试任务态度相反"，这就是那类陷阱。）
 */
/** `isRemindable` 的最小入参形状（用结构类型而不是整个 `Task`，回归脚本可喂最小对象）。 */
export type RemindableInput = {
  status: TaskStatus
  submissionState: TaskSubmissionState | null
}

export function isRemindable(task: RemindableInput): boolean {
  if (isEffectivelyDone(task)) return false
  if (task.submissionState === 'external_unconfirmed') return false
  return true
}

/** 「截止临近」窗口：due date 距现在 ≤ 该天数（含逾期）的任务算「即将到期 / 可行动」。 */
export const DUE_SOON_DAYS = 3

/** 默认用户时区（`profiles.timezone` 缺省值）。渲染日期与「今天」判定共用，避免两处各写一遍。 */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles'

/** 一天毫秒数（避免魔法数字散落）。 */
const DAY_MS = 86_400_000

/** 邮件里展示的一条任务（已被 toTask 转成 camelCase，与对外 Task 一致）。 */
export type ReminderTaskView = {
  courseName: string
  title: string
  /** null = TBD（日期待定）。禁止用假日期填充（Database.md §3.9）。 */
  dueDate: string | null
  taskType: TaskType
}

export type ReminderBuildInput = {
  tasks: ReminderTaskView[]
  /** 用户时区（profiles.timezone，默认 America/Los_Angeles）。按学校时区渲染日期。 */
  timezone: string
  /** 「现在」的可注入点 —— 纯函数必须能喂固定时间做断言。 */
  now: Date
  /** 退订链接（已带 token）。 */
  unsubscribeUrl: string
  /** 落地页链接（「在 Tempo 查看」）。 */
  viewUrl: string
}

export type ReminderBuildResult = {
  subject: string
  html: string
  text: string
  /** 是否存在逾期或即将到期的任务（决定要不要发这封邮件）。 */
  actionable: boolean
  overdueCount: number
  dueSoonCount: number
  /** 正文实际列出的条数 == 可行动条数（逾期 + DUE_SOON_DAYS 天内）。聚焦版口径。 */
  shownCount: number
  /** 未列出、被折叠成「另有 N 项」的条数（远未来 + TBD）。 */
  hiddenCount: number
  /** hiddenCount 中「日期待定」(TBD) 的条数。 */
  hiddenTbdCount: number
  /** 全部 pending 任务数（= shownCount + hiddenCount）。 */
  totalCount: number
}

/**
 * 「截止临近排序」：按 dueDate 升序，null（TBD）排最后；同日按 title 稳定排序。
 *
 * 纯函数：返回新数组，不修改入参。
 */
export function sortByDueDateAsc(tasks: ReminderTaskView[]): ReminderTaskView[] {
  return [...tasks].sort((a, b) => {
    if (a.dueDate === null && b.dueDate === null) return a.title.localeCompare(b.title)
    if (a.dueDate === null) return 1
    if (b.dueDate === null) return -1
    const diff = Date.parse(a.dueDate) - Date.parse(b.dueDate)
    if (diff !== 0) return diff
    return a.title.localeCompare(b.title)
  })
}

/** 距今天数（可为负 = 逾期）。 */
function daysUntil(due: string, now: Date): number {
  return (Date.parse(due) - now.getTime()) / DAY_MS
}

/**
 * 判定「可行动」：存在逾期或未来 DUE_SOON_DAYS 天内到期的任务。
 * TBD（null）任务不计入 —— 它们的日期未知，催不动。
 */
export function computeActionable(
  tasks: ReminderTaskView[],
  now: Date,
): { actionable: boolean; overdueCount: number; dueSoonCount: number } {
  let overdueCount = 0
  let dueSoonCount = 0
  for (const t of tasks) {
    if (t.dueDate === null) continue
    const days = daysUntil(t.dueDate, now)
    if (days < 0) overdueCount += 1
    else if (days <= DUE_SOON_DAYS) dueSoonCount += 1
  }
  return { actionable: overdueCount + dueSoonCount > 0, overdueCount, dueSoonCount }
}

/**
 * 单条任务是否「可行动」：有明确 dueDate 且距今 ≤ DUE_SOON_DAYS（含已逾期）。
 * TBD（null）不算 —— 与 `computeActionable` 同一口径，供「聚焦版」正文筛选用。
 */
function isActionableTask(task: ReminderTaskView, now: Date): boolean {
  if (task.dueDate === null) return false
  return daysUntil(task.dueDate, now) <= DUE_SOON_DAYS
}

/** 用户本地日历日（`en-CA` 的输出恰好是 `YYYY-MM-DD`，可直接做相等比较）。 */
function localDayKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/**
 * 是否处在同一个「用户本地日历日」—— 频控判据（「每用户每天至多一封」）。
 *
 * ### 🔴 为什么不能用固定 24h 窗口（2026-09-17 实测踩到的静默 bug）
 * 定时任务固定在每天同一时刻触发（`vercel.json` 的 `0 14 * * *`），而 `last_reminder_at`
 * 记录的是**上一轮发送完成**的时刻 —— 必然略晚于上一轮的触发时刻。于是：
 * 昨 14:00:03 发送 → 今 14:00:00 检查，差值 86,397,000ms **小于** 24h → 判为「今天已发过」
 * → 跳过。**明天**再检查时差值已 > 24h → 发送。结果是「**隔天一封**」，而且完全静默
 * （日志只有 `reason: 'recent'`，看起来一切正常）。按「本地日历日」判定才是这句话的字面语义，
 * 也不受 cron 抖动 / 发送耗时漂移影响。
 */
export function isSameLocalDay(a: Date, b: Date, timezone: string): boolean {
  return localDayKey(a, timezone) === localDayKey(b, timezone)
}

/** 时区感知的日期格式化（只到「日期 + 星期」，不给时分，避免误导到具体钟点）。 */
function formatDueDate(due: string, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(due))
}

/** 「还有 N 天 / 今天到期 / 已逾期 N 天」标签。 */
function dueLabel(due: string, now: Date): { text: string; overdue: boolean } {
  const days = daysUntil(due, now)
  if (days < 0) return { text: `已逾期 ${Math.ceil(-days)} 天`, overdue: true }
  if (days < 1) return { text: '今天到期', overdue: false }
  return { text: `还有 ${Math.round(days)} 天`, overdue: false }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

type RenderedRow = {
  courseName: string
  title: string
  dueText: string
  dueFormatted: string | null
  overdue: boolean
}

function renderHtml(input: {
  rows: RenderedRow[]
  actionable: boolean
  overdueCount: number
  dueSoonCount: number
  hiddenCount: number
  hiddenTbdCount: number
  unsubscribeUrl: string
  viewUrl: string
}): string {
  const { rows, actionable, overdueCount, dueSoonCount, hiddenCount, hiddenTbdCount, unsubscribeUrl, viewUrl } = input
  const shown = overdueCount + dueSoonCount
  const lead = actionable
    ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#1d1d1f">你有 <strong style="color:#c0392b">${shown}</strong> 项任务即将到期或已逾期，先处理它们 👇</p>`
    : `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#1d1d1f">当前没有即将到期或已逾期的任务。</p>`

  const table =
    rows.length === 0
      ? ''
      : `
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <thead>
        <tr>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#86868b;font-weight:600;border-bottom:2px solid #ececec">课程</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#86868b;font-weight:600;border-bottom:2px solid #ececec">任务</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#86868b;font-weight:600;border-bottom:2px solid #ececec">期限</th>
        </tr>
      </thead>
      <tbody>${rows
        .map(
          (r) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #ececec;color:#6b6b70;font-size:13px;white-space:nowrap">${escapeHtml(r.courseName)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ececec;font-size:14px;color:#1d1d1f">${escapeHtml(r.title)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ececec;font-size:13px;text-align:right;${r.overdue ? 'color:#c0392b;font-weight:600' : 'color:#1d1d1f'}">${escapeHtml(r.dueText)}${r.dueFormatted ? `<br><span style="color:#9b9ba0;font-size:12px">${escapeHtml(r.dueFormatted)}</span>` : ''}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>`

  // 聚焦版（Steven 2026-09-17 拍板）：正文只列「可行动」项；其余折叠成一行计数 + 查看链接，
  // 避免「主题说 20、正文列 63」的洪水式日报（63 行连续收几天就会被无视，毁掉秘书定位）。
  const more =
    hiddenCount > 0
      ? `<p style="margin:0 0 20px;font-size:13px;color:#6b6b70;line-height:1.6">另有 <strong style="color:#1d1d1f">${hiddenCount}</strong> 项更远的任务${hiddenTbdCount > 0 ? `（含 ${hiddenTbdCount} 项日期待定）` : ''}，<a href="${escapeHtml(viewUrl)}" style="color:#5151ec;text-decoration:none">在 Tempo 查看</a>。</p>`
      : ''

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB',sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
    <div style="font-size:13px;font-weight:600;letter-spacing:0.5px;color:#86868b;margin-bottom:4px">TEMPO · 课程秘书</div>
    <h1 style="margin:0 0 16px;font-size:20px;color:#1d1d1f">你的待办提醒</h1>
    ${lead}${table}${more}
    <p style="margin:0;font-size:12px;color:#9b9ba0;line-height:1.6">
      Tempo 只在有任务即将到期时才给你发信，绝不刷屏。<br>
      不想再收到提醒？<a href="${escapeHtml(unsubscribeUrl)}" style="color:#5151ec">点此退订</a>。
    </p>
  </div>
</body>
</html>`
}

function renderText(input: {
  rows: RenderedRow[]
  actionable: boolean
  overdueCount: number
  dueSoonCount: number
  hiddenCount: number
  hiddenTbdCount: number
  unsubscribeUrl: string
  viewUrl: string
}): string {
  const { rows, actionable, overdueCount, dueSoonCount, hiddenCount, hiddenTbdCount, unsubscribeUrl, viewUrl } = input
  const shown = overdueCount + dueSoonCount
  const lines: string[] = []
  lines.push('TEMPO · 你的待办提醒')
  lines.push('')
  if (actionable) {
    lines.push(`你有 ${shown} 项任务即将到期或已逾期，先处理它们：`)
  } else {
    lines.push('当前没有即将到期或已逾期的任务。')
  }
  lines.push('')
  for (const r of rows) {
    const extra = r.dueFormatted ? `（${r.dueFormatted}）` : ''
    lines.push(`· [${r.courseName}] ${r.title} — ${r.dueText}${extra}`)
  }
  if (hiddenCount > 0) {
    lines.push('')
    lines.push(
      `另有 ${hiddenCount} 项更远的任务${hiddenTbdCount > 0 ? `（含 ${hiddenTbdCount} 项日期待定）` : ''}。在 Tempo 查看：${viewUrl}`,
    )
  }
  lines.push('')
  lines.push('Tempo 只在有任务即将到期时才发信。')
  lines.push(`退订：${unsubscribeUrl}`)
  return lines.join('\n')
}

/**
 * 组装一封提醒邮件（subject / html / text / 可行动判定）。
 *
 * 纯函数：排序 + 筛选 + 标签 + 渲染全部在这里，调用方只负责取数 + 发送。
 *
 * ### 聚焦版口径（Steven 2026-09-17 拍板）
 * 正文**只列「可行动」项**（逾期 + DUE_SOON_DAYS 天内），其余（远未来 / TBD）折叠成
 * 一行「另有 N 项更远的任务」。目标：主题的数字与正文的条数**一致**，邮件短到能一次读完。
 */
export function buildReminderEmail(input: ReminderBuildInput): ReminderBuildResult {
  const sorted = sortByDueDateAsc(input.tasks)
  const { actionable, overdueCount, dueSoonCount } = computeActionable(sorted, input.now)

  const subject = actionable
    ? `Tempo 提醒：你有 ${overdueCount + dueSoonCount} 项任务待处理`
    : 'Tempo · 你的任务一览'

  const shown = sorted.filter((t) => isActionableTask(t, input.now))
  const hiddenCount = sorted.length - shown.length
  const hiddenTbdCount = sorted.filter((t) => t.dueDate === null).length

  const rows: RenderedRow[] = shown.map((t) => {
    const due = t.dueDate === null ? { text: '日期待定', overdue: false } : dueLabel(t.dueDate, input.now)
    return {
      courseName: t.courseName,
      title: t.title,
      dueText: due.text,
      dueFormatted: t.dueDate === null ? null : formatDueDate(t.dueDate, input.timezone),
      overdue: due.overdue,
    }
  })

  const renderInput = {
    rows,
    actionable,
    overdueCount,
    dueSoonCount,
    hiddenCount,
    hiddenTbdCount,
    unsubscribeUrl: input.unsubscribeUrl,
    viewUrl: input.viewUrl,
  }

  return {
    subject,
    html: renderHtml(renderInput),
    text: renderText(renderInput),
    actionable,
    overdueCount,
    dueSoonCount,
    shownCount: shown.length,
    hiddenCount,
    hiddenTbdCount,
    totalCount: sorted.length,
  }
}
