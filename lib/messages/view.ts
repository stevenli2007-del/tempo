import { SCHOOL_TIME_ZONE } from '@/lib/time'
// 站内路径守卫（纯模块）：本文件与 P0-3-30 的 syllabus 导入共用同一份，
// 两处各写一遍就会有一处忘了 `//host` 是协议相对 URL 这一种形态。
import { readInternalPath } from '@/lib/internal-path'
// 外链守卫（纯模块）。**原先这里是私有副本**，P0-3-32 的教程卡也要用同一份判据，
// 故抽到 `lib/safe-url.ts`；本文件改为 import，行为一字未变。
import { readSafeUrl } from '@/lib/safe-url'
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
import type {
  Message,
  MessageDriftStatus,
  MessagePayload,
  MessageStatus,
  MessageType,
} from '@/types/message'

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
 * 没有东西可写的提案：「确认」什么都不会写，叫它「知道了」才是诚实的说法
 * （ADR-016 R3：不许让用户以为写进去了）。
 *
 * ### 目前谁用它
 * ① 无落点的公告（P0-3-25）—— 只有一句"本周课取消"可看；
 * ② 核对完确认没差异的漂移提案（P0-3-20）；
 * ③ 自测卷通知（P0-3-23）—— 卷子在生成那一刻就落库了，消息只是"去用它"的入口。
 *
 * ⚠️ **已知的不一致（留待统一）**：`material`（资料索引通知）同样是空写入，
 * 按钮却仍是「确认」。改它属于 3-19 的范围（`regress-messages.ts` 有一条断言钉住），
 * 本卡不动它 —— 但这里记一笔，免得后人以为"空写入 → 知道了"这条规则只在部分类型上生效。
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
  /** 是否已被撤销（P0-3-26，终态）。 */
  isUndone: boolean
  /** 确认 / 撤销那一刻（P0-3-26）。未处理过为 null。 */
  decidedAt: string | null
  /** 确认回执文案（P0-3-26，持久化的人话）。无回执为 null。 */
  receiptText: string | null
  /** 本次确认写入的业务数据行数（P0-3-26；为 0 = 无可撤销内容）。 */
  appliedCount: number
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
   * **站内**页面路径（P0-3-23）：自测卷页 `/courses/<id>/practice-tests/new?exam=…`。
   *
   * 与 `sourceUrl` 分两个字段是刻意的：`sourceUrl` 是**外站**（Canvas 上的原文，
   * 走 http(s) 白名单 + `target="_blank"`），这里是**站内**（用客户端路由跳转、
   * 不能开新窗口）。混成一个字段早晚会有人给它加 `target="_blank"`，
   * 或者把相对路径喂给只放行 http(s) 的守卫（→ 链接凭空消失）。
   *
   * 🔴 守卫见 `readInternalPath`：`payload` 是 jsonb，只放行"单个 `/` 开头的站内路径"。
   */
  paperUrl: string | null
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
  /**
   * 这条漂移提案**还需要算差异**（P0-3-20）。
   *
   * 🔴 与 `needsSummary` 同一个用途：客户端只按这一个字段决定"要不要请求"。
   * 同步侧建的那条提案此刻只有一句「正在核对差异…」占位，真正的「新增 X / 变动 Y」
   * 由 `POST /api/v1/messages/drift` 懒补回 `payload.details`（同 ADR-024 范式）。
   *
   * ⚠️ 刻意**不**再配一个"忙态文案"：占位就在 `details` 里（连同"一直不动怎么办"的
   * 说明），再画一行「正在核对差异…」就是同一句话出现两遍。公告要点那边需要忙态，
   * 是因为它的 `points` 为空时界面上什么都没有；这里不是。
   */
  needsDrift: boolean
  /**
   * 这条**有落点的公告还没算出考试提案**（P0-3-29）。
   *
   * 与 `needsDrift` 同一用途（客户端只按这一个字段决定"要不要请求"），
   * 但**语义不同**：算不算得出来**不影响「确认」能不能点** —— 没算出来时
   * applier 会退回"确认那一刻解析"那条路。所以它只驱动一次请求，不参与
   * `blockReason`（卡住按钮只会让用户没法处理一条本来能处理的公告）。
   *
   * 判据里"没有 `examProposalsStatus`"= 从没算过 **或** 上次是暂时性失败
   * （那种情况服务端刻意不写状态，下次打开自然重试）。`ready` / `clean` / `failed`
   * 三种终态都不再请求 —— 与要点那边的 `failed` 同一条"别再问了"纪律（ADR-024）。
   */
  needsExamProposals: boolean
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

  /**
   * 漂移核对进度（P0-3-20）。只有 `syllabus_drift` 有；其余类型是 null。
   *
   * 缺字段按 `pending` 处理吗？**不。** 老数据 / 别的产出方缺这个字段时，
   * 若当成 `pending` 就会去请求一次核对（对一个根本没有 `syllabusFileId` 的消息，
   * 那是必然失败的一次往返）。这里保持 `null` = "不是待核对的漂移消息"，
   * 让 `needsDrift` 要求三个条件同时成立。
   */
  const driftStatus: MessageDriftStatus | null =
    message.type === 'syllabus_drift' && typeof message.payload.driftStatus === 'string'
      ? (message.payload.driftStatus as MessageDriftStatus)
      : null
  const driftError =
    typeof message.payload.driftError === 'string' && message.payload.driftError.trim() !== ''
      ? message.payload.driftError
      : null

  /**
   * 能不能点「确认」——**唯一判定**：`blockReason === null`。
   *
   * 原来这里是 `isPending && confidence === 'high' && applierReady`，与上面的
   * `blockReason` 三条分支是同一件事的两种写法（互补）。合成一条之后，
   * 每加一个"不能写"的理由只需要改一处 —— 否则迟早出现
   * 「按钮能点但点了报错」或反过来的分叉（CodingRules §10.1 第 21 条）。
   *
   * ⚠️ 顺序有讲究：**越具体的理由排越前**。漂移的 `failed` 同时也满足
   * `confidence === 'low'`，但用户更需要看到「这份大纲抽不出文字」而不是
   * 一句泛泛的"置信度低"。
   */
  let blockReason: string | null = null
  if (!isPending) {
    blockReason = '已经处理过了'
  } else if (driftStatus === 'pending') {
    // 此刻 payload 里只有占位文案，确认下去会**什么都不写**。
    // 卡住按钮 + 说明原因，正是 R3「不许静默失败」要的形状。
    blockReason = '正在核对差异，稍等一下就能确认'
  } else if (driftStatus === 'failed') {
    blockReason = driftError ?? '这次没能核对出差异，请到课程页核对原文'
  } else if (driftStatus === 'clean') {
    // 核对完发现没有差异 → 按钮叫「知道了」（见下面 `confirmLabel`），applier 空写入。
    //
    // 🔴 **刻意放行、且排在低置信度判断之前**：卡片那条"低置信度不许一键接受"
    // 针对的是**提案内容**（提取不准 → 写进去的值不可信）。`clean` 一个字段都不写，
    // 挡住它只会让用户没法把这条提案清掉（只能"忽略"，而忽略的语义是"我不需要它"）。
    // 低置信度徽标此时仍然显示 —— 那个提醒是有用的（"这份 PDF 抽得不全，
    // '没差异'这个结论也不一定可靠"），但它不该禁掉一句"我知道了"。
  } else if (message.type === 'syllabus_drift' && driftStatus !== 'ready') {
    // 走到这里只剩"字段缺失"一种可能（pending / failed / clean 上面都已分支）。
    // ⚠️ 这条分支是刻意留的：漂移提案**没有差异就不能写**，而缺字段（老数据 /
    // 半截写入 / 手工改库）会让按钮亮着、点下去 applier 回一句"差异还没核对出来"
    // —— 那就成了"按钮说能点、点了报错"。宁可明确挡住并说清原因。
    blockReason = '这条提案缺少核对信息，请到课程页手动核对大纲'
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

  /**
   * 还需要算差异的漂移提案（P0-3-20）。
   *
   * 三个条件缺一不可：① 类型对；② 还没被处理（已确认/已忽略的提案不该再花一次下载+模型钱）；
   * ③ 状态是 `pending` 且**拿得到定位文件的两个字段** —— 缺 `syllabusFileId` 的
   * 老数据请求过去也只会被判失败，不如不请求。
   */
  const needsDrift =
    message.type === 'syllabus_drift' &&
    isPending &&
    driftStatus === 'pending' &&
    typeof message.payload.syllabusFileId === 'string' &&
    typeof message.payload.courseId === 'string'

  /**
   * 考试提案（P0-3-29）：只给**有落点的公告**、且**还没算出结论**的那几条发一次请求。
   *
   * 四个条件：① 类型是公告；② 仍待处理（已确认/忽略的不该再花一次模型钱）；
   * ③ `landing === true`（无落点的摘要消息没有考试可谈）；
   * ④ 状态字段还没有终态（缺字段 = 从没算过或上次是暂时性失败，都该再试一次）。
   */
  const examProposalsStatus =
    typeof message.payload.examProposalsStatus === 'string'
      ? message.payload.examProposalsStatus
      : null
  const needsExamProposals =
    message.type === 'announcement' &&
    isPending &&
    message.payload.landing === true &&
    examProposalsStatus === null &&
    typeof message.payload.courseId === 'string' &&
    typeof message.payload.announcementId === 'string'

  return {
    id: message.id,
    type: message.type,
    typeLabel: MESSAGE_TYPE_LABELS[message.type],
    status: message.status,
    isUndone: message.status === 'undone',
    decidedAt: message.decidedAt,
    receiptText:
      typeof message.payload.receipt === 'string' && message.payload.receipt.trim() !== ''
        ? message.payload.receipt
        : null,
    appliedCount: countApplied(message.payload),
    createdAt: message.createdAt,
    title: readTitle(message.payload),
    lines: readDetails(message.payload),
    courseLabel,
    courseTone: courseLabel === null ? null : courseToneClass(courseLabel),
    confidence,
    isPending,
    applierReady,
    canAccept: blockReason === null,
    blockReason,
    timeLabel: TIME_FORMATTER.format(new Date(message.createdAt)),
    sourceUrl: readSafeUrl(message.payload.sourceUrl),
    paperUrl: readInternalPath(message.payload.paperPath),
    digestItems: readDigest(message.payload),
    digestOverflow: readDigestOverflow(message.payload),
    // 只有**确实什么都不写**的三种情况才改按钮文案 —— 叫「确认」是在含糊其辞：
    // ① 明确标了「无落点」的公告；② 核对完确认没差异的漂移提案；
    // ③ 自测卷通知（卷子早已落库，消息只是入口）。
    // 其余（含字段缺失）一律按「确认」。
    confirmLabel:
      (message.type === 'announcement' && message.payload.landing === false) ||
      (message.type === 'syllabus_drift' && driftStatus === 'clean') ||
      message.type === 'practice_test'
        ? ACK_LABEL
        : CONFIRM_LABEL,
    summaryPoints,
    summaryLabel: summaryLabel(locale),
    // 覆盖率的判定是纯函数（`coverageLabel`），渲染层不重算 ——
    // "基于最新 20 条 / 共 40 条"这句话在两种语言下都要一致，只该有一处实现。
    summaryCoverage: coverageLabel(summary?.itemsUsed ?? 0, summary?.itemsTotal ?? 0, locale),
    needsSummary,
    summaryBusyLabel: summaryPendingLabel(locale),
    needsDrift,
    needsExamProposals,
  }
}

/** 载荷是 `jsonb`，读的时候**每个字段都要当"可能不存在"**（3-19/3-20/3-23 各自产出）。 */
function countApplied(payload: MessagePayload): number {
  const applied = (payload.applied ?? {}) as {
    examDateIds?: unknown
    gradeComponentIds?: unknown
    examRestores?: unknown
  }
  const exams = Array.isArray(applied.examDateIds) ? applied.examDateIds.length : 0
  const components = Array.isArray(applied.gradeComponentIds) ? applied.gradeComponentIds.length : 0
  /**
   * 🔴 **更正过的行也要算进来**（P0-3-20）。界面用这个数决定要不要显示「撤销」，
   * 而大纲漂移里"只更正了 1 条日期、没新增任何东西"是最常见的形态 ——
   * 漏掉它，用户就会看到「✓ 已确认」却找不到撤销按钮，
   * 而他刚才明明看到 Tempo 把期中日期改掉了。
   */
  const restores = Array.isArray(applied.examRestores) ? applied.examRestores.length : 0
  return exams + components + restores
}

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
 * 读一个 URL 字段的守卫：**已搬到 `lib/safe-url.ts`**（P0-3-32 抽公共）。
 *
 * 判据（只放行 http(s)）与原来的私有副本**完全一致**，这里不再留实现 ——
 * 白名单只该有一份，两处各写一份时早晚有一处漏掉 `javascript:` 之外的新形态。
 * ⚠️ 站内路径走下面的 `readInternalPath()`，**不要**混用（会判 null → 链接凭空消失）。
 */

/**
 * 读一个**站内**路径字段（P0-3-23 的 `payload.paperPath`）。
 *
 * ### 🔴 为什么不能复用 `readSafeUrl`
 * 那个只放行 http(s)，而这里是相对路径（`/courses/…`）—— 直接喂过去会被判 null，
 * 症状是"链接凭空消失、零报错"。反过来把 `readSafeUrl` 放宽到"也接受相对路径"更糟：
 * 外站链接那条路会一起失去白名单。
 *
 * ### 🔴 为什么相对路径也要守卫
 * `//evil.com/x` 在浏览器里是**协议相对 URL** —— 它会跳到 `https://evil.com/x`。
 * 它长得和 `/courses/…` 只差一个字符，评审时几乎看不出来。
 * `/\evil.com` 同理：部分浏览器把反斜杠当斜杠处理。
 * 所以判据是「以**单个** `/` 开头」：`//` 与 `/\` 都必须拒。
 *
 * ⚠️ 入参是 `unknown`（`payload` 是 jsonb，没有 schema 约束）：一次手工改库
 * 或一个还没写的产出方就能塞进 `javascript:…`，而渲染层的 `<a href>` 会照单全收。
 * 在**唯一**的读取点挡掉，比在每个渲染点各写一遍白名单可靠（与 `readSafeUrl` 同一取舍）。
 */

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
