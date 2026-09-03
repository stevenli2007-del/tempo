import { handleParseRequest } from '@/lib/parse/endpoint'

/**
 * `POST /api/v1/syllabi/:id/reparse` —— 用现有 `raw_text` 强制重跑解析（P0-1-5a）。
 *
 * 与 `/parse` 的唯一区别：**无视 `parseStatus`，一定重跑**。
 * 典型场景是换了 LLM provider（ADR-003 的复审动作）或升了 `PROMPT_VERSION` 之后，
 * 需要拿新配置把历史 syllabus 重新过一遍。
 *
 * 审计上两者可区分：`llm_runs.purpose` 前缀是 `syllabus_reparse`（首次解析是 `syllabus_parse`）。
 *
 * 越权判定见 ADR-010：统一 404。
 */

export const maxDuration = 60

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params
  return handleParseRequest(request, id, 'reparse')
}
