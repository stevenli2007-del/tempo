/**
 * 任务的类型定义（P0-1-9，API-Contract.md 第 5 节）。
 *
 * 字段一律 camelCase —— Database.md 规定：数据库 snake_case，TS camelCase，禁止混用。
 * 对外形状与 API-Contract.md §5 一致。
 *
 * ### 关于 `dueDate` 为 null
 *
 * Database.md 3.9 明令：「为空表示未知/TBD，禁止用"学期末"之类的假值填充」。
 * 考试日期 `status = tbd` 时派生出来的 task 就是 `dueDate = null`（`syncExamToTask()` 的规则）。
 * 展示层必须显示成 TBD，不能显示成"没截止日期"或干脆不显示。
 */

/** 任务状态。取值与 tasks.status 的 CHECK 约束一致。 */
export type TaskStatus = 'pending' | 'done'

/** 任务来源。Phase 0 只有这三个（Database.md §末「Phase 0 枚举」注记）。 */
export type TaskSource = 'canvas' | 'syllabus' | 'manual'

/** 任务类型。Phase 0 实际用到的只有 `exam`（syllabus 派生）。 */
export type TaskType = 'assignment' | 'exam' | 'reading' | 'other'

/**
 * 任务对外的完整形状（GET /api/v1/tasks 的响应项、PATCH 的响应体）。
 *
 * `courseName` 是冗余字段：任务列表按课程分组展示时，前端不必再为拿课程名
 * 额外拉一次课程列表。它来自 `courses.course_name`，不是 tasks 表自己的列。
 */
export type Task = {
  id: string
  courseId: string
  courseName: string
  title: string
  /** null = 未知 / TBD。禁止用假日期填充。 */
  dueDate: string | null
  taskType: TaskType
  source: TaskSource
  status: TaskStatus
  /**
   * true = 由其他表派生的缓存（Phase 0 只有 `exam_dates` → tasks）。
   * 用户不可直接编辑内容字段，改了会收到 `422 derived_task_immutable`（ADR-004 的接口层强制点）。
   */
  isDerived: boolean
}

/**
 * 课程卡片上的「近期任务」（契约 §2 的 `upcomingTasks`，最多 2 条）。
 *
 * 只含卡片渲染需要的三个字段 —— 卡片本身已经知道课程名，不需要冗余带过来。
 * **已完成的不算**：卡片的语义是"这门课接下来要做的事"，
 * 把一个已经勾掉的任务显示在"近期"里是自相矛盾的。
 */
export type UpcomingTask = {
  id: string
  title: string
  /** null = TBD，卡片上同样按 TBD 渲染。 */
  dueDate: string | null
}
