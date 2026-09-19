import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { importSyllabusFromCanvasFile } from '@/lib/syllabus-import/import'

/**
 * `POST /api/v1/courses/:id/syllabus/import` —— 把 Canvas 上已索引的**那一份**文件
 * 当成这门课的 syllabus 导入（P0-3-30 的第二个来源）。
 *
 * ### 与上传那条路的分工
 * 上传走「Storage + `raw_text`」；本路径走「按需下载 + 原文不落库」（ADR-026）。
 * 两条路的解析与落库是同一对函数，所以本端点的响应形状与 `/parse` 同构。
 *
 * ### 状态码（失败二分法，ADR-026 第 5 条）
 * - **409 `syllabus_exists`**：这门课已有另一份 syllabus，且没带 `replace: true`。
 *   **一行都没写** —— 不许静默覆盖（约束 3）。界面拿到它去弹确认。
 * - **422 `unsupported`** / **422 `import_failed`**：确定性失败（Tempo 读不了 /
 *   文件没文字层 / 目标行没了）→ **别再重试**。
 * - **502 `import_retryable`**：暂时性失败（Canvas 5xx / 网络 / 超时）→ 界面给"再试一次"。
 */

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id: courseId } = await params
    if (!UUID_PATTERN.test(courseId)) {
      return jsonError(request, 400, 'bad_request', '课程 ID 格式不正确')
    }

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

    const parsed = parseBody(body)
    if (!parsed.ok) {
      return jsonError(request, 400, 'bad_request', parsed.message)
    }

    const outcome = await importSyllabusFromCanvasFile({
      supabase,
      userId: user.id,
      courseId,
      courseFileId: parsed.value.courseFileId,
      replace: parsed.value.replace,
    })

    if (outcome.status === 'unsupported') {
      return jsonError(request, 422, 'unsupported', outcome.message)
    }
    if (outcome.status === 'needs_confirm') {
      return jsonError(request, 409, 'syllabus_exists', outcome.message)
    }
    if (outcome.status === 'failed') {
      return jsonError(
        request,
        outcome.retryable ? 502 : 422,
        outcome.retryable ? 'import_retryable' : 'import_failed',
        outcome.message,
      )
    }

    return jsonOk(request, {
      syllabus: outcome.syllabus,
      cached: outcome.cached,
      okSections: outcome.okSections,
      failedSections: outcome.failedSections,
      textLength: outcome.textLength,
      truncated: outcome.truncated,
      counts: outcome.counts,
    })
  } catch (error) {
    return internalError(request, error)
  }
}

/** 入参只有两个字段，`replace` 默认 false（默认不许覆盖已有的 syllabus）。 */
function parseBody(
  body: unknown,
): { ok: true; value: { courseFileId: string; replace: boolean } } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是一个 JSON 对象' }
  }
  const record = body as Record<string, unknown>
  const courseFileId = record.courseFileId
  if (typeof courseFileId !== 'string' || !UUID_PATTERN.test(courseFileId)) {
    return { ok: false, message: 'courseFileId 必须是文件 ID（UUID）' }
  }
  const replace = record.replace === true
  return { ok: true, value: { courseFileId, replace } }
}
