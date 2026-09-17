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
 * - 中性（gray）：`external_unconfirmed` —— 外部平台交的，Canvas 没有可信记录（ADR-013）。
 *
 * `null`（Canvas 不追踪完成态，如考试派生 / on_paper / not_graded）**返回 null**：
 * 没有真相就不编一个徽标出来（ADR-015「不确定就标待确认，绝不猜」）。
 *
 * ### 与「勾选框」的分工（P0-3-15 的核心）
 * 徽标 = **Canvas 真相**（是谁也改不了的外部记录）；
 * 勾选框 = **谁判定完成的**（`isCanvasDone()` 为真时不可点，避免点了没反应的静默失败）。
 * 两者一起看，用户才能一眼分清「我勾的」和「Canvas 替我确认的」。
 */
import type { TaskSubmissionState } from '@/types/task'

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
 * 提交态 → 徽标。`null` 表示**不该标**（Canvas 无真相）。
 *
 * ⚠️ 六种 state 必须穷尽（`switch` 无 default 分支时 TS 会强制）——
 * 将来 `TaskSubmissionState` 加值，这里会编译报错而不是静默不标。
 */
export function submissionBadge(state: TaskSubmissionState | null): SubmissionBadge | null {
  switch (state) {
    case 'unsubmitted':
      return { label: '未提交', tone: 'warning', title: 'Canvas 记录尚未提交' }
    case 'missing':
      return { label: '缺交', tone: 'danger', title: 'Canvas 已标记为缺交（逾期且未交）' }
    case 'submitted':
      return { label: '已提交', tone: 'positive', title: 'Canvas 已收到提交，尚未评分' }
    case 'pending_review':
      return { label: '待查重', tone: 'positive', title: 'Canvas 已收到提交，正在查重' }
    case 'graded':
      return { label: '已评分', tone: 'positive', title: 'Canvas 已评分' }
    case 'external_unconfirmed':
      return {
        label: '待确认',
        tone: 'neutral',
        title: '外部平台（如 Gradescope）提交的，Canvas 没有可信记录',
      }
    case null:
      return null
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
