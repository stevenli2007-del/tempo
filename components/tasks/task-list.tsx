'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { courseColorVar, courseColorKey } from '@/lib/courses/course-color'
import { isEffectivelyDone } from '@/lib/tasks/progress'
import type { TaskStatus, TaskSubmissionState } from '@/types/task'

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
  /** 派生任务（考试）不可在此编辑内容，但**允许**标记完成 —— 完成状态是用户自己的。 */
  isDerived: boolean
  /** Canvas 提交态（P0-3-10）；null = 不追踪。 */
  submissionState: TaskSubmissionState | null
  /** Canvas 提交时刻（ISO）或 null。 */
  submittedAt: string | null
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
 * 任务行的「提交态标注」（P0-3-10）。
 * 用户已手勾（status=done）时不另标 —— 用户主权优先。
 * - submitted / graded / pending_review → 「已提交（Canvas）」（positive）
 * - external_unconfirmed → 「待确认（外部平台提交）」（neutral，绝不写"待完成"诬告用户）
 */
function submissionNote(
  item: TaskListItem,
): { label: string; tone: 'positive' | 'neutral' } | null {
  if (item.status === 'done') return null
  switch (item.submissionState) {
    case 'submitted':
    case 'graded':
    case 'pending_review':
      return { label: '已提交（Canvas）', tone: 'positive' }
    case 'external_unconfirmed':
      return { label: '待确认（外部平台提交）', tone: 'neutral' }
    default:
      return null
  }
}

function TaskRow({ item, busy, onToggle }: TaskRowProps) {
  const isDone = item.status === 'done'
  const note = submissionNote(item)

  // 逾期文案：Canvas 标记缺交（missing）区别于普通"逾期未完成"。
  const overdueText = item.isOverdue
    ? item.submissionState === 'missing'
      ? '（逾期未交）'
      : '（已逾期）'
    : ''

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <button
        type="button"
        onClick={() => onToggle(item)}
        disabled={busy}
        aria-label={isDone ? `将「${item.title}」标记为未完成` : `将「${item.title}」标记为已完成`}
        aria-pressed={isDone}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs disabled:opacity-50 ${
          isDone
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border hover:border-foreground/50'
        }`}
      >
        {isDone ? '✓' : ''}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link
            href={`/courses/${item.courseId}`}
            className={`truncate text-sm font-medium underline-offset-4 hover:underline ${
              isDone ? 'text-muted-foreground line-through' : 'text-foreground'
            }`}
          >
            {item.title}
          </Link>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {/* 课程色点（P0-3-6 配套）：同 courseId 永远同色，与课程卡一致，
                一眼区分任务归属；色值随主题切换。 */}
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: courseColorVar(courseColorKey(item.courseId)) }}
              aria-hidden
            />
            {item.courseName}
          </span>
          {note ? (
            <span
              className={`shrink-0 text-xs ${
                note.tone === 'positive' ? 'text-primary/80' : 'text-muted-foreground/70'
              }`}
            >
              {note.label}
            </span>
          ) : null}
          {item.isDerived ? (
            <span className="shrink-0 text-xs text-muted-foreground/70">考试</span>
          ) : null}
        </div>
        <p className={`mt-0.5 text-xs ${item.isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>
          {item.dueLabel ?? '日期待定'}
          {overdueText}
        </p>
      </div>
    </li>
  )
}

export function TaskList({ items }: TaskListProps) {
  const router = useRouter()
  const [isDoneExpanded, setIsDoneExpanded] = useState(false)
  const [isMoreExpanded, setIsMoreExpanded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 服务端已按 dueDate 升序排好（null 排最后），这里只做分组，不打乱顺序。
  // P0-3-10 合并规则：status='done' **或** Canvas 已判定完成（submitted/graded/pending_review）
  // → 归入「已完成」区；其余（含 external_unconfirmed / missing / 未交）留在待办。
  //
  // P0-3-7 起判定提到 `lib/tasks/progress.ts` 的 `isEffectivelyDone()` ——
  // 周历要用**完全相同**的规则过滤，两处各写一份迟早会只改一处。
  const pending = items.filter((item) => !isEffectivelyDone(item))
  const done = items.filter((item) => isEffectivelyDone(item))

  // P0-3-6：最近 OVERVIEW_VISIBLE 条待办直接列出，其余收进可展开 BOX。
  // 注意：这是**展示层**截断，数据已在服务端全部取回（dashboard 的 OVERVIEW_LIMIT 只是 DB 安全上限），
  // 所以「还有 N 条」展开后能看到全部，不会静默消失。
  const visiblePending = pending.slice(0, OVERVIEW_VISIBLE)
  const hiddenPending = pending.slice(OVERVIEW_VISIBLE)

  async function handleToggle(item: TaskListItem) {
    setError(null)
    setBusyId(item.id)
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
        setError(typeof message === 'string' ? message : `操作失败（HTTP ${response.status}）`)
        return
      }

      // 数据由服务端组件持有，刷新即回到最新状态。
      // 不做乐观更新 —— 本地先改、服务端没改成，会让用户以为"勾掉了"其实没有，
      // 这类静默不一致正是 Tempo 最不能犯的错（CodingRules 7）。
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setBusyId(null)
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">
          最近没有要做的事。上传 syllabus 后，Tempo 会把考试日期自动放进这里。
        </p>
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

      <ul className="space-y-2">
        {visiblePending.map((item) => (
          <TaskRow
            key={item.id}
            item={item}
            busy={busyId === item.id}
            onToggle={(target) => void handleToggle(target)}
          />
        ))}
      </ul>

      {hiddenPending.length > 0 ? (
        <div className="rounded-lg border border-border bg-card/40">
          <button
            type="button"
            onClick={() => setIsMoreExpanded(!isMoreExpanded)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground"
          >
            <span className="text-xs">{isMoreExpanded ? '▾' : '▸'}</span>
            还有 {hiddenPending.length} 条待办
          </button>
          {isMoreExpanded ? (
            <ul className="space-y-2 px-4 pb-3">
              {hiddenPending.map((item) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onToggle={(target) => void handleToggle(target)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {pending.length === 0 && done.length > 0 ? (
        <p className="text-sm text-muted-foreground">这段时间的事都做完了。</p>
      ) : null}

      {done.length > 0 ? (
        <div className="rounded-lg border border-border bg-card/40">
          <button
            type="button"
            onClick={() => setIsDoneExpanded(!isDoneExpanded)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground"
          >
            <span className="text-xs">{isDoneExpanded ? '▾' : '▸'}</span>
            已完成 {done.length} 项
          </button>
          {isDoneExpanded ? (
            <ul className="space-y-2 px-4 pb-3">
              {done.map((item) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onToggle={(target) => void handleToggle(target)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
