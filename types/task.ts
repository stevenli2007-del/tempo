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

/**
 * Canvas 提交态（P0-3-10）。`tasks.submission_state` 的取值，**null = Canvas 不追踪完成态**。
 *
 * 与用户主权的 `status`（pending/done）分列（ADR-015）：同步写前者、永不写后者，
 * 展示层合并成"是否算完成"。
 *
 * - `null`                无提交态（on_paper/none/not_graded → 用户手勾；或无法判定）
 * - `unsubmitted`         追踪但未交（**不含 external_tool**，见下条）
 * - `submitted`           已提交未评分
 * - `pending_review`      已交待查重
 * - `graded`              已评分（视为完成）
 * - `missing`             Canvas 标记缺交（逾期且未交）
 * - `external_unconfirmed` 外部平台（Gradescope 等 LTI）：Canvas 无可信记录（无记录，**或**它说的
 *                         "未交"其实只是推断 —— 实测出现过已交却报未交）→ 展示「待确认」
 */
export type TaskSubmissionState =
  | 'unsubmitted'
  | 'submitted'
  | 'pending_review'
  | 'graded'
  | 'missing'
  | 'external_unconfirmed'

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
  /**
   * Canvas 提交态（P0-3-10）。`null` = Canvas 不追踪完成态。
   * 与 `status` 分列：同步写它、永不写 `status`，展示层合并（ADR-015）。
   */
  submissionState: TaskSubmissionState | null
  /** Canvas 提交时刻（ISO 8601）或 null。展示层按学校时区渲染。 */
  submittedAt: string | null
  /**
   * Canvas 作业页地址（`tasks.canvas_url`，P0-3-17）。null = 非 Canvas 来源或 Canvas 未给。
   * 任务名渲染为此外链；**null 时退回纯文本**，不编一个链接出来。
   */
  canvasUrl: string | null
  /**
   * 该作业满分（`tasks.points_possible`，P0-3-17）。null = Canvas 未设满分（**不是 0 分**）。
   * 与 `submissionScore` 一起画分数条；任一为 null 时不画（不编进度）。
   */
  pointsPossible: number | null
  /**
   * 当前用户得分（`tasks.submission_score`，P0-3-17）。null = 尚未评分（**不是 0 分**）。
   * 与 `pointsPossible` 一起画分数条。
   */
  submissionScore: number | null
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
  /**
   * 任务类型（P0-3-33）。课程卡上的「考试」标记判据是 `isExamTask()`
   * （`taskType === 'exam'`）—— 与总览清单、周历共用同一处判定，卡片不另写一份。
   */
  taskType: TaskType
  /**
   * 任务来源（P0-3-17）。徽标「需手动确认」只给 **Canvas 来源** 的 null 态，
   * 所以卡片也必须有它 —— 否则课程卡与总览清单会对同一条任务标出不同的徽标。
   */
  source: TaskSource
  /**
   * 任务状态（P0-3-17）。
   * 取数时已经 `.eq('status','pending')` 过滤过，所以这里**当前恒为 `'pending'`**；
   * 带上它是为了让「能不能标逾期」的判据（`canBeOverdue()`）能直接用，
   * 而不是在展示层假设"反正都是 pending"—— 那正是判定分叉的起点（P0-3-15 的教训）。
   */
  status: TaskStatus
  /** Canvas 提交态（P0-3-10）；null = 不追踪。卡片用于显示「已提交（Canvas）」等。 */
  submissionState: TaskSubmissionState | null
}

/**
 * 候选匹配用的轻量任务（P0-3-8b）。
 *
 * 「用户输入 → 先检索现有任务」里检索结果的形状：只带判断「是不是它」与渲染选项
 * 需要的字段，不带 `status` / `submissionState` 这些展示态 —— 匹配用不到它们。
 * 与 `Task` 的区别是**没有 `courseName`**：检索已限定在单门课内，课程名是冗余的。
 */
export type TaskCandidate = {
  id: string
  title: string
  /** null = TBD。 */
  dueDate: string | null
  taskType: TaskType
  source: TaskSource
  /** true = 派生缓存（考试）。**不可在对话框直接改内容**（ADR-004）。 */
  isDerived: boolean
  /**
   * 任务当前状态。**可选** —— 对话框（P0-3-8b）不需要它，只有邮件入站需要：
   * 入站是**无人确认**的自动落写，同名任务有多条时要靠它挑出「还没完成的那条」，
   * 且「全部已完成」时应当直接跳过（写 `done` 本身是空操作，没必要选一条来写）。
   * 不传时按「未知状态」处理 —— 匹配逻辑会退化为「必须唯一命中才落写」（fail safe）。
   */
  status?: TaskStatus
}

/**
 * 带相似度得分的候选（`matchTasks()` 的返回项）。`score ∈ [0,1]`，越大越像，
 * 归一化后完全相同为 1。前端按 score 降序展示，让用户挑要改哪条。
 */
export type TaskMatch = TaskCandidate & { score: number }
