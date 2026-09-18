import { applyCourseUpdate, summarizeApply } from '@/lib/course-update/apply'
import { validateApplyBody } from '@/lib/course-update/normalize'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * `POST /api/v1/course-updates` —— 对话编排的**确认写入**端点（P0-3-24）。
 *
 * ### 🔴 解析 ≠ 落库（红线，与 `/tasks/parse` 同源）
 * `/tasks/parse` 只产预览（跑 LLM、不写任何表）；本端点是**唯一**把预览变成数据的地方，
 * 而且只在用户点「确认」之后才被调用。任何"解析完顺手写掉"的路径都不存在（ADR-015）。
 *
 * ### 为什么不是复用 `PUT /api/v1/courses/:id/exam-dates`
 * 那个端点是 **PUT 全量替换**（表单里没有的行会被删）。对话输入是"我又说了点什么"，
 * 用全量替换会把已有条目删掉 —— 那是用户完全不会预期的不可逆丢失。
 * 本端点**只追加**（`lib/course-update/apply.ts` 文件头有完整理由）。
 *
 * ### 归属校验
 * 即便 RLS 会拦，仍显式校验课程属于当前用户的**未归档**课程 ——
 * 早失败、给清晰报错（ADR-010：越权与不存在统一 404）。
 *
 * 请求体：`{ courseId, exams?: [...], gradeComponents?: [...] }`
 * 响应：`{ data: { exams, gradeComponents, weightWarnings, summary } }`
 */

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

    const parsed = validateApplyBody(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'validation_failed', parsed.message)
    }

    try {
      const result = await applyCourseUpdate(supabase, parsed.value)
      return jsonOk(request, {
        data: { ...result, summary: summarizeApply(result) },
      })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'not_found') {
        return jsonError(request, 404, 'not_found', (error as Error).message)
      }
      throw error
    }
  } catch (error) {
    return internalError(request, error)
  }
}
