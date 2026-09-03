import { NextResponse } from 'next/server'

import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import {
  COURSE_OUTLINE_ITEM_COLUMNS,
  parseSaveCourseOutlineInput,
  toCourseOutlineItem,
  toCourseOutlineItemSaveInsert,
  toCourseOutlineItemSaveUpdate,
} from '@/lib/course-outline-items'
import type { CourseOutlineItemRow } from '@/lib/course-outline-items'
import {
  EXAM_DATE_COLUMNS,
  parseSaveExamDatesInput,
  toExamDate,
  toExamDateSaveInsert,
  toExamDateSaveUpdate,
} from '@/lib/exam-dates'
import type { ExamDateRow } from '@/lib/exam-dates'
import {
  GRADE_COMPONENT_COLUMNS,
  parseSaveGradeComponentsInput,
  toGradeComponent,
  toGradeComponentSaveInsert,
  toGradeComponentSaveUpdate,
} from '@/lib/grade-components'
import type { GradeComponentRow } from '@/lib/grade-components'
import {
  OFFICE_HOUR_COLUMNS,
  parseSaveOfficeHoursInput,
  toOfficeHour,
  toOfficeHourSaveInsert,
  toOfficeHourSaveUpdate,
} from '@/lib/office-hours'
import type { OfficeHourRow } from '@/lib/office-hours'
import {
  SUBMISSION_POLICY_COLUMNS,
  parseSaveSubmissionPoliciesInput,
  toSubmissionPolicy,
  toSubmissionPolicySaveInsert,
  toSubmissionPolicySaveUpdate,
} from '@/lib/submission-policies'
import type { SubmissionPolicyRow } from '@/lib/submission-policies'

import { buildAddCorrections, diffRows, writeCorrections } from '@/lib/parse/corrections'
import type { FieldSpec, SectionEntityType } from '@/lib/parse/corrections'
import { syncExamToTask } from '@/lib/sync/exam-tasks'

import type {
  SaveCourseOutlineItem,
  SaveExamDateItem,
  SaveGradeComponentItem,
  SaveOfficeHourItem,
  SaveSubmissionPolicyItem,
  StoredCourseOutlineItem,
  StoredExamDate,
  StoredGradeComponent,
  StoredOfficeHour,
  StoredSubmissionPolicy,
} from '@/types/sections'

/**
 * 五个板块保存端点的共用编排（P0-1-5b，API-Contract.md 第 4 节）。
 *
 * 语义是 **PUT 全量替换 + 幂等**：前端表单整板块提交，服务端以表单为准对齐库里：
 * - 带 `id` 且库里存在 → 整行内容以表单更新；
 * - 不带 `id` → 插入（`source = 'manual'`，活过重解析）；
 * - 库里有、表单里没有 → 删除；
 * - 与库中现有值的逐字段差异 → `parse_corrections`（`lib/parse/corrections.ts`）；
 * - `grade_components` / `exam_dates` 置 `is_confirmed = true`（保存 = 用户确认）。
 *
 * 路由文件只做一件事：把 URL 段名映射到对应板块的配置。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** 五张板块表名。 */
type SectionTable =
  | 'grade_components'
  | 'course_outline_items'
  | 'exam_dates'
  | 'office_hours'
  | 'submission_policies'

/**
 * 一个板块的保存配置。字段列表只列**参与 diff / 写修正**的内容字段 ——
 * `order_index`（大纲）由数组位置派生，不进修正（见 corrections.ts 文件头）。
 */
type SectionConfig<TStored extends { id: string }, TInput extends { id?: string }> = {
  table: SectionTable
  columns: string
  entityType: SectionEntityType
  parseInput: (body: unknown) => { ok: true; value: TInput[] } | { ok: false; message: string }
  toRow: (row: unknown) => TStored
  toInsert: (input: TInput, courseId: string, position: number) => Record<string, unknown>
  toUpdate: (input: TInput, position: number) => Record<string, unknown>
  fields: Array<FieldSpec<TStored, TInput>>
  /** 返回列表的排序列（大纲按 order_index，其余按创建顺序）。 */
  orderBy: string
  /** 保存后是否要做 exam → tasks 派生。 */
  syncExams: boolean
}

const GRADE_COMPONENTS: SectionConfig<StoredGradeComponent, SaveGradeComponentItem> = {
  table: 'grade_components',
  columns: GRADE_COMPONENT_COLUMNS,
  entityType: 'grade_component',
  parseInput: parseSaveGradeComponentsInput,
  toRow: (row) => toGradeComponent(row as GradeComponentRow),
  toInsert: toGradeComponentSaveInsert,
  toUpdate: toGradeComponentSaveUpdate,
  fields: [
    { column: 'name', get: (stored) => stored.name, pick: (input) => input.name },
    {
      column: 'weight_percent',
      get: (stored) => stored.weightPercent,
      pick: (input) => input.weightPercent,
    },
    { column: 'notes', get: (stored) => stored.notes, pick: (input) => input.notes },
  ],
  orderBy: 'created_at',
  syncExams: false,
}

const OUTLINE_ITEMS: SectionConfig<StoredCourseOutlineItem, SaveCourseOutlineItem> = {
  table: 'course_outline_items',
  columns: COURSE_OUTLINE_ITEM_COLUMNS,
  entityType: 'outline_item',
  parseInput: parseSaveCourseOutlineInput,
  toRow: (row) => toCourseOutlineItem(row as CourseOutlineItemRow),
  toInsert: toCourseOutlineItemSaveInsert,
  toUpdate: toCourseOutlineItemSaveUpdate,
  fields: [
    { column: 'week_label', get: (stored) => stored.weekLabel, pick: (input) => input.weekLabel },
    { column: 'topic', get: (stored) => stored.topic, pick: (input) => input.topic },
  ],
  orderBy: 'order_index',
  syncExams: false,
}

const EXAM_DATES: SectionConfig<StoredExamDate, SaveExamDateItem> = {
  table: 'exam_dates',
  columns: EXAM_DATE_COLUMNS,
  entityType: 'exam_date',
  parseInput: parseSaveExamDatesInput,
  toRow: (row) => toExamDate(row as ExamDateRow),
  toInsert: toExamDateSaveInsert,
  toUpdate: toExamDateSaveUpdate,
  fields: [
    { column: 'exam_name', get: (stored) => stored.examName, pick: (input) => input.examName },
    { column: 'exam_date', get: (stored) => stored.examDate, pick: (input) => input.examDate },
    { column: 'exam_time', get: (stored) => stored.examTime, pick: (input) => input.examTime },
    { column: 'location', get: (stored) => stored.location, pick: (input) => input.location },
  ],
  orderBy: 'created_at',
  syncExams: true,
}

const OFFICE_HOURS: SectionConfig<StoredOfficeHour, SaveOfficeHourItem> = {
  table: 'office_hours',
  columns: OFFICE_HOUR_COLUMNS,
  entityType: 'office_hour',
  parseInput: parseSaveOfficeHoursInput,
  toRow: (row) => toOfficeHour(row as OfficeHourRow),
  toInsert: toOfficeHourSaveInsert,
  toUpdate: toOfficeHourSaveUpdate,
  fields: [
    {
      column: 'person_name',
      get: (stored) => stored.personName,
      pick: (input) => input.personName,
    },
    {
      column: 'day_of_week',
      get: (stored) => stored.dayOfWeek,
      pick: (input) => input.dayOfWeek,
    },
    { column: 'start_time', get: (stored) => stored.startTime, pick: (input) => input.startTime },
    { column: 'end_time', get: (stored) => stored.endTime, pick: (input) => input.endTime },
    { column: 'location', get: (stored) => stored.location, pick: (input) => input.location },
  ],
  orderBy: 'created_at',
  syncExams: false,
}

const SUBMISSION_POLICIES: SectionConfig<StoredSubmissionPolicy, SaveSubmissionPolicyItem> = {
  table: 'submission_policies',
  columns: SUBMISSION_POLICY_COLUMNS,
  entityType: 'submission_policy',
  parseInput: parseSaveSubmissionPoliciesInput,
  toRow: (row) => toSubmissionPolicy(row as SubmissionPolicyRow),
  toInsert: toSubmissionPolicySaveInsert,
  toUpdate: toSubmissionPolicySaveUpdate,
  fields: [
    {
      column: 'description',
      get: (stored) => stored.description,
      pick: (input) => input.description,
    },
    {
      column: 'platform_name',
      get: (stored) => stored.platformName,
      pick: (input) => input.platformName,
    },
  ],
  orderBy: 'created_at',
  syncExams: false,
}

/** URL 段名（即路由目录名）。分发在 handleSectionSave 的 switch 里。 */
export type SaveableSection =
  | 'grade-components'
  | 'outline-items'
  | 'exam-dates'
  | 'office-hours'
  | 'submission-policies'

export async function handleSectionSave(
  request: Request,
  courseId: string,
  section: SaveableSection,
): Promise<NextResponse> {
  // 用 switch 而不是查表调用：config 对象各自实例化泛型，
  // 直接取联合值会让 TStored/TInput 退化成交集，TS 全线报错。
  switch (section) {
    case 'grade-components':
      return saveSection(request, courseId, GRADE_COMPONENTS)
    case 'outline-items':
      return saveSection(request, courseId, OUTLINE_ITEMS)
    case 'exam-dates':
      return saveSection(request, courseId, EXAM_DATES)
    case 'office-hours':
      return saveSection(request, courseId, OFFICE_HOURS)
    case 'submission-policies':
      return saveSection(request, courseId, SUBMISSION_POLICIES)
  }
}

async function saveSection<TStored extends { id: string }, TInput extends { id?: string }>(
  request: Request,
  courseId: string,
  config: SectionConfig<TStored, TInput>,
): Promise<NextResponse> {
  try {
    if (!UUID_PATTERN.test(courseId)) {
      return jsonError(request, 400, 'bad_request', '课程 ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    // 课程存在性 + 归属（ADR-010：越权与不存在统一 404）。
    // 归档课程不可编辑 —— 归档在本项目里就是"删除"（Database.md 4.4）。
    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('is_archived', false)
      .maybeSingle()
    if (!course) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }

    const parsed = config.parseInput(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }
    const inputs = parsed.value

    // ---------- 现有行 ----------
    const { data: existingRows, error: loadError } = await supabase
      .from(config.table)
      .select(config.columns)
      .eq('course_id', courseId)
    if (loadError) {
      throw loadError
    }
    const existing = (existingRows ?? []).map(config.toRow)

    // ---------- diff ----------
    const { corrections, unmatchedInputIds, deletedIds } = diffRows(
      existing,
      inputs,
      config.fields,
    )
    if (unmatchedInputIds.length > 0) {
      // 表单里带着库里已不存在的 id：大概率是并发修改 / 前端数据过期。
      // 静默当新增会造出重复行，明确拒绝让前端刷新重填。
      return jsonError(request, 400, 'validation_failed', '部分条目已不存在，请刷新页面后重试', {
        staleIds: unmatchedInputIds,
      })
    }

    // ---------- 插入（不带 id 的行）----------
    const toInsert = inputs
      .map((input, index) => ({ input, position: index + 1 }))
      .filter((entry) => entry.input.id === undefined)

    // PostgREST 按 insert 数组的顺序返回行；对不上数就抛错，绝不猜对应关系。
    const insertedRows: Array<{ id: string }> = []
    if (toInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from(config.table)
        .insert(toInsert.map((entry) => config.toInsert(entry.input, courseId, entry.position)))
        .select('id')
      if (insertError) {
        throw insertError
      }
      if ((inserted ?? []).length !== toInsert.length) {
        throw new Error(`${config.table}: 插入 ${toInsert.length} 行但只返回 ${(inserted ?? []).length} 行`)
      }
      insertedRows.push(...((inserted ?? []) as Array<{ id: string }>))
    }

    // 新增行的 add 修正（此刻才拿到行 id）。
    for (const [index, entry] of toInsert.entries()) {
      corrections.push(...buildAddCorrections(insertedRows[index].id, entry.input, config.fields))
    }

    // ---------- 更新（带 id 的行，整行以表单为准）----------
    // 串行：与 persist.ts 同一取舍 —— 行数少，换失败时状态确定。
    for (const [index, input] of inputs.entries()) {
      if (input.id === undefined) continue
      const { error: updateError } = await supabase
        .from(config.table)
        .update(config.toUpdate(input, index + 1))
        .eq('id', input.id)
        .eq('course_id', courseId)
      if (updateError) {
        throw updateError
      }
    }

    // ---------- 删除（表单里没有的行）----------
    if (deletedIds.length > 0) {
      const { error: deleteError } = await supabase
        .from(config.table)
        .delete()
        .in('id', deletedIds)
        .eq('course_id', courseId)
      if (deleteError) {
        throw deleteError
      }
    }

    // ---------- 修正落库（含归因）----------
    await writeCorrections({
      supabase,
      userId: user.id,
      courseId,
      entityType: config.entityType,
      corrections,
    })

    // ---------- 最终列表 ----------
    const finalRows = await loadSection(supabase, config, courseId)

    // ---------- exam → tasks 派生 ----------
    // 类型系统到不了这里：TStored 是泛型，但 syncExams 只有 EXAM_DATES 配置里是 true，
    // 此刻的 finalRows 必然是 StoredExamDate[]。用 as unknown 过桥，靠 config 单一来源保证。
    if (config.syncExams) {
      await syncExamToTask({ supabase, courseId, exams: finalRows as unknown as StoredExamDate[] })
    }

    return jsonOk(request, { data: finalRows })
  } catch (error) {
    return internalError(request, error)
  }
}

/** 重新拉取该板块的完整最新列表（响应体）。只用到 config 的读取相关字段。 */
async function loadSection<TStored extends { id: string }>(
  supabase: SupabaseClient,
  config: Pick<SectionConfig<TStored, never>, 'table' | 'columns' | 'orderBy' | 'toRow'>,
  courseId: string,
): Promise<TStored[]> {
  const { data, error } = await supabase
    .from(config.table)
    .select(config.columns)
    .eq('course_id', courseId)
    .order(config.orderBy, { ascending: true })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => config.toRow(row))
}
