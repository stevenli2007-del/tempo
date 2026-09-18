import { SCHOOL_TIME_ZONE } from '@/lib/time'
import { isApplierReady } from '@/lib/messages/apply'
import type { Message, MessagePayload, MessageStatus, MessageType } from '@/types/message'

/**
 * 提案的展示层视图模型（纯函数，`scripts/regress-messages.ts` 直接断言）。
 *
 * 🔴 这里决定「确认」按钮**能不能点** —— 与 API 的写入判定同源：
 * UI 用 `canAccept`，API 用 `planDecision()`，两者都读**同一份** `isApplierReady()`
 * 与**同一条**置信度规则。任何一边单独写一遍，就会出现
 * 「按钮说能点、点了报错」或更糟的「按钮说不能点、其实会写」。
 */

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  syllabus_drift: '大纲变更',
  practice_test: '自测卷',
  routine: '学习计划',
  material: '资料索引',
}

/** 用学校本地时区渲染（与 `lib/tasks/format.ts` 同一理由：服务端/浏览器不能各算一遍）。 */
const TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: SCHOOL_TIME_ZONE,
})

export type MessageView = {
  id: string
  type: MessageType
  typeLabel: string
  /** 原始状态。UI 用它区分"已确认"与"已忽略"（两者都是非 pending）。 */
  status: MessageStatus
  /**
   * 原始时间戳（ISO）。会话版面要按时间排，**必须显式排**——
   * 不能靠 `loadMessages` 的返回顺序（那是数据层的实现细节，改个 order 就会静默错排）。
   */
  createdAt: string
  title: string
  lines: string[]
  courseLabel: string | null
  /** `low` = 抽取来源不可靠（扫描件等）→ 不许一键接受。 */
  confidence: 'high' | 'low'
  isPending: boolean
  applierReady: boolean
  canAccept: boolean
  /** 不能确认的原因（给用户看的人话）；`canAccept` 为 true 时是 null。 */
  blockReason: string | null
  timeLabel: string
}

/** 载荷是 `jsonb`，读的时候**每个字段都要当"可能不存在"**（3-19/3-20/3-23 各自产出）。 */
function readTitle(payload: MessagePayload): string {
  const title = payload.title
  if (typeof title === 'string' && title.trim() !== '') return title
  // 不编一个假标题：如实说明这条提案缺摘要（CodingRules §7「允许不知道」）。
  return '（这条提案没有摘要）'
}

function readDetails(payload: MessagePayload): string[] {
  const details = payload.details
  if (!Array.isArray(details)) return []
  return details.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
}

export function toMessageView(message: Message): MessageView {
  const isPending = message.status === 'pending'
  const applierReady = isApplierReady(message.type)
  const confidence = message.payload.confidence === 'low' ? 'low' : 'high'

  let blockReason: string | null = null
  if (!isPending) {
    blockReason = '已经处理过了'
  } else if (confidence === 'low') {
    blockReason = '置信度低：请先去课程页核对原文，这条不允许一键接受'
  } else if (!applierReady) {
    blockReason = '这类提案的写入逻辑还没接入，现在只能「忽略」'
  }

  return {
    id: message.id,
    type: message.type,
    typeLabel: MESSAGE_TYPE_LABELS[message.type],
    status: message.status,
    createdAt: message.createdAt,
    title: readTitle(message.payload),
    lines: readDetails(message.payload),
    courseLabel:
      typeof message.payload.courseName === 'string' && message.payload.courseName !== ''
        ? message.payload.courseName
        : null,
    confidence,
    isPending,
    applierReady,
    canAccept: isPending && confidence === 'high' && applierReady,
    blockReason,
    timeLabel: TIME_FORMATTER.format(new Date(message.createdAt)),
  }
}
