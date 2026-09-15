/**
 * 课程更新截图解析端点（P0-3-9 截图档，关闭 O-11 / 解决 O-08）。
 *
 * `POST /api/v1/tasks/parse-image` —— 收 `{ courseId, image: { mediaType, dataBase64 } }`，
 * 用多模态 LLM（默认 **Qwen 通义千问，中国区 DashScope**，[ADR-018](../../../docs/Decisions.md#adr-018)）从截图里识别
 * 课程更新。与 `/parse`（文本档）**同形状**响应（`{ data: { tasks, warnings } }`），
 * 下半段（先检索 → 消歧 → 确认 → 落写）完全复用。
 *
 * ### 🔴 截图只写 `status`（经 PATCH，用户主权）
 * 响应里带 `submitted` 信号（识别到「已提交 / 提交成功页」），但**本端点不落库任何东西** ——
 * 它只产预览，落写由用户确认后走 `POST /tasks` / `PATCH /tasks/:id`。`submitted` 只用于
 * 前端把「已提交」的任务默认勾成「标记完成」。`submission_state` / `submitted_at`
 * 是 Canvas 外部真相、仅同步可写（ADR-015），截图**绝不**产生这两列。
 *
 * ### 🔴 fail closed
 * 视觉未配置（`DASHSCOPE_API_KEY` 缺失）/ 超时 / 调用失败 → 一律明确报错「截图识别暂不可用」，
 * **不允许**静默降级成"没识别出任务"（那会把"服务坏了"伪装成"你这张图没内容"，与 §10.1 第 17 条同源）。
 *
 * ### 截图不落库
 * 图片由浏览器压缩后 base64 直传，服务端即用即弃（见 P0-3-9 执行卡）。不写 Storage。
 */

import type { JSONSchema, LLMMessage } from '@/lib/llm'
import { runStructured } from '@/lib/llm/run'
import { loadActiveCourseIds } from '@/lib/tasks'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 服务端硬闸：即便客户端没压缩也兜得住。

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const BASE64_PATTERN = /^[A-Za-z0-9+/=_-]+$/

const PARSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: '从截图中识别出的可添加 / 可更新的任务',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简洁的中文任务标题，如「Homework 6」' },
          taskType: {
            type: 'string',
            enum: ['assignment', 'reading', 'other'],
            description: 'assignment=作业/项目/论文；reading=阅读；other=其他待办。绝不填 exam',
          },
          dueDate: {
            type: ['string', 'null'],
            description: '截止日期。截图给了具体月日（如 9/20、12月10日）就按 M/D 返回；完全没日期信息才填 null；不要自补 4 位年份（年份由系统按当前学年推断）',
          },
          submitted: {
            type: ['boolean', 'null'],
            description: '是否识别到「已提交 / 提交成功页 / 打勾已完成」。明确是提交成功页 → true；明确是未交的待办清单 → false；看不出来 → null。这是给用户的提示，不是绝对真相',
          },
          notes: {
            type: ['string', 'null'],
            description: '补充说明（提交平台 / 分数 / 字数等），可空',
          },
        },
        required: ['title', 'taskType', 'dueDate', 'submitted', 'notes'],
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: '无法转成任务的事项：考试日期、歧义、与课程无关的内容等',
    },
  },
  required: ['tasks', 'warnings'],
}

const SYSTEM_PROMPT = `你是 Tempo 的课程更新截图解析器。用户会发来一张课程相关截图（可能是作业提交成功页、待办清单、Gradescope 页面、阅读列表等）。请从中识别课程更新并解析成结构化任务。

规则：
1. 只产出 assignment（作业/项目/论文）、reading（阅读）、other（其他待办）三类；**绝不**产出 exam 类型——考试日期是课程的权威数据，必须在课程页修改。若截图明显是考试安排/日期，不要生成任务，放进 warnings 写「考试日期请到课程页更新」。
2. dueDate：截图给了月日（9/20、12月10日 等）一律返回 M/D（如 9/20）；禁止自补 4 位年份（年份由系统按当前学年推断）；只有完全没有任何日期信息时才填 null（严禁编造）。
3. submitted：识别到「已提交 / 提交成功 / 打勾已完成 / Submitted / Turned in」这类信号 → true；识别到「待提交 / 未交 / 截止还有 N 天」这类待办 → false；信号不明显 → null。这只作提示，不代表绝对真相。
4. title 简洁、去废话；notes 可补充提交平台/分数等，没有就填 null。
5. 输出必须严格符合 JSON schema，不要输出任何解释性文字。`

type ImageInput = { mediaType: string; dataBase64: string }

function parseImage(raw: unknown): { ok: true; image: ImageInput } | { ok: false; code: string; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'bad_request', message: 'image 必须是对象 { mediaType, dataBase64 }' }
  }
  const img = raw as Record<string, unknown>
  const mediaType = typeof img.mediaType === 'string' ? img.mediaType : ''
  const dataBase64 = typeof img.dataBase64 === 'string' ? img.dataBase64 : ''

  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return { ok: false, code: 'bad_request', message: '仅支持 PNG / JPEG / WebP 截图' }
  }
  if (!BASE64_PATTERN.test(dataBase64)) {
    return { ok: false, code: 'bad_request', message: 'image.dataBase64 不是合法的 base64' }
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(dataBase64, 'base64')
  } catch {
    return { ok: false, code: 'bad_request', message: 'image.dataBase64 解码失败' }
  }
  if (bytes.length === 0) {
    return { ok: false, code: 'bad_request', message: '截图内容为空' }
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, code: 'bad_request', message: '截图过大（上限 5MB），请压缩后重试' }
  }
  return { ok: true, image: { mediaType, dataBase64 } }
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
    if (typeof body !== 'object' || body === null) {
      return jsonError(request, 400, 'bad_request', '请求体必须是 JSON 对象')
    }
    const raw = body as Record<string, unknown>

    const courseId = typeof raw.courseId === 'string' ? raw.courseId : ''
    if (!UUID_PATTERN.test(courseId)) {
      return jsonError(request, 400, 'bad_request', 'courseId 格式不正确')
    }

    const image = parseImage(raw.image)
    if (!image.ok) {
      return jsonError(request, 400, image.code, image.message)
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
      {
        role: 'user',
        content: [
          { type: 'text', text: '请解析这张课程截图。' },
          {
            type: 'image',
            mediaType: image.image.mediaType as 'image/png' | 'image/jpeg' | 'image/webp',
            dataBase64: image.image.dataBase64,
          },
        ],
      },
    ]

    const result = await runStructured<{
      tasks: Array<{
        title: string
        taskType: string
        dueDate: string | null
        submitted: boolean | null
        notes: string | null
      }>
      warnings: string[]
    }>({
      userId: user.id,
      purpose: 'course_update_vision',
      promptVersion: 'v1',
      capability: 'vision',
      schema: PARSE_SCHEMA,
      schemaName: 'CourseUpdateParse',
      messages,
      temperature: 0,
    })

    if (!result.ok) {
      // fail closed：明确告诉用户「识别服务不可用」，而不是「没识别出任务」。
      return jsonError(
        request,
        502,
        'llm_vision_failed',
        '截图识别服务暂不可用（可能是未配置视觉模型或网络问题），请改用文字输入或稍后重试',
        { reason: result.error.code },
      )
    }

    return jsonOk(request, { data: result.data })
  } catch (error) {
    return internalError(request, error)
  }
}
