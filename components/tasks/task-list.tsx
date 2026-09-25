'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { EXAM_SURFACE_CLASS, ExamMark } from '@/components/tasks/exam-mark'
import { courseColorClasses, courseColorKey } from '@/lib/courses/course-color'
import { isCanvasDone, isEffectivelyDone, isExamTask } from '@/lib/tasks/progress'
import { SUBMISSION_BADGE_CLASS, submissionBadge } from '@/lib/tasks/submission'
import { useI18n, useT } from '@/lib/i18n/use-i18n'
import { NOTES_UPDATED_EVENT } from '@/lib/notes/event'
import type { TaskSource, TaskStatus, TaskSubmissionState, TaskType } from '@/types/task'

/**
 * 跨课程近期任务列表（P0-1-9，PRD F5）。
 *
 * 验收标准：登录后能看到「最近 7 天所有课程要做的事」，可点击跳转到课程详情。
 *
 * ### 为什么日期是服务端格式化好的字符串
 * `dueDate` 是带时区的 ISO 串，如果在客户端用 `toLocaleDateString()` 渲染，
 * 服务端（UTC）与浏览器（用户本地时区）会渲染出不同结果 → hydration mismatch。
 * 所以日期标签与「是否逾期」都由服务端组件算好，本组件只负责显示。
 *
 * ### 已完成的处理（Steven 拍板 2026-09-03）
 * **横线划掉 + 折叠**，不是隐藏，也不是置灰混排 ——
 * 隐藏会让用户找不到"我昨天勾掉了什么"，置灰混排会让待办列表被做完的事稀释。
 *
 * ### 两轴状态别打架（P0-3-15）
 * 一条任务有**两轴**：`status`（用户手勾，只有用户能改）与 `submission_state`
 * （Canvas 同步写）。合并判定**只能有一个来源** = `isEffectivelyDone()`。
 * 本组件曾经在分组处用了它、却在渲染处写 `status === 'done'` —— 结果 Canvas 已评分的
 * 任务被归进「已完成」盒，却画出空勾选框，看起来还是待办（Steven 2026-09-17 截图抓到）。
 * **改动这里时，分组的 filter 与行内的渲染必须用同一个函数。**
 *
 * ### 三盒并排（2026-09-25 Steven）
 * 待办 / 日期待定 / 最近已完成 三个可折叠盒**并排一行**（窄屏竖排），主页不再被
 * undated 任务拉长 —— Canvas 的考试占位壳（「Unit 1 Exam · 日期待定」）成串混进
 * 待办清单，把真正有截止日的待办挤出首屏。
 * 🔴 undated 的判据 = `dueLabel === null`，与行内渲染「日期待定」**同一个来源**
 * （`formatDue()` 对 null / 坏日期都返回 null label）—— 分组若另写一份判据
 * （比如去看原始 `dueDate`），迟早与显示分叉（P0-3-15 的同款教训）。
 */

export interface TaskListItem {
  id: string
  courseId: string
  courseName: string
  title: string
  /** 服务端格式化好的日期标签；`null` = 未知日期（TBD）。 */
  dueLabel: string | null
  /** 已完成的任务不算逾期。 */
  isOverdue: boolean
  status: TaskStatus
  /**
   * 任务来源（P0-3-17）。徽标的「需手动确认」只给 **Canvas 来源** 的 null 态
   * （Canvas 明说不追踪 vs 考试派生/自建任务的 null 是两回事）——
   * 所以行数据必须带 `source`，口径收在 `submissionBadge()` 一处。
   */
  source: TaskSource
  /**
   * 任务类型（P0-3-33）。行上的「考试」标记判据是 `isExamTask(item)` —— **唯一来源**
   * 在 `lib/tasks/progress.ts`。原先这里用的是 `isDerived`，而判据应当只看 `taskType`
   * （`is_derived` 的语义是"派生的缓存"，将来出现非考试的派生任务会误判成考试，见该函数注释）。
   */
  taskType: TaskType
  /** 派生任务（考试）不可在此编辑内容，但**允许**标记完成 —— 完成状态是用户自己的。 */
  isDerived: boolean
  /** Canvas 提交态（P0-3-10）；null = 不追踪。 */
  submissionState: TaskSubmissionState | null
  /** Canvas 提交时刻（ISO）或 null。 */
  submittedAt: string | null
  /**
   * Canvas 作业页地址（P0-3-17）。有值时任务名渲染成此外链；
   * null（非 Canvas 来源 / Canvas 未给）时退回跳课程页 —— 不编一个链接出来。
   */
  canvasUrl: string | null
}

interface TaskListProps {
  items: TaskListItem[]
}

/**
 * 总览页「最近要做的事」默认直接展示的**待办**条数（P0-3-6）。
 * 超出部分收进可展开 BOX，不一股脑全抛。
 * 与「已完成折叠」语义对齐 —— 已完成项永远在下方独立折叠盒，不计入这 10 条。
 */
const OVERVIEW_VISIBLE = 10

interface TaskRowProps {
  item: TaskListItem
  busy: boolean
  onToggle: (item: TaskListItem) => void
}

/**
 * 任务行的「提交态标注」（P0-3-10，文案口径 P0-3-15 搬到共享模块）。
 *
 * 徽标 = **Canvas 真相**（六态细分：未提交 / 缺交 / 已提交 / 待查重 / 已评分 / 待确认），
 * 与勾选框**分工不同**：这里说的是"Canvas 怎么记的"，勾选框说的是"谁判定完成的"。
 * 两处各写一份 switch 迟早漂开，所以收在 `lib/tasks/submission.ts`。
 */

function TaskRow({ item, busy, onToggle }: TaskRowProps) {
  const { t, lang } = useI18n()
  const handDone = item.status === 'done'
  const canvasDone = isCanvasDone(item.submissionState)
  // 🔴 P0-3-15：完成态的判定**必须是 `isEffectivelyDone()`**，不能是 `status === 'done'`。
  // 之前这里只看 status，于是 Canvas 已判定完成的任务虽然被分进了「已完成」盒，
  // 却渲染成空勾选框 + 无删除线 —— 用户看到的是一条"待办"。
  const effectivelyDone = isEffectivelyDone(item)
  // 徽标入参是整行（P0-3-17）：`null` 的含义取决于 `source`，不能只传 state。
  const badge = submissionBadge(item)

  // 🔴 P0-3-15：Canvas 已判定完成时，勾选框**不可点**。
  // 此时 toggle 无论往哪个方向写 `status`，`isEffectivelyDone()` 都仍然为真 ——
  // 点下去任务还在「已完成」盒里、勾还在，用户只会看到"点了没反应"，
  // 又是一次静默失败（CodingRules 7）。
  // 所以画成灰色实心勾并禁用，由徽标说明"是 Canvas 判的"；
  // **用户主权只在 Canvas 没有真相时才需要表达**（on_paper / 考试 / 不追踪）。
  const canToggle = !canvasDone

  /** 勾选框的三种画法：你手勾（实心）/ Canvas 判的（灰实心，不可点）/ 还没交（空框）。 */
  const boxClass = canvasDone
    ? 'border-transparent bg-muted text-muted-foreground'
    : handDone
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border hover:border-foreground/50'

  const color = courseColorClasses(courseColorKey(item.courseId))

  /**
   * 考试行整行铺考试底（P0-3-33）。
   *
   * ⚠️ 底色与边框色**成对替换**，不是往上叠 —— 本行原本就写了 `border-border bg-card`，
   * 再叠一层 `border-lime-dark/30` 就是两个"同性质的边框色类"打架，
   * 谁生效取决于产物 CSS 里两条规则的先后（不可预期）。替换掉就不存在这个问题。
   */
  const surfaceClass = isExamTask(item)
    ? `${EXAM_SURFACE_CLASS} hover:bg-lime/20`
    : 'border-border bg-card'

  return (
    <li
      // data-task-row：音符飘行动画（P0-5-4）靠它定位"完成的那一行"——
      // 勾选后行会被 refresh 换掉，起飞点必须在 dispatch 前按 id 查。
      data-task-row={item.id}
      className={`flex items-start gap-3 rounded-lg border-l-2 px-4 py-3 ${color.edge} ${surfaceClass}`}
    >
      <button
        type="button"
        onClick={() => onToggle(item)}
        disabled={busy || !canToggle}
        aria-label={
          canToggle
            ? handDone
              ? t('task.markUndone', { title: item.title })
              : t('task.markDone', { title: item.title })
            : t('task.markCanvasDone', { title: item.title })
        }
        aria-pressed={canToggle ? handDone : undefined}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${boxClass} ${
          canToggle ? '' : 'cursor-default'
        } ${busy ? 'opacity-50' : ''}`}
      >
        {effectivelyDone ? '✓' : ''}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* 🔴 P0-3-17：点任务名 = 去源头看（Canvas 作业页），与"点勾切换完成"是两个动作。
              Canvas 有 `html_url` 时用外链；没有（考试派生 / 手动任务 / Canvas 未给）
              则退回原来的"进课程详情页"—— 绝不把一个跳不到的地方画成链接。

              课程页入口因此从"标题"挪到右侧的**课程名**上（见下），
              否则 Canvas 来源的任务在总览页就再也没有进课程页的路。 */}
          {item.canvasUrl ? (
            <a
              href={item.canvasUrl}
              target="_blank"
              rel="noreferrer"
              title={t('common.openInCanvas', { title: item.title })}
              className={`truncate text-sm font-medium underline-offset-4 hover:underline ${
                effectivelyDone ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}
            >
              {item.title}
            </a>
          ) : (
            <Link
              href={`/courses/${item.courseId}`}
              className={`truncate text-sm font-medium underline-offset-4 hover:underline ${
                effectivelyDone ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}
            >
              {item.title}
            </Link>
          )}
          <Link
            href={`/courses/${item.courseId}`}
            title={t('common.viewCourseDetail', { course: item.courseName })}
            className={`inline-flex shrink-0 items-center rounded-badge px-1.5 py-0.5 text-xs underline-offset-4 hover:underline ${color.chip}`}
          >
            {/* 课程色（P0-3-33）：从一颗 2.5px 圆点升级成"浅底 + 同色文字"的 chip ——
                圆点太小看不出区别（Steven 2026-09-20：「单单一颗很小的颜色亮点不足以区分」）。
                同 courseId 永远同色，与课程卡、周历、今日任务一致；
                色值走主题令牌（`lib/courses/course-color.ts` 的静态类名表），随主题切换。 */}
            {item.courseName}
          </Link>
          {/* 提交态徽标：每个任务名后都有（Canvas 不追踪时 `submissionBadge()` 返回 null，不标）。 */}
          {badge ? (
            <span
              className={`shrink-0 text-xs ${SUBMISSION_BADGE_CLASS[badge.tone]}`}
              title={badge.title}
            >
              {badge.label}
            </span>
          ) : null}
          {/* 考试标记（P0-3-33）：原先是一段 12px 的灰字「考试」，与"提交态徽标"混在一起
              分不出谁是谁；现在换成带底色边框与图标的徽标，与周历 / 今日任务 / 课程页同一套。
              判据 `isExamTask(item)` = `taskType === 'exam'`，唯一来源见 `lib/tasks/progress.ts`。 */}
          {isExamTask(item) ? <ExamMark lang={lang} /> : null}
        </div>
        <p className={`mt-0.5 text-xs ${item.isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>
          {item.dueLabel ?? t('common.dateTbd')}
          {/* 「缺交」已由徽标表达，日期行不再重复一遍（P0-3-15）。 */}
          {item.isOverdue ? t('common.overdueTag') : ''}
        </p>
      </div>
    </li>
  )
}

/**
 * 并排三盒共用的折叠盒（2026-09-25 Steven：主页太长 → 三盒一排、各自可折叠）。
 * 样式沿用原「最近已完成」折叠盒的视觉语言（`bg-card/40` + ▸/▾），不引入新花样。
 */
function CollapsibleBox({
  label,
  defaultOpen = false,
  note,
  children,
}: {
  /** 盒头文案（计数由调用方拼进文案，i18n 键自带 {n}）。 */
  label: string
  defaultOpen?: boolean
  /** 展开后内容顶部的一行说明（如 undated 盒的口径）。 */
  note?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-lg border border-border bg-card/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground"
      >
        <span className="text-xs">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open ? (
        <div className="px-4 pb-3">
          {note ? <p className="mb-2 text-xs text-muted-foreground">{note}</p> : null}
          {children}
        </div>
      ) : null}
    </section>
  )
}

export function TaskList({ items }: TaskListProps) {
  const router = useRouter()
  const t = useT()
  // 三个盒的展开态由 `CollapsibleBox` 各自持有（默认：待办展开、日期待定 / 最近已完成收起）——
  // 收起时只占一行盒头，这正是"主页不显得这么长"的来源（2026-09-25 Steven）。
  const [isMoreExpanded, setIsMoreExpanded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 服务端已按 dueDate 升序排好（null 排最后），这里只做分组，不打乱顺序。
  // P0-3-10 合并规则：status='done' **或** `isCanvasDone()` → 归入「已完成」区；
  // 其余（含 external_unconfirmed / missing / 未交）留在待办。
  //
  // P0-3-7 起判定提到 `lib/tasks/progress.ts` 的 `isEffectivelyDone()` ——
  // 周历要用**完全相同**的规则过滤，两处各写一份迟早会只改一处。
  // 🔴 P0-3-15：`TaskRow` 内部也必须用它（曾经用了 `status === 'done'`，见文件头注释）。
  const pending = items.filter((item) => !isEffectivelyDone(item))
  const done = items.filter((item) => isEffectivelyDone(item))

  // 三盒分组（2026-09-25）：**先**按完成与否切（做完的事进「已完成」，不再参与分类），
  // **再**把待办按有无日期切成 dated / undated —— undated 的判据与行内渲染同源，
  // 见文件头「三盒并排」一节。
  const datedPending = pending.filter((item) => item.dueLabel !== null)
  const undatedPending = pending.filter((item) => item.dueLabel === null)

  // P0-3-6：最近 OVERVIEW_VISIBLE 条待办直接列出，其余收进可展开 BOX。
  // 注意：这是**展示层**截断，数据已在服务端全部取回（dashboard 的 OVERVIEW_LIMIT 只是 DB 安全上限），
  // 所以「还有 N 条」展开后能看到全部，不会静默消失。
  // 2026-09-25 起截断只作用于 dated 待办 —— undated 已整体搬去自己的盒。
  const visiblePending = datedPending.slice(0, OVERVIEW_VISIBLE)
  const hiddenPending = datedPending.slice(OVERVIEW_VISIBLE)

  const renderRow = (item: TaskListItem) => (
    <TaskRow
      key={item.id}
      item={item}
      busy={busyId === item.id}
      onToggle={(target) => void handleToggle(target)}
    />
  )

  async function handleToggle(item: TaskListItem) {
    setError(null)
    setBusyId(item.id)
    // 记入与彩带只在「标记完成」这个方向上发生 —— 取消勾选不扣音符
    // （倒扣就是惩罚，ADR-016 R5 明确禁止惩罚性机制）。
    const markingDone = item.status !== 'done'
    try {
      const response = await fetch(`/api/v1/tasks/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: item.status === 'done' ? 'pending' : 'done' }),
      })

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : t('common.actionFailed', { status: response.status }))
        return
      }

      // 音符 + 彩带（P0-5-4）：**记入在服务端做**（PATCH 里，幂等），
      // 这里只广播"刚完成了一件" —— 计数重新取数、彩带层放一次、
      // 飘行层从这一行的位置起飞一枚 ♪（ Steven 2026-09-24 验收反馈）。
      // 刻意不等任何响应：彩带是被动回声，不该让它反过来拖慢勾选。
      if (markingDone) {
        // 起飞点 = 完成那一行的中心（视口坐标）。行可能已被 refresh 换掉，
        // 所以必须在 dispatch 前读 —— 晚一拍就读不到了。
        const row = document.querySelector(`[data-task-row="${item.id}"]`)
        const box = row?.getBoundingClientRect()
        window.dispatchEvent(
          new CustomEvent(NOTES_UPDATED_EVENT, {
            detail: {
              title: item.title,
              count: 1,
              origin:
                box && box.width > 0
                  ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
                  : null,
            },
          }),
        )
      }

      // 数据由服务端组件持有，刷新即回到最新状态。
      // 不做乐观更新 —— 本地先改、服务端没改成，会让用户以为"勾掉了"其实没有，
      // 这类静默不一致正是 Tempo 最不能犯的错（CodingRules 7）。
      router.refresh()
    } catch {
      setError(t('common.networkError'))
    } finally {
      setBusyId(null)
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">{t('task.empty')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* 三盒并排（窄屏自动竖排）：待办 / 日期待定 / 最近已完成。 */}
      <div className="grid gap-3 lg:grid-cols-3 lg:items-start">
        {/* ① 待办（默认展开）：只收**有截止日期**的待办 —— 倒计时里的事。 */}
        <CollapsibleBox label={t('task.boxTodo', { n: datedPending.length })} defaultOpen>
          {datedPending.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">
              {done.length > 0 ? t('task.allDone') : t('task.empty')}
            </p>
          ) : (
            <>
              <ul className="space-y-2">{visiblePending.map(renderRow)}</ul>
              {hiddenPending.length > 0 ? (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setIsMoreExpanded(!isMoreExpanded)}
                    className="text-left text-xs text-muted-foreground hover:text-foreground"
                  >
                    <span className="mr-1">{isMoreExpanded ? '▾' : '▸'}</span>
                    {t('task.morePending', { n: hiddenPending.length })}
                  </button>
                  {isMoreExpanded ? (
                    <ul className="mt-2 space-y-2">
                      {hiddenPending.map(renderRow)}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </CollapsibleBox>

        {/* ② 日期待定（默认收起）：undated 的统一去处 —— Canvas 没填日期的作业、
            考试占位壳、没定日子的手动任务都收在这里，不再混进待办清单。
            空盒不渲染：一行「日期待定 · 0」是噪音。 */}
        {undatedPending.length > 0 ? (
          <CollapsibleBox
            label={t('task.boxUndated', { n: undatedPending.length })}
            note={t('task.boxUndatedNote')}
          >
            <ul className="space-y-2">{undatedPending.map(renderRow)}</ul>
          </CollapsibleBox>
        ) : null}

        {/* ③ 最近已完成（默认收起）：语义不变（P0-3-35 的「最近」口径），只是搬进并排盒。 */}
        {done.length > 0 ? (
          <CollapsibleBox label={t('task.recentDone', { n: done.length })}>
            <ul className="space-y-2">{done.map(renderRow)}</ul>
          </CollapsibleBox>
        ) : null}
      </div>
    </div>
  )
}
