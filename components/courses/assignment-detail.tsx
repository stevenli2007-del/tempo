import { formatDue } from '@/lib/tasks/format'
import { canBeOverdue, isEffectivelyDone } from '@/lib/tasks/progress'
import { SUBMISSION_BADGE_CLASS, submissionBadge } from '@/lib/tasks/submission'
import type { Task } from '@/types/task'

/**
 * 课程详情页的「作业详情」区（P0-3-17）。
 *
 * ### 每行回答三个问题
 * ① **这是什么、什么时候交**（Canvas 来源的标题同时是跳去 Canvas 作业页的外链）；
 * ② **Canvas 怎么看它**（复用 `lib/tasks/submission.ts` 的六态徽标，不另写一套文案）；
 * ③ **考了多少**（`submissionScore / pointsPossible` 的分数条）。
 *
 * ### 🔴 分数条的铁律：分母或分子是 null 就**不画**
 * `pointsPossible === null` = Canvas 没设满分；`submissionScore === null` = 尚未评分。
 * 两者都**不是 0 分**。用 0 兜底会画出"0 / 100"这种我们编出来的结论
 * （`lib/numbers.ts` 与迁移 `20260917140000` 都写了这条），
 * 所以这里宁可只显示「尚未评分」，也不给一根长度为 0 的条。
 *
 * ### 未评分 vs 0 分在界面上必须能分清
 * - 没分（`submissionScore === null`）→ 只写状态徽标，**没有条**；
 * - 0 分（`submissionScore === 0`）→ 有条，长度 0，右侧明确写 `0 / 20`。
 *
 * ### 颜色不带判断
 * 分数条用中性的 `--chart-2`，**不**按"90% 绿 / 70% 黄"上色 ——
 * 多少分算好取决于曲线、班级分布、drop 政策，那是我们不知道的事；
 * 把 75% 画成黄色就已经在替用户下结论了（ADR-013 的同一取向）。
 */
function formatScore(value: number): string {
  // 2.25 / 2.5 这类小数原样显示；整数不带小数点。
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function ScoreBar({ score, possible }: { score: number; possible: number }) {
  // 分母 <= 0 画不出有意义的比例（Canvas 个别作业是 0 分制/加分项）→ 只显示数字。
  const ratio = possible > 0 ? Math.min(1, Math.max(0, score / possible)) : null

  return (
    <div className="w-full min-w-0" data-score-bar={`${score}/${possible}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular-nums text-ink">
          {formatScore(score)} / {formatScore(possible)}
        </span>
        {ratio === null ? null : (
          <span className="shrink-0 tabular-nums text-ink-faint">{Math.round(ratio * 100)}%</span>
        )}
      </div>
      {ratio === null ? null : (
        <div
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface2"
          role="img"
          aria-label={`得分 ${formatScore(score)} 分，满分 ${formatScore(possible)} 分`}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${ratio * 100}%`, backgroundColor: 'var(--chart-2)' }}
          />
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, now }: { task: Task; now: Date }) {
  const { label, isOverdue } = formatDue(task.dueDate, now)
  const done = isEffectivelyDone(task)
  const badge = submissionBadge(task)
  const hasScore = task.submissionScore !== null && task.pointsPossible !== null

  /**
   * 逾期只在"已知未完成"时标红 —— 判据与总览页清单、周历逾期条、课程卡**共用**
   * `canBeOverdue()` 一处（P0-3-17），不在这里重写一遍。
   */
  const showOverdue = isOverdue && canBeOverdue(task)

  const titleClass = `underline-offset-4 ${
    done ? 'text-muted-foreground line-through' : 'text-foreground'
  }`

  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* 点标题 = 跳 Canvas 作业页（与"点勾切换完成"是两个动作，P0-3-17）。
              Canvas 没给 html_url 时**退回纯文本**，不编一个链接出来。 */}
          {task.canvasUrl ? (
            <a
              href={task.canvasUrl}
              target="_blank"
              rel="noreferrer"
              className={`truncate text-sm font-medium hover:underline ${titleClass}`}
              title={`在 Canvas 打开「${task.title}」`}
            >
              {task.title}
            </a>
          ) : (
            <span className={`truncate text-sm font-medium ${titleClass}`}>{task.title}</span>
          )}

          {badge ? (
            <span
              className={`shrink-0 text-xs ${SUBMISSION_BADGE_CLASS[badge.tone]}`}
              title={badge.title}
            >
              {badge.label}
            </span>
          ) : null}

          {task.taskType === 'exam' ? (
            <span className="shrink-0 text-xs text-muted-foreground/70">考试</span>
          ) : null}
        </div>
        <p className={`mt-0.5 text-xs ${showOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>
          {label ?? '日期待定'}
          {showOverdue ? '（已逾期）' : ''}
        </p>
      </div>

      {/* 分数区：有分子+分母才出现。宽度在窄屏占满、宽屏固定一段，避免挤扁标题。 */}
      {hasScore ? (
        <div className="w-full shrink-0 sm:w-40">
          <ScoreBar score={task.submissionScore as number} possible={task.pointsPossible as number} />
        </div>
      ) : task.submissionState === 'graded' && task.submissionScore === null ? (
        // 已评分但拿不到分数（Canvas 只给 grade 不给 score 的情况）：说明白，不画空条。
        <p className="shrink-0 text-xs text-ink-faint sm:w-40 sm:text-right">已评分 · 分数未提供</p>
      ) : null}
    </li>
  )
}

export function AssignmentDetail({ tasks, now }: { tasks: Task[]; now: Date }) {
  if (tasks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        这门课还没有作业。连上 Canvas 并同步后，作业与分数会出现在这里。
      </p>
    )
  }

  const sorted = [...tasks].sort((a, b) => {
    // 与 `loadTasks` 同一顺序：due_date 升序、null（TBD）排最后，再按标题稳定排序。
    if (a.dueDate === null && b.dueDate === null) return a.title.localeCompare(b.title)
    if (a.dueDate === null) return 1
    if (b.dueDate === null) return -1
    const diff = Date.parse(a.dueDate) - Date.parse(b.dueDate)
    if (diff !== 0) return diff
    return a.title.localeCompare(b.title)
  })

  const scored = sorted.filter((task) => task.submissionScore !== null && task.pointsPossible !== null)

  return (
    <div className="space-y-1">
      <p className="text-xs text-ink-faint">
        共 {sorted.length} 项
        {scored.length > 0 ? ` · 其中 ${scored.length} 项有分数` : ''}
        {sorted.some((task) => task.canvasUrl !== null) ? ' · 点标题去 Canvas' : ''}
      </p>
      <ul>
        {sorted.map((task) => (
          <TaskRow key={task.id} task={task} now={now} />
        ))}
      </ul>
    </div>
  )
}
