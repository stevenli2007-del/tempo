/**
 * 课程更新解析端点（P0-3-8 文本档）。
 *
 * `POST /api/v1/tasks/parse` —— 收 `{ text, courseId }`，把用户粘贴的零散课程更新
 * （作业 / 阅读 / 项目截止等）交给 LLM 解析成结构化任务预览。**不落库**：
 * 只返回解析结果，由前端展示给用户确认后，再走 `POST /api/v1/tasks` 真正写入。
 *
 * ### 🔴 解析 ≠ 落库（红线）
 * 对话输入没有 `sourceExcerpt` 之类可核对的锚点，幻觉会直接进日程。
 * 所以这里**只产出预览**，确认动作在另一个端点完成（ADR-016：对话框是兜底不是入口）。
 *
 * ### 考试变更不在这里处理
 * exam 是 `exam_dates` 的权威派生（ADR-004）。schema 只允许 `assignment` / `reading` /
 * `other`；若文本明显是考试日期变更，模型放入 `warnings` 并提示「请到课程页更新」，
 * 不生成 exam 任务，避免和派生逻辑打架。
 */

import type { JSONSchema, LLMMessage } from '@/lib/llm'
import { runStructured } from '@/lib/llm/run'
import { loadActiveCourseIds } from '@/lib/tasks'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PARSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: '从文本中识别出的可添加任务',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简洁的中文任务标题，去掉营销腔与废话' },
          taskType: {
            type: 'string',
            enum: ['assignment', 'reading', 'other'],
            description: 'assignment=作业/项目/论文；reading=阅读；other=其他待办。绝不填 exam',
          },
          dueDate: {
            type: ['string', 'null'],
            description: '截止日期。文字给了具体月日（如 9/20、12月10日、Oct 5）就按 M/D 返回（如 9/20）；完全没有任何日期信息才填 null；不要自补 4 位年份（年份由系统按当前学年推断）',
          },
          notes: {
            type: ['string', 'null'],
            description: '补充说明（提交方式 / 字数 / 平台等），可空',
          },
        },
        required: ['title', 'taskType', 'dueDate', 'notes'],
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: '无法转成任务的事项：考试日期变更、歧义、与课程无关的内容等',
    },
  },
  required: ['tasks', 'warnings'],
}

const SYSTEM_PROMPT = `你是 Tempo 的课程更新解析器。用户会粘贴一段关于某门课的课程更新文字（可能是作业、阅读、项目、论文的截止信息，也可能夹杂考试安排）。请把它解析成结构化任务列表。

规则：
1. 只产出 assignment（作业/项目/论文）、reading（阅读）、other（其他待办）三类任务；**绝不**产出 exam 类型——考试日期是课程的权威数据，必须在课程页修改。若文字明显是考试日期/时间变更，不要生成任务，而是放进 warnings 并写「考试日期变更请到课程页更新」。
2. dueDate：文字给了月日（9/20、12月10日、Oct 5 等）一律返回 M/D（如 9/20）；禁止自补 4 位年份（年份由系统按当前学年推断）；只有文字完全没有任何日期信息时才填 null（严禁编造）。
3. title 简洁、去废话；notes 可补充提交方式/字数等，没有就填 null。
4. 输出必须严格符合 JSON schema，不要输出任何解释性文字。`

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

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ]

    const result = await runStructured<{
      tasks: Array<{ title: string; taskType: string; dueDate: string | null; notes: string | null }>
      warnings: string[]
    }>({
      userId: user.id,
      purpose: 'course_update_parse',
      promptVersion: 'v1',
      schema: PARSE_SCHEMA,
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
