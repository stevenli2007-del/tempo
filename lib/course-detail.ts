import { loadCourseSections } from '@/lib/sections'
import { SYLLABUS_COLUMNS, toSyllabus } from '@/lib/syllabi'
import type { SyllabusRow } from '@/lib/syllabi'
import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { createClient } from '@/lib/supabase/server'
import type { CourseDetail } from '@/types/course'

/**
 * 课程详情的合成读取（P0-1-8，API-Contract.md §2 的 `GET /api/v1/courses/:id`）。
 *
 * **同时被 API 路由和详情页的服务端组件使用** —— 读逻辑只有一份，
 * 不存在「页面一套查询、接口另一套查询」的漂移。页面走直查而不是 fetch 自己的 API
 * （RLS 已保证归属，省一次 HTTP 往返）。
 *
 * 归档课程当不存在（`is_archived = false`）—— 归档在本项目里就是删除（Database.md 4.4），
 * 与 P0-1-5b 的保存端点（归档 → 404）同一条语义。
 */

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

export type LoadCourseDetailResult =
  | { found: true; detail: CourseDetail; error: null }
  | { found: false; detail: null; error: null }
  | { found: false; detail: null; error: string }

export async function loadCourseDetail(
  supabase: ServerSupabase,
  courseId: string,
): Promise<LoadCourseDetailResult> {
  const { data, error } = await supabase
    .from('courses')
    .select(COURSE_COLUMNS)
    .eq('id', courseId)
    .eq('is_archived', false)
    .maybeSingle()

  if (error) {
    return { found: false, detail: null, error: error.message }
  }
  if (!data) {
    // ADR-010：不存在与「不是你的」统一表现（RLS 让越权的行根本查不出来）。
    return { found: false, detail: null, error: null }
  }

  const course = toCourse(data as CourseRow)

  // 最新一份 syllabus（一门课可以有多份，详情页展示最新的）。
  const { data: syllabusRows, error: syllabusError } = await supabase
    .from('syllabi')
    .select(SYLLABUS_COLUMNS)
    .eq('course_id', courseId)
    .order('uploaded_at', { ascending: false })
    .limit(1)

  if (syllabusError) {
    return { found: false, detail: null, error: syllabusError.message }
  }

  const { byCourse, error: sectionsError } = await loadCourseSections(supabase, [courseId])
  if (sectionsError) {
    return { found: false, detail: null, error: sectionsError }
  }
  const sections = byCourse.get(courseId)

  return {
    found: true,
    error: null,
    detail: {
      ...course,
      syllabus: syllabusRows && syllabusRows.length > 0 ? toSyllabus(syllabusRows[0] as SyllabusRow) : null,
      // 板块缺失给 [] 而不是 null（契约 §2：前端按 TBD 渲染）。
      gradeComponents: sections?.gradeComposition ?? [],
      outlineItems: sections?.courseOutline ?? [],
      examDates: sections?.testDates ?? [],
      officeHours: sections?.officeHours ?? [],
      submissionPolicies: sections?.submissionPolicy ?? [],
    },
  }
}
