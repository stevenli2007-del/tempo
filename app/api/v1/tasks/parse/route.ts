/**
 * 课程更新解析端点（P0-3-8 文本档，P0-3-24 解禁 exam 产出）。
 *
 * `POST /api/v1/tasks/parse` —— 收 `{ text, courseId }`，把用户粘贴的零散课程更新
 * （作业 / 阅读 / 项目截止 / **考试安排** / **成绩构成**）交给 LLM 解析成结构化预览。
 * **不落库**：只返回解析结果，由前端展示给用户确认后，再走 `POST /api/v1/course-updates`
 * 真正写入（ADR-015）。
 *
 * ### 🔴 解析 ≠ 落库（红线）
 * 对话输入没有可核对锚点时，幻觉会直接进日程。所以这里**只产出预览**，
 * 确认动作在另一个端点完成（ADR-016：对话框是兜底不是入口）。
 *
 * ### P0-3-24：exam 解禁了，但**不是无条件解禁**
 * 原先规则 1 写死「绝不产出 exam」（ADR-004 防幻觉），导致 Galen Quiz Dates 这类
 * 纯净的考试日期粘贴只产出一条 warning，用户只能手动去课程页重填六行。
 * ADR-021 的侦察结论：**数据模型早支持**（`exam_dates` / `grade_components` 都有
 * `source` + `source_excerpt` + `is_confirmed`），缺的只是产出通道。
 *
 * 解禁的**对价**是两条硬约束（缺一条就退回禁令）：
 * 1. **每条 exam / gradeComponent 必须带 `sourceExcerpt`** —— 逐字原文摘录。
 *    没有摘录的条目会被 `validateExamInput()` 直接拒掉（不是留空），
 *    「没有锚点的考试日期」等价于幻觉，与 ADR-004 的初衷一致。
 * 2. **写入仍走确认通道** —— 本端点照旧不落库；写入器只追加不替换
 *    （`lib/course-update/apply.ts`）。
 */

import { runStructured } from '@/lib/llm/run'
import { loadActiveCourseIds } from '@/lib/tasks'
import { COURSE_UPDATE_PARSE_SCHEMA } from '@/lib/course-update/normalize'
import { COURSE_UPDATE_PROMPT_VERSION, buildCourseUpdateMessages } from '@/lib/course-update/prompt'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }
    const raw = body as Record<string, unknown>

    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const courseId = typeof raw.courseId === 'string' ? raw.courseId : ''
    if (text === '') {
      return jsonError(request, 400, 'bad_request', 'text 不能为空')
    }
    if (!UUID_PATTERN.test(courseId)) {
      return jsonError(request, 400, 'bad_request', 'courseId 格式不正确')
    }

    // 课程归属校验：只接受当前用户未归档的课程。
    const { ids, error: courseError } = await loadActiveCourseIds(supabase)
    if (courseError) {
      throw new Error(courseError)
    }
    if (!ids.includes(courseId)) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    const messages = buildCourseUpdateMessages(text)

    const result = await runStructured<{
      tasks: Array<{ title: string; taskType: string; dueDate: string | null; notes: string | null }>
      exams: Array<{
        examName: string
        examDate: string | null
        examTime: string | null
        location: string | null
        sourceExcerpt: string
      }>
      gradeComponents: Array<{
        name: string
        weightPercent: number | null
        notes: string | null
        sourceExcerpt: string
      }>
      warnings: string[]
    }>({
      userId: user.id,
      purpose: 'course_update_parse',
      // 版本与 prompt 一起放在 `lib/course-update/prompt.ts`（离线探针脚本共用同一份）。
      promptVersion: COURSE_UPDATE_PROMPT_VERSION,
      schema: COURSE_UPDATE_PARSE_SCHEMA,
      schemaName: 'CourseUpdateParse',
      messages,
      temperature: 0,
    })

    if (!result.ok) {
      // LLM 失败：给前端一个可理解的报错，不把内部错误码裸奔出去。
      return jsonError(request, 502, 'llm_failed', '解析服务暂时不可用，请稍后重试或手动添加', {
        reason: result.error.code,
      })
    }

    return jsonOk(request, { data: result.data })
  } catch (error) {
    return internalError(request, error)
  }
}
