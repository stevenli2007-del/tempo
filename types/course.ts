/**
 * 课程 Workspace 的类型定义。
 *
 * 字段一律 camelCase —— Database.md 规定：数据库 snake_case，TS camelCase，禁止混用。
 * 对外的 Course 形状与 API-Contract.md 第 2 节一致。
 */

import type {
  StoredCourseOutlineItem,
  StoredExamDate,
  StoredGradeComponent,
  StoredOfficeHour,
  StoredSubmissionPolicy,
} from '@/types/sections'
import type { Syllabus } from '@/types/syllabus'
import type { UpcomingTask } from '@/types/task'

/** 同步状态。取值与 courses.sync_status 的 CHECK 约束一致（迁移 20260902003000 :59-60）。 */
export type CourseSyncStatus = 'never' | 'success' | 'failed'

/** 课程对外的完整形状（GET 列表 / POST / PATCH 的响应体）。 */
export type Course = {
  id: string
  semester: string
  courseName: string
  courseCode: string | null
  instructorName: string | null
  isDemo: boolean
  isArchived: boolean
  /** 由 canvas_course_id 是否为空派生，不单独存字段。 */
  canvasLinked: boolean
  lastSyncedAt: string | null
  syncStatus: CourseSyncStatus
  syncError: string | null
  /**
   * 该课程近期未完成的任务（最多 2 条，契约 §2 列表响应字段）。
   *
   * P0-1-9 才真正返回 —— 契约里早写了这个字段，但端点此前一直没给。
   *
   * **为什么是可选的**：字段缺失表示「没能加载到」，而不是「这门课没有任务」。
   * 这两件事在 UI 上必须分开（CodingRules 7：静默的空数据比明确的错误更危险），
   * 所以查失败时宁可不填这个字段，也不能填 `[]` 假装没有任务。
   * `toCourse()` 是纯行映射，不带这个字段；由调用方在查到后附加。
   */
  upcomingTasks?: UpcomingTask[]
}

/** 创建课程的输入：semester / courseName 必填，其余选填。 */
export type CreateCourseInput = {
  semester: string
  courseName: string
  courseCode?: string | null
  instructorName?: string | null
}

/** 更新课程的输入：全字段可选，只传要改的字段。 */
export type UpdateCourseInput = Partial<CreateCourseInput>

/**
 * 课程详情页的完整对象（P0-1-8，API-Contract.md §2 的 `GET /api/v1/courses/:id`）。
 *
 * 契约原示例里 `syllabus` 只给了 `{ id, fileName, parseStatus }` 三个字段；
 * 实际前端需要 `extractStatus` / `parseError` 才能渲染「解析失败，可重试」这类状态，
 * 所以这里**返回完整的 `Syllabus`（超集）**，契约已同步更正。
 * 板块缺失一律返回 `[]` 而不是 `null` —— 前端按「TBD / 还没有内容」渲染。
 */
export type CourseDetail = Course & {
  syllabus: Syllabus | null
  gradeComponents: StoredGradeComponent[]
  outlineItems: StoredCourseOutlineItem[]
  examDates: StoredExamDate[]
  officeHours: StoredOfficeHour[]
  submissionPolicies: StoredSubmissionPolicy[]
}

/** API-Contract.md 1.3 定义的统一错误结构。 */
export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
