/**
 * 任务行上的「提交态徽标」口径层（P0-3-15）。
 *
 * ### 为什么单独一层
 * `components/tasks/task-list.tsx`（总览页任务行）与
 * `components/courses/course-card.tsx`（课程卡近期任务）**都要标这个小旗子**。
 * 两处各写一份 switch，迟早出现"同一份作业在总览页写『已评分』、在课程页写『已提交』" ——
 * 而这正是用户在截图上抓到的那类矛盾的变体。
 *
 * ### 六态 → 三类语义（颜色只表达"要不要行动"）
 * - 警示（amber）：`unsubmitted` —— Canvas 明确说没收到，该催；
 * - 危险（red）：`missing` —— 同上是没交，但 Canvas 已判「逾期缺交」，更重；
 * - 正向（green）：`submitted` / `pending_review` / `graded` —— **都属于「已完成」**
 *   （`isCanvasDone()`），文案不同只为告诉用户走到哪一步了；
 * - 中性（gray）：`external_unconfirmed` —— 外部平台交的，Canvas 没有可信记录（ADR-013）；
 * - 中性（gray）：**`null` 且来源是 Canvas** → 「需手动确认」（P0-3-17，见下）。
 *
 * ### 🔴 P0-3-17 的改动：`null` 从「不标」变成**有条件的**「需手动确认」
 * 3-15 时 `null` 一律返回 null（不标）—— 因为把"没有真相"渲染成任何一种结论都是编的。
 * 但 `null` 里混着**两类语义完全不同**的任务（详见 `needsManualConfirmation()` 的注释）：
 * - **Canvas 来源** → Canvas 明说"我不追踪这条的完成态"（on_paper / none / not_graded）→
 *   该让用户知道"这事得你自己确认"，标灰「需手动确认」；
 * - **syllabus / manual 来源**（考试派生、用户自建）→ 与 Canvas 无关，null 只是"该你自己勾"，
 *   **不标**（给每一场考试都挂个徽标是纯噪声）。
 *
 * 所以本函数必须拿到 `task.source` —— **不能再只看 state**。
 * 这正是 3-15 的教训：判定要收在一个函数里，而不是让每个调用点自己拼。
 *
 * ### 与「勾选框」的分工（P0-3-15 的核心）
 * 徽标 = **Canvas 真相**（是谁也改不了的外部记录）；
 * 勾选框 = **谁判定完成的**（`isCanvasDone()` 为真时不可点，避免点了没反应的静默失败）。
 * 两者一起看，用户才能一眼分清「我勾的」和「Canvas 替我确认的」。
 */
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import { needsManualConfirmation } from '@/lib/tasks/progress'
import type { Task } from '@/types/task'

/** 徽标语气 —— 决定颜色，不决定文案。 */
export type SubmissionBadgeTone = 'warning' | 'danger' | 'positive' | 'neutral'

export interface SubmissionBadge {
  /** 行上显示的二字短标（用户扫一眼就够）。 */
  label: string
  tone: SubmissionBadgeTone
  /** 悬停时的完整解释 —— 两个字说不清来源与含义。 */
  title: string
}

/**
 * 提交态 → 徽标。`null` 表示**不该标**（与 Canvas 无关的任务没有提交态可言）。
 *
 * ⚠️ 入参是「任务的最小形状」而不是裸 `state` —— 因为 `null` 的含义要看**来源**
 * （P0-3-17，见文件头）。调用方直接把自己的行对象传进来即可。
 *
 * ⚠️ 除了 `null` 外的六种 state 必须穷尽（`switch` 无 default 分支时 TS 会强制）——
 * 将来 `TaskSubmissionState` 加值，这里会编译报错而不是静默不标。
 */
export function submissionBadge(
  task: Pick<Task, 'source' | 'submissionState'>,
  lang: Lang = 'zh',
): SubmissionBadge | null {
  switch (task.submissionState) {
    case 'unsubmitted':
      return { label: t(lang, 'submission.unsubmitted.label'), tone: 'warning', title: t(lang, 'submission.unsubmitted.title') }
    case 'missing':
      return { label: t(lang, 'submission.missing.label'), tone: 'danger', title: t(lang, 'submission.missing.title') }
    case 'submitted':
      return { label: t(lang, 'submission.submitted.label'), tone: 'positive', title: t(lang, 'submission.submitted.title') }
    case 'pending_review':
      return { label: t(lang, 'submission.pending_review.label'), tone: 'positive', title: t(lang, 'submission.pending_review.title') }
    case 'graded':
      return { label: t(lang, 'submission.graded.label'), tone: 'positive', title: t(lang, 'submission.graded.title') }
    case 'external_unconfirmed':
      return {
        label: t(lang, 'submission.external_unconfirmed.label'),
        tone: 'neutral',
        title: t(lang, 'submission.external_unconfirmed.title'),
      }
    case null:
      // 只有 **Canvas 来源** 的 null 才标（P0-3-17）：那是 Canvas 明说"我不追踪完成态"，
      // 与"考试派生 / 用户自建任务"的 null 不是一回事（后者干脆不标，见文件头）。
      return needsManualConfirmation(task)
        ? {
            label: t(lang, 'submission.manual.label'),
            tone: 'neutral',
            title: t(lang, 'submission.manual.title'),
          }
        : null
  }
}

/**
 * 语气 → Tailwind 文字色工具类。
 *
 * 色值走 `app/globals.css` 的 `@theme` 令牌（`--color-amber/red/green`），
 * 亮暗两套主题自动跟随 —— **不要在这里写死 hex**，否则暗色模式下会糊在背景里。
 * 与 `--color-destructive` 同源（`--destructive: var(--red)`）。
 */
export const SUBMISSION_BADGE_CLASS: Record<SubmissionBadgeTone, string> = {
  warning: 'text-amber',
  danger: 'text-destructive',
  positive: 'text-green',
  neutral: 'text-muted-foreground',
}
