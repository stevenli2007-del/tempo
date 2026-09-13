/**
 * 手动任务（source = 'manual'）的纯逻辑层（P0-3-8）。
 *
 * 与 `lib/tasks.ts` 同一条约定：这里**只放纯函数**（校验 + 日期归一化），
 * 不碰 supabase、不碰 LLM，方便 `scripts/regress-manual-tasks.ts` 直接 import 跑口径断言，
 * 不依赖数据库或网络。
 *
 * ### 为什么单独成文件
 * 手动任务的写入出口此前在契约里标着「未实现」（`API-Contract.md` §5.1），
 * 现在 3-8 要补上。把校验/归一化抽出来，一是可单测，二是让路由层只做「编排」。
 *
 * ### 🔴 双写入方纪律（MEMORY.md 红线）
 * `tasks` 表由两方按 `source` 收口写入：`exam-tasks` → `syllabus`/`exam`，
 * `canvas-tasks` → `canvas`。本文件产出的所有行**强制 `source = 'manual'`**，
 * 且 DELETE 只允许删 `source = 'manual'` 的行 —— 绝不动到另外两方的行，
 * 否则「一方把另一方的行当缺席删掉」这种最贵事故就会发生。
 */

import type { TaskType } from '@/types/task'

/** 手动任务允许的类型。**不含 `exam`**：考试是 `exam_dates` 的权威派生（ADR-004），不准手动建。 */
export const MANUAL_TASK_TYPES: readonly TaskType[] = ['assignment', 'reading', 'other']

/** 与 `lib/api/params.ts` 的 `UUID_PATTERN` 保持一致（避免为这一个校验再 import 一整个模块）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TITLE_MAX = 500
const NOTES_MAX = 1000

/** 校验通过的手动任务输入。字段名已是 camelCase，路由层直接拼插入行。 */
export type ManualTaskInput = {
  courseId: string
  title: string
  taskType: TaskType
  dueDate: string | null
  notes?: string | null
}

/** 写入 `tasks` 的行（snake_case，只含本写入方该填的列；其余靠默认值）。 */
export type ManualTaskInsertRow = {
  course_id: string
  title: string
  due_date: string | null
  task_type: TaskType
  source: 'manual'
  status: 'pending'
  is_derived: false
  submission_state: null
  submitted_at: null
}

/**
 * 截止日期归一化。
 *
 * - `null` / `''` / 缺省 → TBD（**禁止编造日期**，Database.md 3.9 硬规定）。
 * - `YYYY-MM-DD` 纯日期 → 当日 `23:59:59Z`。尾随 `Z` 与 `exam-tasks` 的
 *   `T23:59:59` 约定一致（按 UTC 落当日），总览页按学校时区渲染时仍是同一天。
 * - 已是带时区的 ISO 串 → 原样保留。
 * - 其它一律报错，绝不静默填假值。
 */
export function normalizeDueDate(
  input: unknown,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (input === null || input === undefined || input === '') {
    return { ok: true, value: null }
  }
  if (typeof input !== 'string') {
    return { ok: false, message: 'dueDate 必须是日期字符串或 null' }
  }
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed)
  if (dateOnly) {
    // 校验真实存在（挡掉 2026-13-40 这类）
    const probe = new Date(`${trimmed}T23:59:59Z`)
    if (Number.isNaN(probe.getTime())) {
      return { ok: false, message: `dueDate 不是合法日期：${trimmed}` }
    }
    return { ok: true, value: `${trimmed}T23:59:59Z` }
  }

  const iso = new Date(trimmed)
  if (!Number.isNaN(iso.getTime())) {
    return { ok: true, value: iso.toISOString() }
  }
  return {
    ok: false,
    message: `dueDate 格式无法识别：${trimmed}（请使用 YYYY-MM-DD 或带时区的 ISO 时间）`,
  }
}

/**
 * 校验单条手动任务输入（来自请求体，不可信）。
 *
 * 返回 `{ ok: true, value }` 或 `{ ok: false, message }`。**不查数据库**
 * （课程归属校验在路由层做，因为它需要会话 supabase 客户端）。
 */
export function validateManualTaskInput(
  raw: unknown,
): { ok: true; value: ManualTaskInput } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '任务必须是对象' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r.courseId !== 'string' || !UUID_PATTERN.test(r.courseId)) {
    return { ok: false, message: 'courseId 格式不正确' }
  }

  if (typeof r.title !== 'string' || r.title.trim() === '') {
    return { ok: false, message: 'title 不能为空' }
  }
  const title = r.title.trim().slice(0, TITLE_MAX)

  if (
    typeof r.taskType !== 'string' ||
    !MANUAL_TASK_TYPES.includes(r.taskType as TaskType)
  ) {
    return {
      ok: false,
      message: `taskType 必须是 ${MANUAL_TASK_TYPES.join(' / ')}（考试请在课程页更新）`,
    }
  }

  const due = normalizeDueDate(r.dueDate)
  if (!due.ok) return due

  const notes = typeof r.notes === 'string' ? r.notes.slice(0, NOTES_MAX) : null

  return {
    ok: true,
    value: { courseId: r.courseId, title, taskType: r.taskType as TaskType, dueDate: due.value, notes },
  }
}

/** 把校验通过的输入拼成插入行（强制本写入方的闭合取值）。 */
export function toInsertRow(input: ManualTaskInput): ManualTaskInsertRow {
  return {
    course_id: input.courseId,
    title: input.title,
    due_date: input.dueDate,
    task_type: input.taskType,
    source: 'manual',
    status: 'pending',
    is_derived: false,
    submission_state: null,
    submitted_at: null,
  }
}
