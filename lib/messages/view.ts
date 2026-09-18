import { SCHOOL_TIME_ZONE } from '@/lib/time'
// 🔴 从 `registry`（纯模块）读，**不是** `apply`：本文件在客户端组件链上
// （messages-view.tsx → 这里），而 apply 的动态 import 会在构建期把
// `next/headers` 拖进客户端图，整个 build 直接失败。详见 `registry.ts` 的注释。
import { isApplierReady } from '@/lib/messages/registry'
// 摘要的文案（纯模块，零 import）—— 同样是为了别把重依赖拖进客户端图。
import {
  DEFAULT_SUMMARY_LOCALE,
  coverageLabel,
  summaryLabel,
  summaryPendingLabel,
  type SummaryLocale,
} from '@/lib/messages/summary/locale'
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

/**
 * 课程身份色 —— 让"这是哪门课的"一眼可辨（2026-09-18 Steven 验收反馈：
 * 「课程分类做明显一点，可以给个不同的颜色高亮」）。
 *
 * ### 为什么用 hash，而不是"按课程表顺序分配"
 * 视图层是**纯函数**，拿不到用户的课程列表；而"按顺序"还有个更糟的后果：
 * 顺序一变（归档一门、新关联一门）所有课的颜色集体错位，
 * 用户会以为课程被换了。`hash(课程名)` 保证**同一门课永远同一个颜色**，
 * 跨会话、跨设备、跨"逐条 / 摘要"两条通道都一致。
 *
 * ### 为什么 seed 是课程名，不是 `courseId`
 * 摘要项（`payload.digest[i]`）的载荷里**只有 `courseName`**，没有 id。
 * 逐条通道用 id、摘要通道用名字的话，同一门课在两条通道里会是两个颜色 ——
 * 那正是 P0-3-15「同一个判定写两遍、两处都绿、肉眼才看得出」的变体。
 * 统一用课程名。代价：课程改名后颜色会变（罕见，不值得为它建映射表）。
 *
 * ### 为什么只有 5 组
 * 设计令牌里有 `-bg` 配对色的就这 5 组（`app/globals.css` 的「课程 / 状态色」）。
 * 5 门课以上必然有撞色 —— 可接受：徽标旁边就是课程名，颜色是辅助识别而非唯一依据。
 * 剩下的品牌色 `lime` 刻意不用（它是主按钮色，拿来当课程色会误导）。
 *
 * ### 🔴 类名必须是**静态字面量**
 * Tailwind v4 只扫源码里出现过的完整类名。`bg-${tone}` 这种运行时拼接
 * **扫不到、CSS 不会生成**，表现是"徽标没颜色"，而 `tsc` / `eslint` / `build`
 * 全绿（本项目 P0-3-15 已踩过一次，见 `docs/CodingRules.md` §10）。
 * 所以这里是字面量数组，**不许改成拼接**。
 *
 * ⚠️ 验证改动是否真的生效：build 后 grep 产物 CSS，
 * 五个类都应出现，如 `grep -o "\.text-blue{[^}]*}" .next/static/chunks/*.css`。
 */
export const COURSE_TONES = [
  'bg-blue-bg text-blue',
  'bg-purple-bg text-purple',
  'bg-green-bg text-green',
  'bg-coral-bg text-coral',
  'bg-amber-bg text-amber',
] as const

/**
 * 课程名 → 稳定的色板下标（FNV-1a 32 位散列）。
 *
 * 不是什么密码学散列，只要"同样输入同样输出、不同输入尽量散开"。
 * 手写而不引依赖：这是 10 行纯函数，为它加一个包不划算（CodingRules：不擅自加依赖）。
 */
export function courseToneClass(courseName: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < courseName.length; i += 1) {
    hash ^= courseName.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // `>>> 0`：`Math.imul` 的结果可能为负，负数取模会得到负下标 → `undefined` 类名。
  return COURSE_TONES[(hash >>> 0) % COURSE_TONES.length]
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

/**
 * 合并摘要里的一条（视图模型）。与 `MessageDigestItem` 的区别：
 * 每个字段都**已经过守卫**（链接过了 http(s) 白名单、空课程名归 null），
 * 渲染层拿到就能直接画，不必再判一遍。
 */
export type DigestItemView = {
  title: string
  courseLabel: string | null
  /** 课程身份色的 Tailwind 类（`courseLabel` 为 null 时是 null）。 */
  courseTone: string | null
  postedAtLabel: string | null
  sourceUrl: string | null
}

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
  /** 课程身份色的 Tailwind 类（`courseLabel` 为 null 时是 null）。 */
  courseTone: string | null
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
  /**
   * 合并摘要的条目（P0-3-25 C 口径）。**空数组 = 这条不是摘要**，
   * 渲染层据此决定要不要画那个可展开的列表。
   */
  digestItems: DigestItemView[]
  /** 摘要里因超上限未列出的条数（0 = 全列出来了）。 */
  digestOverflow: number
  /** 「确认」按钮的文案。无落点的公告是「知道了」。 */
  confirmLabel: string
  /**
   * AI 要点（P0-3-25b）。空数组 = 没有要显示的东西（还没生成 / 生成失败 /
   * 模型认为正文没有实质信息）—— **三种情况在界面上长得一样，也应该是**：
   * 要点是增强，原文才是主体。
   */
  summaryPoints: string[]
  /** 「AI 总结」归因标签。**只要有要点就必须显示** —— 要点不是老师的原话。 */
  summaryLabel: string
  /** 覆盖率文案（"基于最新 20 条 / 共 40 条"）；覆盖完整时是 null。 */
  summaryCoverage: string | null
  /**
   * 这条**还可以去生成要点**（公告 + 仍待处理 + 还没有任何结论）。
   *
   * 🔴 客户端只按这一个字段决定"要不要请求生成"。判定放在这里（与
   * `canAccept` 同一取向）而不是散在组件里，否则"什么时候该请求"会变成两处各写一遍
   * —— P0-3-15 那类分叉的预备队。
   */
  needsSummary: boolean
  /** 「生成中」的占位文案（真在请求中时由组件决定要不要画）。 */
  summaryBusyLabel: string
}

export function toMessageView(
  message: Message,
  locale: SummaryLocale = DEFAULT_SUMMARY_LOCALE,
): MessageView {
  const isPending = message.status === 'pending'
  const applierReady = isApplierReady(message.type)
  const confidence = message.payload.confidence === 'low' ? 'low' : 'high'

  // 抽成变量再派生 tone：色必须跟着**同一个**判定走。
  // 两处各判一遍（一处判空、一处判色）就是 P0-3-15 那类分叉的预备队。
  const courseLabel =
    typeof message.payload.courseName === 'string' && message.payload.courseName !== ''
      ? message.payload.courseName
      : null

  let blockReason: string | null = null
  if (!isPending) {
    blockReason = '已经处理过了'
  } else if (confidence === 'low') {
    blockReason = '置信度低：请先去课程页核对原文，这条不允许一键接受'
  } else if (!applierReady) {
    blockReason = '这类提案的写入逻辑还没接入，现在只能「忽略」'
  }

  // 摘要只对**公告**有意义（别的类型没有公告正文可提炼），且只对仍在等待处理的
  // 消息有意义 —— 已处理的消息在界面上只剩一行回执，要点没有位置（见 `ResolvedReceipt`）。
  // `summary === null`（而不是"没有要点"）才是"还没问过模型"：
  // status='failed' 的行同样会带过来（points 为空），语义是"别再问了"。
  const summary = message.summary ?? null
  const summaryPoints = summary?.points ?? []
  const needsSummary = message.type === 'announcement' && isPending && summary === null

  return {
    id: message.id,
    type: message.type,
    typeLabel: MESSAGE_TYPE_LABELS[message.type],
    status: message.status,
    createdAt: message.createdAt,
    title: readTitle(message.payload),
    lines: readDetails(message.payload),
    courseLabel,
    courseTone: courseLabel === null ? null : courseToneClass(courseLabel),
    confidence,
    isPending,
    applierReady,
    canAccept: isPending && confidence === 'high' && applierReady,
    blockReason,
    timeLabel: TIME_FORMATTER.format(new Date(message.createdAt)),
    sourceUrl: readSafeUrl(message.payload.sourceUrl),
    digestItems: readDigest(message.payload),
    digestOverflow: readDigestOverflow(message.payload),
    // 只有**明确标了**「无落点」的公告才改文案。`landing` 缺失（老数据 / 其他类型）
    // 一律按「确认」—— 不能因为字段没写就让按钮含糊其辞。
    confirmLabel:
      message.type === 'announcement' && message.payload.landing === false
        ? ACK_LABEL
        : CONFIRM_LABEL,
    summaryPoints,
    summaryLabel: summaryLabel(locale),
    // 覆盖率的判定是纯函数（`coverageLabel`），渲染层不重算 ——
    // "基于最新 20 条 / 共 40 条"这句话在两种语言下都要一致，只该有一处实现。
    summaryCoverage: coverageLabel(summary?.itemsUsed ?? 0, summary?.itemsTotal ?? 0, locale),
    needsSummary,
    summaryBusyLabel: summaryPendingLabel(locale),
  }
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
 * 读一个 URL 字段。🔴 **只放行 http(s)**。
 *
 * `payload` 是 `jsonb`，写入方现在只有公告同步一处，但类型上没有约束。
 * 哪天某个产出方（或一次手工改库）塞个 `javascript:…` 进来，渲染层的 `<a href>`
 * 就成了"点一下就执行"的口子 —— 而它长得和普通链接一模一样，评审时看不出来。
 * 在**唯一**的读取点挡掉，比在每个渲染点各写一遍白名单可靠。
 *
 * ⚠️ 入参刻意是 `unknown` 而不是 `string`：摘要（`digest`）里也有链接，
 * 那条路的形状更"野"（数组里的对象），必须是同一个函数挡，不能各写一遍。
 */
function readSafeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * 摘要里最多渲染多少条。
 *
 * 写入侧已有 `MAX_DIGEST_ITEMS` 截断，这里是**读取侧的独立防线** ——
 * payload 是 jsonb，一次手工改库就能塞进几千项，而渲染是在浏览器里做的。
 * 两道限流不重复：写入侧限的是"我们产出多大"，读取侧限的是"我们肯渲染多少"。
 */
const MAX_DIGEST_RENDERED = 100

/**
 * 读合并摘要（P0-3-25 C 口径）。
 *
 * 逐项守卫，**坏的那一项丢掉、其余照常渲染** —— 与整份摘要一起吞掉相比，
 * 少显示一条的代价远小于"老师发的通知一条都看不到"。
 * 唯一例外是**没有标题的项**：摘要行没标题就只是一行空白，留着只会让用户困惑。
 */
function readDigest(payload: MessagePayload): DigestItemView[] {
  const raw = payload.digest
  if (!Array.isArray(raw)) return []

  const items: DigestItemView[] = []
  for (const entry of raw) {
    if (items.length >= MAX_DIGEST_RENDERED) break
    if (typeof entry !== 'object' || entry === null) continue

    const record = entry as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (title === '') continue

    const courseName = typeof record.courseName === 'string' ? record.courseName.trim() : ''
    const postedAtLabel =
      typeof record.postedAtLabel === 'string' && record.postedAtLabel.trim() !== ''
        ? record.postedAtLabel
        : null

    items.push({
      title,
      courseLabel: courseName === '' ? null : courseName,
      courseTone: courseName === '' ? null : courseToneClass(courseName),
      postedAtLabel,
      sourceUrl: readSafeUrl(record.sourceUrl),
    })
  }
  return items
}

/** 摘要里未列出的条数。负数 / 非数一律当 0（绝不显示"还有 -3 条"）。 */
function readDigestOverflow(payload: MessagePayload): number {
  const value = payload.digestOverflow
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}
