/**
 * 任务候选检索（P0-3-8b）。
 *
 * `GET /api/v1/tasks/search?courseId=<uuid>&q=<标题文本>&limit=5`
 *
 * 对话框「用户输入 → **先检索现有任务**」的服务端一半：给定课程 + 一段标题文本，
 * 返回该课里最像的现有任务，交前端列举给用户确认「要改哪条」。
 *
 * ### 🔴 检索是确定性的，不用 LLM
 * LLM 只负责从自由文本里抽出「说的是哪个标题」（`POST /api/v1/tasks/parse`）；
 * 「哪条任务叫这个标题」由 `lib/tasks/match.ts` 的纯函数算 —— 可复现、可审计，
 * 不会幻觉出不存在的任务 id。因此本端点**不写 `llm_runs`、不花 token、无温度可调**。
 *
 * ### 只检索、不判定
 * 端点把 manual / canvas / syllabus 各来源的候选**一并返回**，由前端决定谁能改：
 * 只有 `source='manual'` 可改；canvas 内容会被同步覆盖、考试归 `exam_dates`（ADR-004）。
 * 服务端不替前端做这个产品判断，但**也不隐藏**候选 —— 隐藏会让用户以为"没这条任务"。
 *
 * ### 路径说明
 * 与 `[id]/route.ts` 同层：Next 的静态段优先于动态段，`/tasks/search` 命中本文件，
 * 不会被当成 id 为 "search" 的单条请求。
 */

import { loadActiveCourseIds, loadTasksByCourse } from '@/lib/tasks'
import { DEFAULT_MATCH_LIMIT, matchTasks } from '@/lib/tasks/match'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LIMIT = 20

export async function GET(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const params = new URL(request.url).searchParams
    const courseId = params.get('courseId') ?? ''
    const q = (params.get('q') ?? '').trim()

    if (!UUID_PATTERN.test(courseId)) {
      return jsonError(request, 400, 'bad_request', 'courseId 格式不正确')
    }
    // 空查询词不是错误：前端在解析结果还没回来时可能先打一枪。返回空候选即可。
    if (q === '') {
      return jsonOk(request, { data: [] })
    }

    let limit = DEFAULT_MATCH_LIMIT
    const limitRaw = params.get('limit')
    if (limitRaw !== null && limitRaw !== '') {
      if (!/^\d+$/.test(limitRaw)) {
        return jsonError(request, 400, 'bad_request', 'limit 必须是非负整数')
      }
      const parsed = Number(limitRaw)
      if (parsed < 1 || parsed > MAX_LIMIT) {
        return jsonError(request, 400, 'bad_request', `limit 必须在 1 到 ${MAX_LIMIT} 之间`)
      }
      limit = parsed
    }

    // 课程归属：只接受当前用户未归档的课程（归档后该课任务不可见，契约 §2）。
    const { ids, error: courseError } = await loadActiveCourseIds(supabase)
    if (courseError) {
      throw new Error(courseError)
    }
    if (!ids.includes(courseId)) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    const { candidates, error } = await loadTasksByCourse(supabase, courseId)
    if (error) {
      throw new Error(error)
    }

    const matches = matchTasks(q, candidates, { limit })
    return jsonOk(request, { data: matches })
  } catch (error) {
    return internalError(request, error)
  }
}
