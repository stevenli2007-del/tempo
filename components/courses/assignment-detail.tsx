import { ExamMark } from '@/components/tasks/exam-mark'
import { formatDue } from '@/lib/tasks/format'
import { canBeOverdue, isEffectivelyDone, isExamTask } from '@/lib/tasks/progress'
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
 * ### 🔴 只列「有分数」的（2026-09-17 Steven 验收定）
 * 本区**不渲染**没有分子的行（`AssignmentDetail` 先按 `hasScore` 过滤）。
 * 它只回答一个问题：「我考了多少」—— 未评分 / `on_paper` / 考试派生 / 外部平台交的
 * 在这里都是噪音。**它们没有被藏起来**：待办清单、周历、课程页其它区照旧可见。
 * 计数行仍写明「另有 N 项暂无分数」，避免用户以为作业少了。
 *
 * ### 未评分 vs 0 分在界面上必须能分清
 * - 没分（`submissionScore === null`）→ **不在这一区出现**（见上）；
 * - 0 分（`submissionScore === 0`）→ 有条，长度 0，右侧明确写 `0 / 20`。
 *
 * ### 颜色按分段变化（2026-09-17 Steven 定，替换原先的"单一中性色"）
 * 满分绿 → 90 段蓝 → 80 段紫 → 70 段珊瑚 → 其余琥珀，见 `scoreTone()`。
 * 色值全部走主题令牌（`--chart-*` → `--purple`/`--blue`/… ），亮/暗主题自动跟随。
 *
 * ⚠️ **最低档刻意不用 `--red`** —— 那是全站「缺交 / 逾期」的警示色。
 * 拿它画分数会把"这次没考好"和"出事了"混成一件事；
 * 琥珀 / 珊瑚只是"另一档颜色"，不是"你完了"（ADR-013 的同一取向）。
 */
function formatScore(value: number): string {
  // 2.25 / 2.5 这类小数原样显示；整数不带小数点。
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

/**
 * 分数条的档位配色（P0-3-17，2026-09-17 Steven 定）。
 *
 * 档位：`>=100%` 绿 ｜ `90–99%` 蓝 ｜ `80–89%` 紫 ｜ `70–79%` 珊瑚 ｜ `<70%` 琥珀。
 *
 * - 全部返回**主题令牌**（`--chart-1..5` → `--purple`/`--blue`/`--green`/`--coral`/`--amber`），
 *   亮/暗主题各自有一套色值，自动跟随；**绝不写死 hex**。
 * - 参数 `ratio` 已由调用方夹在 `[0, 1]`，所以"满分"就是恰好 `1`（加分项 `5/4` 也归满分档）。
 * - 只在能画出条时调用（`ratio !== null`），所以不必处理"分母未知"。
 */
function scoreTone(ratio: number): string {
  if (ratio >= 1) return 'var(--chart-3)' // 满分 → 绿
  if (ratio >= 0.9) return 'var(--chart-2)' // 90–99% → 蓝
  if (ratio >= 0.8) return 'var(--chart-1)' // 80–89% → 紫
  if (ratio >= 0.7) return 'var(--chart-4)' // 70–79% → 珊瑚
  return 'var(--chart-5)' // < 70% → 琥珀
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
            style={{ width: `${ratio * 100}%`, backgroundColor: scoreTone(ratio) }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 一行=一条**有分数**的作业。传进来的行都过了 `hasScore`（见 `AssignmentDetail`），
 * 但这里仍然各自判一次 —— 组件不该假设调用方永远记得过滤。
 */
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

          {/* 考试标记（P0-3-33）：原先是一段 12px 灰字「考试」，与提交态徽标混在一起；
              现在换成带边框底色的徽标，与周历 pill / 今日任务行 / 待办清单**同一套视觉**。
              判据是 `isExamTask(task)` 一处，不在这里重写 `taskType === 'exam'`。 */}
          {isExamTask(task) ? <ExamMark /> : null}
        </div>
        <p className={`mt-0.5 text-xs ${showOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>
          {label ?? '日期待定'}
          {showOverdue ? '（已逾期）' : ''}
        </p>
      </div>

      {/* 分数区：有分子+分母才出现。宽度在窄屏占满、宽屏固定一段，避免挤扁标题。
          原先"已评分但拿不到分数"（Canvas 只给 grade 不给 score）在这里写一行提示，
          现随本区改成「只列有分数的」一并移除 —— 那种行不再进入这一区（2026-09-17 Steven 定）。 */}
      {hasScore ? (
        <div className="w-full shrink-0 sm:w-40">
          <ScoreBar score={task.submissionScore as number} possible={task.pointsPossible as number} />
        </div>
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

  // 🔴 **只列有分数的**（分子与分母都在）—— 2026-09-17 Steven 验收定。
  // 这一区只回答一个问题：「我考了多少」。没有分子的行（尚未评分 / Canvas 不追踪的
  // on_paper 与考试派生 / 外部平台交的）在这里只是噪音，**它们并没有被藏起来** ——
  // 仍完整地留在待办清单、周历、课程页其它区，所以这是"这一区不回答那个问题"。
  // ⚠️ 判据必须是 `hasScore` 的两项同时成立：只有满分没有得分时画不出条（见文件头铁律）。
  if (scored.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        这门课还没有出分的作业。Canvas 评分后会出现在这里。
      </p>
    )
  }

  // 只报"另有 N 项暂无分数"，不把它们列出来 —— 说清被过滤掉的数量，
  // 免得用户以为作业少了（静默丢信息是这类过滤最坏的观感）。
  const unscored = sorted.length - scored.length

  return (
    <div className="space-y-1">
      <p className="text-xs text-ink-faint">
        {scored.length} 项已出分
        {unscored > 0 ? ` · 另有 ${unscored} 项暂无分数` : ''}
        {scored.some((task) => task.canvasUrl !== null) ? ' · 点标题去 Canvas' : ''}
      </p>
      <ul>
        {scored.map((task) => (
          <TaskRow key={task.id} task={task} now={now} />
        ))}
      </ul>
    </div>
  )
}
