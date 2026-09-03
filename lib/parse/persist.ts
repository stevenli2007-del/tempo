import {
  COURSE_OUTLINE_ITEM_COLUMNS,
  toCourseOutlineItem,
  toCourseOutlineItemInsert,
} from '@/lib/course-outline-items'
import type { CourseOutlineItemRow } from '@/lib/course-outline-items'
import { EXAM_DATE_COLUMNS, toExamDate, toExamDateInsert } from '@/lib/exam-dates'
import type { ExamDateRow } from '@/lib/exam-dates'
import { GRADE_COMPONENT_COLUMNS, toGradeComponent, toGradeComponentInsert } from '@/lib/grade-components'
import type { GradeComponentRow } from '@/lib/grade-components'
import { OFFICE_HOUR_COLUMNS, toOfficeHour, toOfficeHourInsert } from '@/lib/office-hours'
import type { OfficeHourRow } from '@/lib/office-hours'
import {
  SUBMISSION_POLICY_COLUMNS,
  toSubmissionPolicy,
  toSubmissionPolicyInsert,
} from '@/lib/submission-policies'
import type { SubmissionPolicyRow } from '@/lib/submission-policies'

import type { getCurrentUser } from '@/lib/api/response'
import { syncExamToTask } from '@/lib/sync/exam-tasks'

import type { ParsedSyllabusResult } from '@/types/parse'
import type { StoredSections } from '@/types/sections'

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/**
 * 把解析结果写进五张板块表（P0-1-5a 的落库层）。
 *
 * **为什么单独一层**：`lib/parse/index.ts` 只负责调 LLM，不碰 DB（P0-1-4 定的边界）。
 * 落库这件事的所有规则都集中在这里，不在路由里散着写。
 *
 * ### 两条写入规则（改动前先读）
 *
 * 1. **只对成功的板块动刀**。某个板块解析失败 → 库里原有数据**原样保留**。
 *    不能因为这一轮没解析出来，就把上一轮解析成功的内容删掉。
 * 2. **只删 `source = 'syllabus'` 的行**。`source = 'manual'`（用户自己加的）不动 ——
 *    那是用户输入，机器没资格覆盖。
 *
 * ### 为什么**没有**启用 `is_confirmed` 保护（2026-09-03 实测后推翻）
 *
 * 初版还写了第三条「`is_confirmed = true` 的行不删」（`grade_components` / `exam_dates` 有这个标记），
 * 想法是"用户确认过的内容是权威"。**冒烟实测发现它会制造重复数据**：
 * 保留旧行 + 插入新解析结果 ⇒ 同一条目（比如 Homework 20%）在列表里出现两份。
 * 要既不重复又不覆盖，就得做「条目匹配」（按 name 判断新旧是同一条）——
 * 那是模糊匹配，会引入一整类新的边界情况，Phase 0 不值得。
 *
 * 于是退回更简单的规则：**syllabus 来源的行一律用最新解析结果整体替换**。
 * 重解析是用户主动触发的稀有动作（换模型 / 改 prompt 之后），这个场景下
 * "拿最新结果覆盖"本来就是用户要的；用户手动加的行仍然不动。
 * 等 P0-1-5b 的编辑流程把 `is_confirmed` 的语义定下来，再回来决定要不要加回这条保护。
 *
 * ⚠️ **没有跨表事务**：supabase-js 不支持多语句事务（除非写 RPC）。
 * 逐表「先删后插」，中途失败会留下部分写入的状态（已删未插）。
 * Phase 0 接受这个风险：失败会抛 500，`syllabi.parse_status` 不会被写成 completed，
 * 用户重试一次即可自愈。真要做到原子，将来加一个 Postgres 函数包住这五张表的写操作。
 */

export type PersistParams = {
  supabase: SupabaseClient
  /** 目标课程。RLS 的 WITH CHECK 会挡住不属于当前用户的 course_id。 */
  courseId: string
  /** `parseSyllabusSections()` 的原始结果 —— 失败的板块原样跳过。 */
  sections: ParsedSyllabusResult['sections']
}

/**
 * 落库，返回「库里现在的样子」（带 id，供前端编辑表单直接用）。
 *
 * 返回的键与成功的板块一一对应：**解析失败的板块不会有键**（见 `types/sections.ts`）。
 * 板块成功但抽到 0 条 → 给**空数组**（原文确实没有这块内容，与"没解析出来"是两回事）。
 */
export async function persistParsedSections({
  supabase,
  courseId,
  sections,
}: PersistParams): Promise<StoredSections> {
  const stored: StoredSections = {}

  // 串行而非并发：十次往返加起来也就几百毫秒，换来的是失败时
  // 「写到哪一张表断了」这件事在日志与库状态里都是确定的。
  if (sections.gradeComposition.ok) {
    stored.gradeComposition = await replaceAll(
      supabase,
      'grade_components',
      GRADE_COMPONENT_COLUMNS,
      { course_id: courseId, source: 'syllabus' },
      sections.gradeComposition.data.map((item) => toGradeComponentInsert(item, courseId)),
      (row) => toGradeComponent(row as GradeComponentRow),
    )
  }

  if (sections.courseOutline.ok) {
    stored.courseOutline = await replaceAll(
      supabase,
      'course_outline_items',
      COURSE_OUTLINE_ITEM_COLUMNS,
      { course_id: courseId, source: 'syllabus' },
      sections.courseOutline.data.map((item) => toCourseOutlineItemInsert(item, courseId)),
      (row) => toCourseOutlineItem(row as CourseOutlineItemRow),
    )
  }

  if (sections.testDates.ok) {
    stored.testDates = await replaceAll(
      supabase,
      'exam_dates',
      EXAM_DATE_COLUMNS,
      { course_id: courseId, source: 'syllabus' },
      sections.testDates.data.map((item) => toExamDateInsert(item, courseId)),
      (row) => toExamDate(row as ExamDateRow),
    )
    // 解析写入的考试行同样要派生 task（ADR-004 的触发时机含「新增」）。
    // 没有这一步，解析成功后总览页永远缺考试，直到用户手动保存一次考试板块。
    await syncExamToTask({ supabase, courseId, exams: stored.testDates })
  }

  if (sections.officeHours.ok) {
    stored.officeHours = await replaceAll(
      supabase,
      'office_hours',
      OFFICE_HOUR_COLUMNS,
      { course_id: courseId, source: 'syllabus' },
      sections.officeHours.data.map((item) => toOfficeHourInsert(item, courseId)),
      (row) => toOfficeHour(row as OfficeHourRow),
    )
  }

  if (sections.submissionPolicy.ok) {
    stored.submissionPolicy = await replaceAll(
      supabase,
      'submission_policies',
      SUBMISSION_POLICY_COLUMNS,
      { course_id: courseId, source: 'syllabus' },
      sections.submissionPolicy.data.map((item) => toSubmissionPolicyInsert(item, courseId)),
      (row) => toSubmissionPolicy(row as SubmissionPolicyRow),
    )
  }

  return stored
}

/**
 * 通用「删旧插新」。
 *
 * `filter` 是删除条件 —— 它决定了"哪些行算是可以被重新解析覆盖的"，
 * 是本文件最重要的参数，见文件头三条规则。
 */
async function replaceAll<TOut>(
  supabase: SupabaseClient,
  table: 'grade_components' | 'course_outline_items' | 'exam_dates' | 'office_hours' | 'submission_policies',
  columns: string,
  filter: Record<string, string | boolean>,
  rows: Record<string, unknown>[],
  map: (row: unknown) => TOut,
): Promise<TOut[]> {
  let query = supabase.from(table).delete()
  for (const [column, value] of Object.entries(filter)) {
    query = query.eq(column, value)
  }
  const { error: deleteError } = await query
  if (deleteError) {
    throw deleteError
  }

  // 抽到 0 条：删完就结束，返回空数组（表示"原文确实没有这块内容"）。
  if (rows.length === 0) {
    return []
  }

  const { data, error } = await supabase.from(table).insert(rows).select(columns)
  if (error) {
    throw error
  }
  return ((data ?? []) as unknown[]).map(map)
}
