import { handleParseRequest } from '@/lib/parse/endpoint'

/**
 * `POST /api/v1/syllabi/:id/parse` —— 上传流程的第 4 拍（P0-1-5a）。
 *
 * 完整流程现在是四拍（ADR-009 + ADR-012）：
 *   1. `POST /api/v1/courses/:id/syllabus`  → 取票据 + 建行
 *   2. 浏览器 `uploadToSignedUrl`           → 直传 Storage
 *   3. `POST /api/v1/syllabi/:id/extract`   → 提取文本
 *   4. **本端点**                            → LLM 五板块抽取 + 落库
 *
 * **同步返回 200，不是 202**（ADR-012）：实测五板块并发 3.2 秒，
 * 异步编排需要的进度存储与后台执行兜底，代价远超收益。
 *
 * 幂等：`parseStatus` 已是 `completed` 时返回 **409 `already_parsed`**，不再烧一次 LLM。
 * 要重跑走 `/reparse`。
 *
 * 越权判定见 ADR-010：统一 404。
 */

/** 五板块并发约 3 秒，给到 60 秒是为了失败时能看到真实原因而不是一次毫无信息的 504。 */
export const maxDuration = 60

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params
  return handleParseRequest(request, id, 'parse')
}
