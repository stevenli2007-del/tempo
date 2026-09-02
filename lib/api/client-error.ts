import type { ApiErrorBody } from '@/types/course'

/**
 * 从 API 错误响应里取出**可以直接展示给用户**的文案。
 *
 * 契约 1.3：错误体统一为 `{ error: { code, message } }`，其中 `message` 是面向用户的人话。
 * 取不到时退回「动作名 + HTTP 状态」，绝不把 `undefined` 或 JSON 字面量渲染到界面上。
 *
 * 只用于 Client Component 的 fetch 调用。
 */
export async function readApiErrorMessage(response: Response, action: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null)

  if (typeof body === 'object' && body !== null && 'error' in body) {
    const message = (body as ApiErrorBody).error?.message
    if (typeof message === 'string' && message !== '') {
      return message
    }
  }

  return `${action}失败（HTTP ${response.status}）`
}
