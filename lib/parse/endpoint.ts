import { NextResponse } from 'next/server'

import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { SYLLABUS_COLUMNS, SYLLABUS_COLUMNS_WITH_TEXT, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow, SyllabusRowWithText } from '@/lib/syllabi'

import { parseSyllabusSections } from './index'
import { persistParsedSections } from './persist'

import type { ParseSection } from '@/types/parse'
import type { Syllabus, SyllabusParseResponse } from '@/types/syllabus'

/**
 * `/parse` 与 `/reparse` 共用的处理逻辑（P0-1-5a）。
 *
 * **两个端点的唯一区别**：
 * - `parse` —— 首次解析。`parseStatus` 已是 `completed` 时返回 **409 `already_parsed`**，
 *   不再烧一次 LLM（重跑请走 `/reparse`）。
 * - `reparse` —— 强制重跑，无视现有状态。用于换了 provider 或改了 prompt 之后。
 *
 * 两者写 `llm_runs.purpose` 的前缀不同（`syllabus_parse` / `syllabus_reparse`），
 * 这样"这次改动是变准了还是变糟了"可以按 purpose 分组对比。
 *
 * **同步返回 200，不是 202**（ADR-012）：实测五板块并发 3.2 秒，走异步编排需要
 * 额外的进度存储字段 + Vercel 后台执行兜底，代价远超收益。
 */

export type ParseMode = 'parse' | 'reparse'

/** 文本没提取好就调解析。契约里没有这个分支，按 file_missing 的先例用 409。 */
const TEXT_NOT_READY_MESSAGE = '这份 syllabus 的文本还没提取好，请先完成文本提取再解析。'

export async function handleParseRequest(
  request: Request,
  id: string,
  mode: ParseMode,
): Promise<NextResponse> {
  try {
    if (!UUID_PATTERN.test(id)) {
      return jsonError(request, 400, 'bad_request', 'Syllabus ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { data, error } = await supabase
      .from('syllabi')
      .select(SYLLABUS_COLUMNS_WITH_TEXT)
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw error
    }
    if (!data) {
      return jsonError(request, 404, 'not_found', 'Syllabus 不存在或无权访问')
    }

    const row = data as SyllabusRowWithText

    if (mode === 'parse' && row.parse_status === 'completed') {
      return jsonError(
        request,
        409,
        'already_parsed',
        '这份 syllabus 已经解析完成。要重新解析（例如换过模型或改过 prompt）请调用 /reparse。',
      )
    }

    if (row.extract_status !== 'extracted' || (row.raw_text ?? '').trim() === '') {
      return jsonError(request, 409, 'text_not_ready', TEXT_NOT_READY_MESSAGE)
    }

    // 课程信息只是给模型的消歧上下文（主要是考试日期的年份锚点），
    // 拿不到就空着 —— 少一点上下文不会让解析失败，多一次 404 会。
    const context = await loadCourseContext(supabase, row.course_id)

    const result = await parseSyllabusSections({
      userId: user.id,
      syllabusId: row.id,
      rawText: row.raw_text,
      context,
      purposePrefix: mode === 'reparse' ? 'syllabus_reparse' : 'syllabus_parse',
    })

    const sections = await persistParsedSections({
      supabase,
      courseId: row.course_id,
      sections: result.sections,
    })

    const syllabus = await markParseResult(supabase, id, result)

    return jsonOk(request, {
      syllabus,
      sections,
      okSections: result.okSections,
      failedSections: result.failedSections,
      meta: result.meta,
    } satisfies SyllabusParseResponse)
  } catch (error) {
    return internalError(request, error)
  }
}

/** 取课程名等信息给模型做消歧。查不到返回空对象，不阻断解析。 */
async function loadCourseContext(
  supabase: Awaited<ReturnType<typeof getCurrentUser>>['supabase'],
  courseId: string,
): Promise<{ courseName?: string; courseCode?: string; semester?: string; instructorName?: string }> {
  const { data } = await supabase
    .from('courses')
    .select(COURSE_COLUMNS)
    .eq('id', courseId)
    .maybeSingle()

  if (!data) return {}
  const course = toCourse(data as CourseRow)
  return {
    courseName: course.courseName,
    courseCode: course.courseCode ?? undefined,
    semester: course.semester,
    instructorName: course.instructorName ?? undefined,
  }
}

/**
 * 写回解析状态。
 *
 * ⚠️ **`parse_status` 只取 `completed` / `failed` 两态**：
 * 契约 §3 里出现的 `partial` **不在 DB 的 CHECK 约束里**（`pending/processing/completed/failed`），
 * 用它会直接被数据库拒绝。部分失败的表达方式改为：
 * `parse_status = 'completed'` + `parse_error` 写明失败了几块、是哪几块，
 * 前端则看响应里的 `failedSections` 渲染"未能解析，请手动补充"。
 */
async function markParseResult(
  supabase: Awaited<ReturnType<typeof getCurrentUser>>['supabase'],
  id: string,
  result: Awaited<ReturnType<typeof parseSyllabusSections>>,
): Promise<Syllabus> {
  const allFailed = result.okSections.length === 0

  const { data, error } = await supabase
    .from('syllabi')
    .update({
      parse_status: allFailed ? 'failed' : 'completed',
      parse_error: buildParseError(result),
    })
    .eq('id', id)
    .select(SYLLABUS_COLUMNS)
    .maybeSingle()

  if (error) {
    throw error
  }
  if (!data) {
    throw new Error(`syllabi ${id} 在写回解析状态时已不存在`)
  }
  return toSyllabus(data as SyllabusRow)
}

/** 失败板块的一句话摘要，进 `syllabi.parse_error` 给用户看。 */
function buildParseError(result: Awaited<ReturnType<typeof parseSyllabusSections>>): string | null {
  const failed = result.failedSections
  if (failed.length === 0) return null

  const names = failed.map((item) => SECTION_LABEL[item.section]).join('、')
  return `${failed.length} 个板块解析失败（${names}）：${failed[0].message}`
}

const SECTION_LABEL: Record<ParseSection, string> = {
  gradeComposition: '成绩构成',
  courseOutline: '课程大纲',
  testDates: '考试日期',
  officeHours: 'Office Hour',
  submissionPolicy: '提交政策',
}
