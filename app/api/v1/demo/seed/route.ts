import { COURSE_COLUMNS, toCourse } from '@/lib/courses'
import type { CourseRow } from '@/lib/courses'
import { DEMO_COURSE, toDemoSectionsResult } from '@/lib/demo/seed-data'
import { persistParsedSections } from '@/lib/parse/persist'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * Demo Workspace 播种端点（P0-1-10，契约 §8）。
 *
 * 复制一份预置示例课程（CHEM 1A Fall 2026，含真实解析出的五板块 + 派生考试任务），
 * 标记 `is_demo = true`。重复调用返回 `409 already_linked`。
 *
 * ⚠️ **不调 LLM**：五板块是 `lib/demo/seed-data.ts` 里固化的真实解析结果，
 * 直接复用 `persistParsedSections` 落库 + `syncExamToTask` 派生任务，
 * 与正常上传解析走同一套落库/派生逻辑（单一事实源）。
 */
export async function POST(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    // 重复 seed 保护：已存在 demo 课程 → 409。
    const { data: existing, error: listError } = await supabase
      .from('courses')
      .select('id')
      .eq('is_demo', true)
    if (listError) {
      throw listError
    }
    if ((existing ?? []).length > 0) {
      return jsonError(request, 409, 'already_linked', '示例工作区已经生成，无需重复创建')
    }

    // 1) 建 demo 课程（is_demo = true）。
    const { data: course, error: insertError } = await supabase
      .from('courses')
      .insert({
        user_id: user.id,
        semester: DEMO_COURSE.semester,
        course_name: DEMO_COURSE.courseName,
        course_code: DEMO_COURSE.courseCode,
        instructor_name: DEMO_COURSE.instructorName,
        is_demo: true,
      })
      .select(COURSE_COLUMNS)
      .single()
    if (insertError) {
      throw insertError
    }
    const courseId = (course as CourseRow).id

    // 2) 落五板块 + 派生 exam tasks。失败则尽力回滚课程，避免留下半截 demo（会卡住重试的 409）。
    try {
      await persistParsedSections({
        supabase,
        courseId,
        sections: toDemoSectionsResult(),
      })

      // 3) 记 profiles.demo_seeded_at，供 UI 判断「是否展示清空入口」。
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ demo_seeded_at: new Date().toISOString() })
        .eq('id', user.id)
      if (profileError) {
        throw profileError
      }
    } catch (error) {
      await supabase.from('courses').delete().eq('id', courseId)
      throw error
    }

    return jsonOk(request, toCourse(course as CourseRow), 201)
  } catch (error) {
    return internalError(request, error)
  }
}
