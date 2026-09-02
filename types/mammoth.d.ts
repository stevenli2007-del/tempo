/**
 * mammoth 的最小类型声明。
 *
 * **为什么需要手写一个**：mammoth **1.12.2 不自带类型定义**，且 DefinitelyTyped 上
 * 也没有这个包（`npm view @types/mammoth` 返回 404）。
 *
 * 这里**只声明本项目实际用到的那一个 API 面**（`extractRawText`），不试图描述整个库 ——
 * 声明越多，与真实实现漂移时撒谎的风险越大。将来要用 `convertToHtml` 等能力时，
 * 在这里按实际签名补上，不要凭印象写。
 */

declare module 'mammoth' {
  /** mammoth 的告警/提示信息。`type` 常见取值：`warning` / `error` / `info`。 */
  export interface MammothMessage {
    type: string
    message: string
  }

  /** `extractRawText` 的返回值。`value` 是纯文本（已剥掉所有 docx 标记）。 */
  export interface RawTextResult {
    value: string
    messages: MammothMessage[]
  }

  export interface RawTextInput {
    /** 文件内容。传 `buffer` 或 `path` 之一，本项目只传 buffer。 */
    buffer?: Buffer
    path?: string
  }

  export function extractRawText(input: RawTextInput): Promise<RawTextResult>

  const mammoth: {
    extractRawText: typeof extractRawText
  }

  export default mammoth
}
