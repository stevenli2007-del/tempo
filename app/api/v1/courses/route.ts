import { COURSE_COLUMNS, parseCreateCourseInput, toCourse, toCourseInsert } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { loadUpcomingTasks } from '@/lib/tasks'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * 课程集合端点（API-Contract.md 第 2 节）。
 *
 * GET  列出当前用户未归档的全部课程（扁平数组，前端按学期分组展示），
 *      每门课附带 `upcomingTasks`（P0-1-9 补齐契约 §2 里早就声明但一直没返回的字段）
 * POST 新建课程（新课程没有任务，响应里不带 `upcomingTasks`）
 */

export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { data, error } = await supabase
      .from('courses')
      .select(COURSE_COLUMNS)
      .eq('is_archived', false)
      .order('created_at', { ascending: true })

    if (error) {
      throw error
    }

    const courses = ((data ?? []) as CourseRow[]).map(toCourse)

    // 每门课的近期任务：一次查齐再按课程分桶，不给每门课发一次查询。
    const { byCourse, error: tasksError } = await loadUpcomingTasks(
      supabase,
      courses.map((course) => course.id),
    )
    if (tasksError) {
      throw new Error(tasksError)
    }
    for (const course of courses) {
      course.upcomingTasks = byCourse.get(course.id) ?? []
    }

    return jsonOk(request, { data: courses, meta: { total: courses.length } })
  } catch (error) {
    return internalError(request, error)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(request, 400, 'bad_request', '请求体不是合法的 JSON')
    }

    const parsed = parseCreateCourseInput(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }

    // user_id 必须是会话里的用户：courses 的 RLS 用 WITH CHECK (auth.uid() = user_id) 卡着。
    const { data, error } = await supabase
      .from('courses')
      .insert({ ...toCourseInsert(parsed.value), user_id: user.id })
      .select(COURSE_COLUMNS)
      .single()

    if (error) {
      throw error
    }

    return jsonOk(request, toCourse(data as CourseRow), 201)
  } catch (error) {
    return internalError(request, error)
  }
}
