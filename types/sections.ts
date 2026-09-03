/**
 * 五个板块「已落库记录」的对外形状（P0-1-5a）。
 *
 * 与 `types/parse.ts` 的区别：
 * - `types/parse.ts` 是 **LLM 抽取结果**（没有 id，可能带 status 等派生字段）；
 * - 本文件是 **DB 里的行**（带 `id`，带 `source` / `isConfirmed` 这些只有落库后才有的列）。
 *
 * 前端编辑表单（P0-1-6）拿的是这里的对象 —— 要改一条记录必须有 `id`。
 *
 * 与 `Database.md` 3.4~3.8 一一对应，snake_case 只允许出现在 `lib/<表名>.ts`。
 */

/** 落库后的成绩构成条目。 */
export type StoredGradeComponent = {
  id: string
  name: string
  weightPercent: number | null
  notes: string | null
  /** 用户确认过这条解析结果。P0-1-5b 的保存接口会置 true。 */
  isConfirmed: boolean
  source: string
  sourceExcerpt: string | null
}

/** 落库后的课程大纲条目。 */
export type StoredCourseOutlineItem = {
  id: string
  orderIndex: number
  weekLabel: string | null
  topic: string
  source: string
  sourceExcerpt: string | null
}

/** 落库后的考试日期条目（`exam_dates` 是权威源，见 ADR-004）。 */
export type StoredExamDate = {
  id: string
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
  status: 'confirmed' | 'tbd'
  isConfirmed: boolean
  source: string
  sourceExcerpt: string | null
}

/** 落库后的 office hour 条目。 */
export type StoredOfficeHour = {
  id: string
  personName: string
  dayOfWeek: string | null
  startTime: string | null
  endTime: string | null
  location: string | null
  source: string | null
  sourceExcerpt: string | null
}

/** 落库后的提交政策条目。 */
export type StoredSubmissionPolicy = {
  id: string
  description: string
  platformName: string | null
  source: string | null
  sourceExcerpt: string | null
}

// ---------------------------------------------------------------
// P0-1-5b：五板块保存（PUT 全量替换）的输入形状
// ---------------------------------------------------------------

/**
 * 保存输入与 `Stored*` 的区别：
 * - `id` 可选（不带 = 新增一行，落库时 `source = 'manual'`）；
 * - **没有** `source` / `sourceExcerpt` / `isConfirmed` —— 这三样不是用户能决定的：
 *   来源是系统按「带不带 id」判定的，摘录来自原文（用户新增的行没有摘录），
 *   确认标记由保存动作本身置位。
 *
 * ⚠️ `SaveExamDateItem` **没有 `status`**：它由 `examDate` 派生（有日期 = confirmed，
 * 否则 tbd），规则与解析侧的 `normalizeExam()` 完全一致 —— 契约 §4 早期示例里
 * 让请求方填 status，等于允许"日期为空但状态是已确定"的矛盾数据进库。
 */

export type SaveGradeComponentItem = {
  id?: string
  name: string
  weightPercent: number | null
  notes: string | null
}

export type SaveCourseOutlineItem = {
  id?: string
  weekLabel: string | null
  topic: string
}

export type SaveExamDateItem = {
  id?: string
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
}

export type SaveOfficeHourItem = {
  id?: string
  personName: string
  dayOfWeek: string | null
  startTime: string | null
  endTime: string | null
  location: string | null
}

export type SaveSubmissionPolicyItem = {
  id?: string
  description: string
  platformName: string | null
}

/**
 * `POST /api/v1/syllabi/:id/parse` 响应里 `sections` 的形状。
 *
 * ⚠️ **键是可选的**：解析失败的板块**不给空数组**，而是整个键不出现。
 * 空数组会被前端当成"这份 syllabus 确实没有 office hours"，
 * 而"没解析出来"和"确实没有"是两件事 —— 宁可让 TS 报错，也不给假数据（CodingRules 7）。
 * 前端靠 `okSections` / `failedSections` 判断该展示什么。
 */
export type StoredSections = {
  gradeComposition?: StoredGradeComponent[]
  courseOutline?: StoredCourseOutlineItem[]
  testDates?: StoredExamDate[]
  officeHours?: StoredOfficeHour[]
  submissionPolicy?: StoredSubmissionPolicy[]
}
