import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { DemoControls } from '@/components/courses/demo-controls'
import { OnboardingCards } from '@/components/onboarding/onboarding-cards'
import { TodayTasks } from '@/components/overview/today-tasks'
import { WeekCalendar } from '@/components/overview/week-calendar'
import { SyncControls } from '@/components/sync/sync-controls'
import { SyncStatusBar } from '@/components/sync/sync-status-bar'
import { TokenExpiryBanner } from '@/components/sync/token-expiry-banner'
import { toCredentialExpiryView } from '@/lib/sync/expiry'
import { TaskList } from '@/components/tasks/task-list'
import type { TaskListItem } from '@/components/tasks/task-list'
import { AppShell } from '@/components/shell/app-shell'
import { signOut } from '@/lib/auth/actions'
import { loadCredentialMeta } from '@/lib/canvas/credentials'
import type { CanvasCredentialMeta } from '@/types/canvas'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { assignCourseColorKeys } from '@/lib/courses/course-color'
import { dropCanvasExamPlaceholders, loadTasks, loadUpcomingExams } from '@/lib/tasks'
import { awardNotesForDone } from '@/lib/notes/store'
import { NoteCatchup } from '@/components/notes/note-catchup'
import { formatDue } from '@/lib/tasks/format'
import { buildTodayTasks } from '@/lib/tasks/today'
import {
  buildUpcomingExams,
  buildWeekCalendar,
  canBeOverdue,
  EXAM_LOOKAHEAD,
} from '@/lib/tasks/progress'
import { createClient } from '@/lib/supabase/server'
import { hasSeenOnboarding, ONBOARDING_COOKIE } from '@/lib/onboarding/content'
import { getLang } from '@/lib/i18n/server'
import { t } from '@/lib/i18n/translate'
import {
  recordUsageEvent,
  recordUsageEventOncePerUtcDay,
} from '@/lib/usage-events'
import {
  summarizeSyncStatus,
  toCourseSyncView,
} from '@/lib/sync/status'
import { addDays, dayKeyToUtcDate, schoolDayKey } from '@/lib/time'
import type { Task } from '@/types/task'

export async function generateMetadata() {
  const lang = await getLang()
  return { title: t(lang, 'dashboard.meta') }
}

/** 总览页任务窗口（天）。与 `GET /api/v1/tasks` 的默认 range 一致。 */
const OVERVIEW_RANGE_DAYS = 7
/**
 * 总览页任务查询的 DB 安全上限 —— 只是"最多取回多少条"，**不是展示条数**。
 * 展示层收敛（最近 10 条待办 + 溢出收进 BOX）在 `TaskList` 里做（P0-3-6 的 `OVERVIEW_VISIBLE`），
 * 这里必须取回足够数据，BOX 展开后才能看到全部，不会静默消失。
 *
 * 🔴 P0-3-35：从 50 提到 200。50 当初的假设是"任务量几十条，50 宽裕"，
 * 但那是**没排除已完成历史**时的判断 —— 一学期的已交作业就能把 50 吃光
 * （实测 50 条里 35 条是历史，未来任务**一条都没取回**）。
 * 排掉历史后窗口里只剩「逾期未完成 + 最近 7 天已完成 + 未来 7 天」，
 * 但重度周（一门课一周七八个作业 × 五六门课）仍可能过百，
 * 而真正兜底的是 `OVERVIEW_HISTORY_DAYS`（排除历史），**不该让上限再当第二道铡刀**。
 * 200 对一次 SELECT 无压力，换来的是"未来任务被切掉"这类静默 bug 不再复发。
 */
const OVERVIEW_LIMIT = 200

/**
 * 已完成任务的**历史下界**（天）—— 只用来给已完成的历史"让位"，不影响未完成。
 *
 * ### 为什么必须有这个数（P0-3-35 修的就是它被漏掉）
 * 任务查询的时间过滤原先**只有上界**（due ≤ 今天 + 7 天），排序又是 due 升序 ——
 * 于是"最早的排最前"。一学期积下来的几十条**已交作业**整队占满前 50 位，
 * 把真正要看的未来任务挤出结果集：2026-09-21 实测，Steven 的 49 条已交作业吃光名额，
 * 9/23~9/29 到期的作业排在 51 位之后根本没取回 → 周历与待办清单全空（同步其实是好的）。
 *
 * 7 天与前视窗口对称，且满足 Steven 最初的诉求「隐藏会让用户找不到我昨天勾掉了什么」——
 * 近期完成的仍在下方折叠盒里。更早的属于**课程页**，不该占总览页有限的行数。
 *
 * 🔴 **逾期未完成的任务不受这个下界约束**（`loadTasks` 里只对已完成的行设下界）：
 * 给它们设下界等于帮用户逃避，与 Tempo「不隐藏问题」冲突。
 */
const OVERVIEW_HISTORY_DAYS = 7

/**
 * 「最近的考试」从数据库最多取回几条**候选**（不是展示条数，展示只取 3 条）。
 *
 * 取一批再在纯函数里筛掉已完成的、切前 3 —— 若 SQL 直接 `.limit(3)`，
 * 取回的三条可能恰好都被用户勾完了，条上就白白显示为空（而后面还有没完成的考试）。
 * 考试数量天生很少（一门课一学期 3-5 场），50 是宽裕上限。
 */
const EXAM_POOL = 50

// 日期标签与课程卡视图模型已搬到共享模块（**故意不在这里留副本**）：
//   `formatDue` → lib/tasks/format.ts
//   `toUpcomingViews` / `groupBySemester` / `loadLatestSyllabi` → lib/courses/course-list.ts
//
// P0-3-7b 把课程卡整体搬去 `/courses`，但"日期口径"与"是否算完成"两个页面必须一致 ——
// 各留一份副本，迟早出现"同一条任务在两个页面显示不同日期"。**改那两处 = 两个页面同时改。**

function toListItems(tasks: Task[], now: Date, lang: 'zh' | 'en'): TaskListItem[] {
  return tasks.map((task) => {
    const { label, isOverdue } = formatDue(task.dueDate, now, lang)
    return {
      id: task.id,
      courseId: task.courseId,
      courseName: task.courseName,
      title: task.title,
      dueLabel: label,
      // 🔴 P0-3-17：「能不能标逾期」收在 `canBeOverdue()` **一处** ——
      // 它同时排掉"用户已手勾 / Canvas 已判定完成 / 外部平台无可信记录（ADR-013）/
      // Canvas 明说不追踪完成态"四类（判据与理由见 `lib/tasks/progress.ts`）。
      // 原先这里散着写 `!isCanvasDone(...) && state !== 'external_unconfirmed'`，
      // 而周历、课程卡各写了另一份 —— 三份判据必然会漂开（P0-3-16 就留下过
      // 「周历说逾期、今日任务说没事」的矛盾）。
      isOverdue: isOverdue && canBeOverdue(task),
      status: task.status,
      source: task.source,
      // P0-3-33：清单行的「考试」标记判据收在 `isExamTask(task)`（看 `taskType`）——
      // 所以这里必须把 `taskType` 传下去，让组件直接用那一个判据。
      taskType: task.taskType,
      isDerived: task.isDerived,
      submissionState: task.submissionState,
      submittedAt: task.submittedAt,
      canvasUrl: task.canvasUrl,
    }
  })
}

// 依赖用户 session，绝不能被静态预渲染。
// 虽然 createClient() 里的 cookies() 已能让 Next 识别为动态路由，
// 但这里显式声明，避免将来有人调整调用顺序时又退化成静态页。
export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  /**
   * Next 16：`searchParams` 是 Promise，必须 await。
   * 目前只认一个参数 —— `?tutorial=1`（从「重看新手教程」入口进来，P0-3-32）；
   * 其余参数一律忽略。
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()
  const lang = await getLang()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware，Next 16 更名）已经拦过一道，这里再兜一次底：
  // 既防 proxy 被人绕过，也让 TS 知道 user 一定存在。
  if (!user) {
    redirect('/login')
  }

  // 埋点：打开总览页（P0-3-1 —— 7 日回访次数的分子）。
  // 「打开」= 服务端渲染一次页面，包括同步成功后的 router.refresh()：刷一次算一次。
  // 写失败不影响页面（函数内部只告警），埋点是度量不是功能。
  await recordUsageEvent(supabase, user.id, 'dashboard_view')

  /**
   * 新手引导（P0-3-32）的显隐判定。
   *
   * - `replay`：从侧栏/设置页的「重看新手教程」进来（`/dashboard?tutorial=1`）——
   *   看过也要再放一遍，这是那个入口存在的全部意义。
   * - 否则读 **cookie**（不是 localStorage）：服务端读得到，引导卡就能进**首屏 HTML**，
   *   不必等客户端 JS 挂载后再补（那样会闪一下）。
   *
   * 🔴 判据是「cookie 值 === 当前用户 id」而不是「cookie 存在」——
   * 同一台电脑上换个账号登录，标记对不上，引导照常出现（卡面要求「每用户」）。
   * 🔴 绝不在注册流程里预先写上这个标记：那是「新注册即见」的假标记，
   * 会让引导对所有人永久消失（卡面约束 ④）。
   */
  const { tutorial } = await searchParams
  const replay = tutorial === '1'
  const cookieStore = await cookies()
  const onboardingOpen =
    replay || !hasSeenOnboarding(cookieStore.get(ONBOARDING_COOKIE)?.value, user.id)

  const { data, error } = await supabase
    .from('courses')
    .select(COURSE_COLUMNS)
    .eq('is_archived', false)
    .order('created_at', { ascending: true })

  // 查询失败必须让用户看见，不能因为 error 分支返回空数组就渲染成"还没有课程"。
  // 静默的旧数据/空数据比明确的错误更危险（CodingRules 7、PRD F4 失败可见性）。
  const courses = data ? (data as CourseRow[]).map(toCourse) : []
  /**
   * 课程色分配表（2026-09-25 撞色修复）：从**全量非归档课程**算一次，三个任务视图共用 ——
   * `/courses` 页也用同一口径算，同一门课跨页面同色。必须传全量：传子集会让
   * 同一门课在不同页面拿到不同颜色（见 `assignCourseColorKeys()` 注释）。
   */
  const courseColorKeys = assignCourseColorKeys(courses.map((course) => course.id))
  const email = user.email ?? t(lang, 'dashboard.emailMissing')
  /** 是否已有示例课程（决定展示「先看看效果」入口还是「清空示例数据」）。 */
  const hasDemo = courses.some((course) => course.isDemo)
  /**
   * 是否至少关联了一门 Canvas 课程 —— 同步控件（T1 自动同步 / T2 手动按钮）的开关。
   * 没关联过的用户同步注定空跑，不渲染按钮也不发自动请求（P0-2-6）。
   */
  const hasCanvasLink = courses.some((course) => course.canvasCourseId !== null)

  /**
   * 凭据状态（P0-2-7 失败分级 + P0-2-8 过期提醒共用）。
   *
   * P0-2-7 原本只在「有关联课」时才查，避免给没连 Canvas 的用户付一次无用查询。
   * P0-2-8 的过期提醒需要在**有凭据但还没关联课**时也显示 —— 所以改成：登录用户
   * 一律查一次（单行 `eq('user_id')`，成本可忽略），凭据不存在就是 null。
   *
   * 三态：可用 / 不可用 / 未知（查询失败）。查询失败时**不当成"没有凭据"** ——
   * 那会把失败误判成「需要重新连接」，给连着好 token 的用户派错活；
   * "未知"按暂时性故障处理，并显式报错（见下方 credentialError 分支）。
   */
  let credential: CanvasCredentialMeta | null = null
  let credentialUsable: boolean | null = null
  let credentialError: string | null = null
  // `now` 先算好，下面过期提醒（P0-2-8）要注入，避免与客户端各算一遍导致 hydration mismatch。
  const now = new Date()
  try {
    credential = await loadCredentialMeta(supabase, user.id)
    credentialUsable = credential !== null && credential.status === 'active'
  } catch (cause) {
    credentialError = cause instanceof Error ? cause.message : String(cause)
  }

  /**
   * 过期提醒（P0-2-8）：服务端现算，不轮询、不建端点（沿用 P0-2-7 决策）。
   * 凭据不存在 → null（不渲染）；`status === 'error'` 时 `toCredentialExpiryView`
   * 内部返回 null，让 P0-2-7 的失败横幅独占"连接坏了"的提示。
   */
  const expiryView =
    credential === null
      ? null
      : toCredentialExpiryView(credential.expiresAt, credential.status, now, lang)

  // 埋点：过期横幅**真的展示给了用户**（P0-3-1 —— token 续期完成率的分母）。
  // 条件是横幅会出现（`level !== 'ok'`），而不是"用户点进了重连页" ——
  // 我们要量的是"提醒这个摩擦有没有促成续期"，看见提醒就算被触达。
  // 同一 UTC 日只记一次：分母按人算，同一天记五次只会把表撑大。
  if (expiryView !== null && expiryView.level !== 'ok') {
    await recordUsageEventOncePerUtcDay(supabase, user.id, 'expiry_reminder_shown', now)
  }

  /**
   * 重连入口：链到第一门关联课的详情页（那里有「Canvas 关联」区块，点「更改」→
   * 内嵌连接表单）。没有关联课则退而求其次链到第一门课详情页（任意课详情页都有连接入口）；
   * 连课都没有 → null（横幅只提示、不给按钮）。
   */
  const firstLinkedCourse = courses.find((course) => course.canvasCourseId !== null)
  const reconnectCourse = firstLinkedCourse ?? courses[0]
  const reconnectHref = reconnectCourse ? `/courses/${reconnectCourse.id}` : null

  // 两份任务数据互不依赖，并行发。课程 id 沿用上面已查到的未归档课程，不重复查。
  //
  // ① 总览清单（`overview.tasks`，同时喂周历与「今日任务」）/ ② 最近的考试池。
  // ② 单独取是因为考试常落在 7 天窗口之外，① 的窗口装不下。
  //
  // P0-3-7b：原第 ④ 路「卡片近期任务」（`loadUpcomingTasks`）随课程卡搬去 `/courses`；
  // P0-3-16：原第 ② 路「债务条」（`loadDebtTasks`）删除 ——「今日任务」直接复用 ①
  // （窗口 = now + 7d，正好含「逾期 + 今天 + 未来 7 天」），这一页从四路查询降到两路。
  const courseIds = courses.map((course) => course.id)
  const [overview, examPool] = await Promise.all([
    loadTasks(supabase, {
      courseIds,
      until: new Date(now.getTime() + OVERVIEW_RANGE_DAYS * 86_400_000).toISOString(),
      // 按**学校日历日**回退（不是 24h×7 的毫秒减法）：与 `buildWeekCalendar` 同一套
      // 日键口径，夏令时切换时不会差一天。
      historySince: dayKeyToUtcDate(addDays(schoolDayKey(now), -OVERVIEW_HISTORY_DAYS)).toISOString(),
      limit: OVERVIEW_LIMIT,
      offset: 0,
    }),
    loadUpcomingExams(supabase, { courseIds, since: now.toISOString(), pool: EXAM_POOL }),
  ])
  const tasksError = overview.error

  // 口径与可视化模型都在纯函数层算（`lib/tasks/*`），这里只做接线。
  //
  // 🔴 `dropCanvasExamPlaceholders` 必须在**三处消费之前**过一遍（今日 / 周历 / 清单）：
  // 老师常在 Canvas 里建「Unit 1 Exam」这种**不填截止日的空壳作业**，
  // 不过滤的话同一场考试在页面上是两条（P0-3-36）。
  const visibleTasks = dropCanvasExamPlaceholders(overview.tasks)
  const today = buildTodayTasks(visibleTasks, now, OVERVIEW_RANGE_DAYS, lang)

  /**
   * 音符懒补（P0-5-4）——**记入点之二**：Canvas 代判完成的那部分。
   *
   * ### 为什么不写在同步管道里
   * 同步每轮都跑（打开应用即触发），在那里记等于把"每轮同步"变成"每轮写音符表"；
   * 更关键的是 `ADR-015`：同步路径只写外部真相，不写属于用户这一侧的东西。
   * 而 Steven 2026-09-24 拍板的是「Canvas 代判完成**也给**音符，但零操作」——
   * 所以放在**读**这一侧：打开总览页时按当前可见的完成态补记，用户什么都不用做。
   *
   * ### 幂等
   * `awardNotesForDone()` 只补还没记过的（主键 `(user_id, task_id)` 是最后一关），
   * 所以这一行每渲染一次就跑一次是安全的 —— 第二次往后全是零写入。
   *
   * ### 失败不影响页面
   * 音符是"回声"不是功能：查不动就让顶栏那一行不显示（端点也会如实报 500），
   * 绝不能让记入失败把整个总览页打挂。但必须留日志（CodingRules 7：不吞异常）。
   *
   * ### `notesAwarded` 要传给客户端（2026-09-24 验收反馈）
   * 记入在服务端，彩带 / 飘行层在客户端 —— 新记入几枚要经
   * `<NoteCatchup>`（挂载后广播同一个事件）带回，自动检测到的完成才有反馈。
   * 手勾路径不会双响：PATCH 已当场记入，refresh 后这里的 awarded 是 0。
   */
  let notesAwarded = 0
  try {
    const notes = await awardNotesForDone(supabase, user.id, visibleTasks)
    if (notes.error) {
      console.error('[notes] 懒补失败', notes.error)
    } else {
      notesAwarded = notes.awarded
    }
  } catch (cause) {
    console.error('[notes] 懒补失败', cause instanceof Error ? cause.message : cause)
  }
  const calendar = buildWeekCalendar(visibleTasks, now, lang)
  const exams = buildUpcomingExams(examPool.tasks, now, EXAM_LOOKAHEAD, lang)

  // 同步状态视图：只算**已关联 Canvas** 的课（未关联的课没有"同步"这回事）。
  const syncViews = courses
    .filter((course) => course.canvasCourseId !== null)
    .map((course) => toCourseSyncView(course, { credentialUsable: credentialUsable === true }))
  const syncOverview = summarizeSyncStatus(syncViews, now)

  return (
    <AppShell title={t(lang, 'nav.dashboard')}>
      {/* 懒补回声（P0-5-4）：服务端新记入的枚数带回客户端，彩带 / 飘行才有得放。 */}
      <NoteCatchup awarded={notesAwarded} />
      <div className="mx-auto max-w-[1100px] space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t(lang, 'dashboard.heading')}</h1>
            <p className="mt-2 text-sm text-ink-muted">
              {t(lang, 'dashboard.subtitle')}
            </p>
          </div>
          <SyncControls hasCanvasLink={hasCanvasLink} />
        </div>

        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-ink-muted">{email}</span>
          {hasDemo ? <DemoControls hasDemo={hasDemo} variant="inline" /> : null}
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              {t(lang, 'common.signOut')}
            </Button>
          </form>
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">{t(lang, 'courses.loadFailed')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
          </div>
        ) : null}

        {tasksError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">{t(lang, 'courses.tasksLoadFailed')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(lang, 'dashboard.tasksLoadFailedHint', { error: tasksError })}
            </p>
          </div>
        ) : null}

        {credentialError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">{t(lang, 'courses.canvasLoadFailed')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(lang, 'dashboard.canvasLoadFailedHint', { error: credentialError })}
            </p>
          </div>
        ) : null}

        <TokenExpiryBanner view={expiryView} reconnectHref={reconnectHref} />

        <SyncStatusBar overview={syncOverview} now={now} lang={lang} />

        {/* 新手引导（P0-3-32）。**内联**在页面流里，不是覆盖层 —— 空态下紧跟着的
            就是 Demo Workspace 的「✨ 先看看效果」，两者同屏可见，谁也不挤掉谁（卡面约束 ③）。
            `key` 随 `replay` 变化 → 从侧栏点「重看新手教程」时组件重挂载，
            上一轮点过「跳过」留下的本地收起状态被重置（React 官方「用 key 重置状态」）。
            服务端已经用 cookie 判过一遍，故这里只需要透传判定结果。 */}
        <OnboardingCards
          key={replay ? 'replay' : 'auto'}
          userId={user.id}
          // 站内那一步链到第一门课（关联过就链关联的那门）；一门课都没有 → 课程列表页。
          connectHref={reconnectHref ?? '/courses'}
          initialOpen={onboardingOpen}
          replay={replay}
        />

        {/* 「今日任务」的取数与周历/清单同源（`overview.tasks`）—— 取数失败时**藏起卡片**，
            而不是显示成"今天没有任务"（一个空的卡会被读成"今天没事"，正是静默的错误数据，
            CodingRules 7；上方已有一条「任务列表加载失败」的横幅说明原因）。 */}
        {!error && courses.length > 0 && !tasksError ? (
          <TodayTasks model={today} lang={lang} colorKeys={courseColorKeys} />
        ) : null}

        {!error && courses.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">{t(lang, 'dashboard.weekHeading')}</h2>
              <p className="text-xs text-muted-foreground">{t(lang, 'dashboard.weekNote')}</p>
            </div>
            <WeekCalendar model={calendar} exams={exams} lang={lang} colorKeys={courseColorKeys} />
            {/* 考试查询失败时**明说** —— 否则日历会静静地少一条「最近的考试」，
                用户只会以为"我最近没考试"（CodingRules 7：空数据比错误数据更危险）。 */}
            {examPool.error ? (
              <p role="alert" className="text-xs text-destructive">
                {t(lang, 'dashboard.examsLoadFailed', { error: examPool.error })}
              </p>
            ) : null}
            {overview.total > overview.tasks.length ? (
              // P0-3-35：文案改成如实描述 —— 原话是「其余在下方清单里」，但超出上限的行
              // 既不在日历里、也不在清单里（清单用的就是同一批取回的数据），
              // 那句话会让用户以为没丢。窗口内共多少条、用了多少条，两个数都给出来。
              <p className="text-xs text-ink-faint">
                {t(lang, 'dashboard.windowNote', { total: overview.total, n: overview.tasks.length })}
              </p>
            ) : null}
          </section>
        ) : null}

        {!error && courses.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">{t(lang, 'dashboard.todoHeading')}</h2>
              <p className="text-xs text-muted-foreground">
                {t(lang, 'dashboard.todoNote', {
                  days: OVERVIEW_RANGE_DAYS,
                  history: OVERVIEW_HISTORY_DAYS,
                })}
              </p>
            </div>
            <TaskList items={toListItems(visibleTasks, now, lang)} colorKeys={courseColorKeys} />
          </section>
        ) : null}

        {!error && courses.length === 0 ? (
          <DemoControls hasDemo={hasDemo} variant="cta" />
        ) : null}

        {/* 课程卡（按学期分组的 13 张）已搬到 `/courses`（P0-3-7b）—— 这一页只回答
            「接下来要做什么」。卡片的数据构造在 `lib/courses/course-list.ts`，
            与课程列表页**共用同一份**，不要在这里重新实现。 */}
      </div>
    </AppShell>
  )
}
