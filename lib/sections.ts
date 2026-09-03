import {
  COURSE_OUTLINE_ITEM_COLUMNS,
  toCourseOutlineItem,
} from '@/lib/course-outline-items'
import type { CourseOutlineItemRow } from '@/lib/course-outline-items'
import { EXAM_DATE_COLUMNS, toExamDate } from '@/lib/exam-dates'
import type { ExamDateRow } from '@/lib/exam-dates'
import { GRADE_COMPONENT_COLUMNS, toGradeComponent } from '@/lib/grade-components'
import type { GradeComponentRow } from '@/lib/grade-components'
import { OFFICE_HOUR_COLUMNS, toOfficeHour } from '@/lib/office-hours'
import type { OfficeHourRow } from '@/lib/office-hours'
import { SUBMISSION_POLICY_COLUMNS, toSubmissionPolicy } from '@/lib/submission-policies'
import type { SubmissionPolicyRow } from '@/lib/submission-policies'
import { createClient } from '@/lib/supabase/server'
import type {
  StoredCourseOutlineItem,
  StoredExamDate,
  StoredGradeComponent,
  StoredOfficeHour,
  StoredSections,
  StoredSubmissionPolicy,
} from '@/types/sections'

/**
 * 五个板块的服务端读取（P0-1-6）。
 *
 * 契约 §4 只定义了 PUT（保存），五板块的「读」没有独立端点 ——
 * `GET /api/v1/courses/:id`（课程详情含五板块）归 P0-1-8。
 * 所以 P0-1-6 的表单初值走 dashboard 同款模式：**服务端组件直查 + RLS**，
 * 与 `loadLatestSyllabi` 一致，不新增契约端点。
 *
 * 排序与 `lib/parse/save.ts` 的 loadSection 保持同一条规则：
 * 大纲按 `order_index`，其余按 `created_at`。
 */

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 内部用的可变结构（对外类型 StoredSections 的键全是可选的，不适合累加用）。 */
type MutableSections = {
  gradeComposition: StoredGradeComponent[]
  courseOutline: StoredCourseOutlineItem[]
  testDates: StoredExamDate[]
  officeHours: StoredOfficeHour[]
  submissionPolicy: StoredSubmissionPolicy[]
}

function emptySections(): MutableSections {
  return {
    gradeComposition: [],
    courseOutline: [],
    testDates: [],
    officeHours: [],
    submissionPolicy: [],
  }
}

/**
 * 一次取齐多门课的五板块（每张表一个 `in` 查询，共 5 个，无 N+1）。
 *
 * 错误处理与 loadLatestSyllabi 同一取舍：板块是次要数据，查失败不该让课程列表白屏，
 * 但要给一条可见的提示（CodingRules 7）。
 * 任一表查询失败即整体降级（返回已解析的部分没有意义 —— 用户会拿不完整数据当全量去保存）。
 */
export async function loadCourseSections(
  supabase: ServerSupabase,
  courseIds: string[],
): Promise<{ byCourse: Map<string, StoredSections>; error: string | null }> {
  const byCourse = new Map<string, StoredSections>()
  if (courseIds.length === 0) {
    return { byCourse, error: null }
  }

  const [grades, outline, exams, officeHours, policies] = await Promise.all([
    supabase
      .from('grade_components')
      .select(GRADE_COMPONENT_COLUMNS)
      .in('course_id', courseIds)
      .order('created_at', { ascending: true }),
    supabase
      .from('course_outline_items')
      .select(COURSE_OUTLINE_ITEM_COLUMNS)
      .in('course_id', courseIds)
      .order('order_index', { ascending: true }),
    supabase
      .from('exam_dates')
      .select(EXAM_DATE_COLUMNS)
      .in('course_id', courseIds)
      .order('created_at', { ascending: true }),
    supabase
      .from('office_hours')
      .select(OFFICE_HOUR_COLUMNS)
      .in('course_id', courseIds)
      .order('created_at', { ascending: true }),
    supabase
      .from('submission_policies')
      .select(SUBMISSION_POLICY_COLUMNS)
      .in('course_id', courseIds)
      .order('created_at', { ascending: true }),
  ])

  const firstError =
    grades.error ?? outline.error ?? exams.error ?? officeHours.error ?? policies.error
  if (firstError) {
    return { byCourse, error: firstError.message }
  }

  const buckets = new Map<string, MutableSections>()
  const bucketOf = (courseId: string): MutableSections => {
    let bucket = buckets.get(courseId)
    if (!bucket) {
      bucket = emptySections()
      buckets.set(courseId, bucket)
    }
    return bucket
  }

  // toRow 对约束外的枚举值抛错（不编兜底值，CodingRules 7）。
  // 换行数据坏一行会让整页降级 —— 这是刻意的：静默丢行会让用户以为"这门课没有这个板块"。
  try {
    for (const row of (grades.data ?? []) as GradeComponentRow[]) {
      bucketOf(row.course_id).gradeComposition.push(toGradeComponent(row))
    }
    for (const row of (outline.data ?? []) as CourseOutlineItemRow[]) {
      bucketOf(row.course_id).courseOutline.push(toCourseOutlineItem(row))
    }
    for (const row of (exams.data ?? []) as ExamDateRow[]) {
      bucketOf(row.course_id).testDates.push(toExamDate(row))
    }
    for (const row of (officeHours.data ?? []) as OfficeHourRow[]) {
      bucketOf(row.course_id).officeHours.push(toOfficeHour(row))
    }
    for (const row of (policies.data ?? []) as SubmissionPolicyRow[]) {
      bucketOf(row.course_id).submissionPolicy.push(toSubmissionPolicy(row))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { byCourse, error: message }
  }

  for (const [courseId, bucket] of buckets) {
    byCourse.set(courseId, bucket)
  }
  return { byCourse, error: null }
}
