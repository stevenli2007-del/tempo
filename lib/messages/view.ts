import { SCHOOL_TIME_ZONE } from '@/lib/time'
// 🔴 从 `registry`（纯模块）读，**不是** `apply`：本文件在客户端组件链上
// （messages-view.tsx → 这里），而 apply 的动态 import 会在构建期把
// `next/headers` 拖进客户端图，整个 build 直接失败。详见 `registry.ts` 的注释。
import { isApplierReady } from '@/lib/messages/registry'
import type { Message, MessagePayload, MessageStatus, MessageType } from '@/types/message'

/**
 * 提案的展示层视图模型（纯函数，`scripts/regress-messages.ts` 直接断言）。
 *
 * 🔴 这里决定「确认」按钮**能不能点** —— 与 API 的写入判定同源：
 * UI 用 `canAccept`，API 用 `planDecision()`，两者都读**同一份** `isApplierReady()`
 * 与**同一条**置信度规则。任何一边单独写一遍，就会出现
 * 「按钮说能点、点了报错」或更糟的「按钮说不能点、其实会写」。
 */

/**
 * 类型标签。🔴 **枚举扩展四处同改的第 ④处**
 * （`Record<MessageType, string>` 会在 `tsc` 时强制补全 —— 这是四处里唯一"漏了会红"的一处；
 * 另外三处漏了都不报错，所以别把它当成"有 tsc 兜底就不用管其他三处"）。
 */
export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  syllabus_drift: '大纲变更',
  practice_test: '自测卷',
  routine: '学习计划',
  material: '资料索引',
  announcement: '课程公告',
}

/** 默认的确认按钮文案。 */
const CONFIRM_LABEL = '确认'
/**
 * 无落点的公告：「确认」什么都不会写，叫它「知道了」才是诚实的说法
 * （ADR-016 R3：不许让用户以为写进去了）。
 */
const ACK_LABEL = '知道了'

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
  /**
   * 原文链接（公告的 Canvas 原页）。
   *
   * 公告正文在同步时被剥成了纯文本（防 stored XSS），原貌 —— 表格、图片、附件 ——
   * 只有这一条路能看。**已强制 http(s)**，见 `readSourceUrl`。
   */
  sourceUrl: string | null
  /** 「确认」按钮的文案。无落点的公告是「知道了」。 */
  confirmLabel: string
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

/**
 * 读原文链接。🔴 **只放行 http(s)**。
 *
 * `payload` 是 `jsonb`，写入方现在只有公告同步一处，但类型上没有约束。
 * 哪天某个产出方（或一次手工改库）塞个 `javascript:…` 进来，渲染层的 `<a href>`
 * 就成了"点一下就执行"的口子 —— 而它长得和普通链接一模一样，评审时看不出来。
 * 在**唯一**的读取点挡掉，比在每个渲染点各写一遍白名单可靠。
 */
function readSourceUrl(payload: MessagePayload): string | null {
  const url = payload.sourceUrl
  if (typeof url !== 'string' || url.trim() === '') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
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
    sourceUrl: readSourceUrl(message.payload),
    // 只有**明确标了**「无落点」的公告才改文案。`landing` 缺失（老数据 / 其他类型）
    // 一律按「确认」—— 不能因为字段没写就让按钮含糊其辞。
    confirmLabel:
      message.type === 'announcement' && message.payload.landing === false
        ? ACK_LABEL
        : CONFIRM_LABEL,
  }
}
