import type { JSONSchema, LLMMessage, LLMResult } from '@/lib/llm'

import { runStructured } from '@/lib/llm/run'

import type { ParsedInbound } from './plan'

/**
 * 邮件入站文本解析（P0-3-11）。
 *
 * 复用 `runStructured`（文本档，DeepSeek，中国境内，符合已解决的 O-08）。
 * 与 `/api/v1/tasks/parse` 同口径，但 schema 不同：这里要的是
 * 「这封邮件对某条作业意味着什么事件」，而不是「抽出一组新任务」。
 *
 * 🔴 **解析 ≠ 落库**：本文件只产出结构化事件，落写由 `lib/email/inbound.ts` 决定，
 * 且严格受限（只写 `status='done'`，见 plan.ts 决策边界）。
 */

const PARSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    taskTitle: {
      type: ['string', 'null'],
      description: '邮件提到的具体作业/任务名称（如 Homework 6、HW6、Project 2）。完全无关邮件填 null',
    },
    event: {
      type: 'string',
      enum: ['submitted', 'due_date_changed', 'new_assignment', 'other'],
      description:
        'submitted=已提交/已收到提交回执；due_date_changed=截止日期变更；new_assignment=新增作业；other=无关或无法判断',
    },
    newDueDate: {
      type: ['string', 'null'],
      description: '仅当 event=due_date_changed 时给 M/D 或 YYYY-MM-DD，否则 null',
    },
    courseHint: {
      type: ['string', 'null'],
      description: '邮件可能提到的课程名/代码（如 CHEM 1A），没有填 null',
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: '无法判断、歧义或无关内容等说明',
    },
  },
  required: ['taskTitle', 'event', 'newDueDate', 'courseHint', 'warnings'],
}

const SYSTEM_PROMPT = `你是 Tempo 的邮件入站解析器。用户会把课程相关邮件（Gradescope 提交回执、课程通知、Piazza、作业平台提醒等）转发到 Tempo 专属地址。请判断这封邮件对「哪条作业/任务」意味着什么事件。

规则：
1. taskTitle：邮件里提到的**具体作业/任务名称**（如 "Homework 6"、"HW6"、"Project 2"、"Lab 3"）。若邮件完全无关（广告、营销、个人邮件）填 null。
2. event 取值：
   - submitted：邮件表明该作业**已提交**或**已收到提交**（如 "Your submission was received"、"Submitted successfully"、"Successfully submitted"）。
   - due_date_changed：邮件表明截止日期变更。
   - new_assignment：邮件表明新增了一个作业/任务。
   - other：无关或无法判断。
3. newDueDate：仅当 event=due_date_changed 时给日期（M/D 或 YYYY-MM-DD），否则 null。
4. courseHint：邮件可能提到的课程名/代码（如 "CHEM 1A"、"CS 61A"），没有填 null。
5. 只依据邮件正文判断，绝不编造；输出严格符合 JSON schema，不加任何解释文字。`

export function parseInboundEmail(params: {
  userId: string
  text: string
}): Promise<LLMResult<ParsedInbound>> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: params.text },
  ]

  return runStructured<ParsedInbound>({
    userId: params.userId,
    purpose: 'email_inbound_parse',
    promptVersion: 'v1',
    schema: PARSE_SCHEMA,
    schemaName: 'EmailInboundParse',
    messages,
    temperature: 0,
    // 文本档 → DeepSeek（中国境内，符合 O-08）。
    capability: 'text',
  })
}
