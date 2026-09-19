/**
 * P0-3-18 消息栏：系统提案消息。
 *
 * ### 为什么表里只有「系统提案」，没有「用户消息」
 * 2026-09-17 Steven 拍板：用户自己的更新**不落这张表**。
 * 「HW7 截止改到 9/20」这类输入，效果落在 `tasks`（那才是数据），
 * 不留成一条聊天记录 —— 一旦落成聊天记录，就得面对回放 / 编辑 / 删除的期待，
 * 而浮窗对话框（P0-3-8b）本来就是「说完即走、零留存」，两边行为一致才没有落差。
 *
 * ### 提案的生命周期
 * `pending` → 「确认」→ `accepted` ／ 「忽略」→ `dismissed`。
 * 🔴 本表**不写任何业务数据**：`accepted` 只代表"用户批准了"，
 * 真正的写入由 applier 执行（`lib/messages/apply.ts`，ADR-015「确认才写」）。
 */

/**
 * 提案类型。与迁移的 CHECK 约束**必须一致**
 * （`20260917200000_messages.sql` 定前四个，`20260919000000_announcements.sql` 加第五个）。
 *
 * 🔴 加取值要**四处同改**（CodingRules §10.1 第 16 条），漏一处 `toMessage()` 返回 null、
 * 消息在列表里**静默消失**：
 * ① 本文件；② `lib/messages.ts` 的 `MESSAGE_TYPES`；③ 迁移的 CHECK 约束；
 * ④ `scripts/regress-messages.ts` 的断言。
 */
export type MessageType = 'syllabus_drift' | 'practice_test' | 'routine' | 'material' | 'announcement'

/** 提案状态。同上，与迁移的 CHECK 约束一致。 */
export type MessageStatus = 'pending' | 'accepted' | 'dismissed' | 'undone'

/**
 * 合并摘要里的一条公告（P0-3-25 C 口径，2026-09-18 Steven 拍板）。
 *
 * ### 为什么要有它
 * 一轮同步实测 48 条公告、其中 40 条「通知类」（office hours 改了、本周课取消…）。
 * 若每条都独立进消息栏，用户要点 40 次「知道了」—— 与 ADR-016「用户操作量趋零」直接冲突。
 * 于是这 40 条**合并成一条**消息：**「不漏」保住**（用户照样知道老师发了什么，
 * 每条都带原文入口），**操作量从 48 降到 9**（有落点的 8 条各自可写，加这 1 条摘要）。
 *
 * 🔴 合并**只对无落点的公告**生效。有落点的那条一旦被折进摘要，
 * 用户就没法「确认」写入考试 / 成绩构成了 —— 那是能力被藏起来，代价更大。
 */
export type MessageDigestItem = {
  title: string
  courseName?: string
  postedAtLabel?: string
  /** 原文链接。渲染前过 http(s) 白名单（见 `lib/messages/view.ts` 的 `readSafeUrl`）。 */
  sourceUrl?: string | null
}

/**
 * 漂移核对（P0-3-20）的进度。
 *
 * ### 为什么状态要落进 payload 而不是另开一张表
 * 它是**这一条提案**的属性（"这条的差异算出来了没"），与 `receipt` / `applied` 同级 ——
 * 混在 `message_summaries` 那种"缓存表"里会让"重放同步"和"重算差异"互相踩（ADR-024 同一条理由）。
 *
 * | 值 | 含义 | 界面 |
 * |---|---|---|
 * | `pending` | 同步已发现文件变了，差异**还没算**（等用户打开消息栏时懒补） | 按钮禁用 + 「正在核对差异…」 |
 * | `ready` | 差异算好了，有可写入的内容 | 按钮「确认」 |
 * | `clean` | 算过了，**与你的记录一致**（或只有描述性变化） | 按钮「知道了」（确认只留回执） |
 * | `failed` | 算不出来（抽不出文字 / 文件拿不到 / 模型不可用） | 按钮禁用 + 原因 |
 *
 * 🔴 `pending` 必须禁用「确认」：差异还没算出来时点确认，applier 无事可做 ——
 * 那就是"点了没反应"的静默失败（ADR-016 R3）。
 */
export type MessageDriftStatus = 'pending' | 'ready' | 'clean' | 'failed'

/** 一条**新增**的考试 / 成绩构成（`drift` 里的条目，确认后追加）。 */
export type MessageDriftAddedExam = {
  examName: string
  /** `YYYY-MM-DD`；null = 原文没写（落 TBD，**绝不编**）。 */
  examDate: string | null
  examTime: string | null
  location: string | null
  /** 原文逐字摘录。**没有摘录的条目不许写库**（ADR-021 的解禁前提）。 */
  sourceExcerpt: string
}

/**
 * 一条**变动**（确认后更正已有行）。
 *
 * `id` 是 `exam_dates.id`，由模型从"当前已确认的考试列表"里选 —— 服务端会复核它确实属于这门课。
 * `before` 是**服务端读出来的旧值**（不是模型转述的），确保界面上那句「10/20 → 10/27」可信。
 */
export type MessageDriftChangedExam = {
  id: string
  examName: string
  before: string
  after: string
  examDate: string | null
  examTime: string | null
  location: string | null
  sourceExcerpt: string
  /**
   * 这条能不能直接改。
   *
   * 🔴 由**服务端**在算出 diff 时判定（2026-09-18 Steven 拍板）：只有
   * `source='syllabus'` 且 `is_confirmed=false` 的才能自动更正 ——
   * 用户亲手确认过的那一行是权威源（ADR-015），只能提示他去课程页改，
   * **绝不自动覆盖**。
   */
  writable: boolean
  /** 不可自动更正的原因（人话，显示给用户）。可自动更正时为 null。 */
  blockedReason: string | null
}

export type MessageDriftAddedComponent = {
  name: string
  /** 0-100；null = 原文没写占比（**不是 0**）。 */
  weightPercent: number | null
  notes: string | null
  sourceExcerpt: string
}

/**
 * 大纲差异的明细（P0-3-20，懒补产出）。
 *
 * ### 🔴 它是"读出来的东西"，不是用户数据
 * 与 `receipt` / `applied` 一样由服务端写进 payload（`jsonb` 无 schema 约束），
 * 所以**读取侧每个字段都要当"可能不存在"**处理 —— 见 `lib/messages/view.ts`。
 * 界面上那几行「新增 X / 变动 Y」由这里渲染，**不额外做一套 UI**（3-18 是唯一提案出口）。
 *
 * ### 为什么不存原文
 * 用的是**按需路径**：允许下载那一个文件、抽文本、调模型，但
 * 原文与全文**不落库、不落盘、不进日志**（ADR-026）。这里只有结论与逐字摘录
 * （摘录 ≤200 字符，是"能核对"的最小证据，与 3-24 同一条纪律）。
 */
export type MessageDrift = {
  addedExams: MessageDriftAddedExam[]
  changedExams: MessageDriftChangedExam[]
  addedComponents: MessageDriftAddedComponent[]
  /**
   * 其他变化的一句话摘要（大纲里的描述性内容：评分细则、办公时间、课程安排…）。
   *
   * ⚠️ **不写库**，只显示。与 3-25「去掉 OH 结构化落点」同一条取舍：
   * 造一个没人维护的模型比不写更糟。有内容时界面必须说实话（"另有 N 处描述性变化，
   * 请到课程页核对"），否则用户会以为"没写就是没变"。
   */
  notes: string[]
  /** 抽取到的正文字符数 —— 覆盖率的证据（太少就不该相信这份 diff）。 */
  sourceChars: number
  /** 实际服务的模型（`llm_runs` 记的是实际服务模型，见 `TechStack.md` §5.2）。 */
  model: string | null
}

/**
 * 提案载荷的**最小契约**（P0-3-18 定义，后续卡按此产出）。
 *
 * 本卡是「全站系统提案的唯一出口」，所以载荷的公共形状定在这里，
 * 避免 3-19 / 3-20 / 3-23 各发一套。各类型自己的字段放 `extra`，本表不做 schema 校验。
 *
 * - `title`：一句话摘要，**直接渲染成消息标题**（必填 —— 没有标题的提案等于没说话）。
 * - `details`：细节行，一行一句（如「Unit 3 Exam 从 10/20 → 10/27」）。
 * - `confidence`：抽取出处不可靠时（扫描件 PDF 等）标 `low`。
 *   🔴 `low` **不许一键接受** —— 见 `lib/messages/view.ts` 的 `canAccept`。
 *
 * ### P0-3-25 加的四个字段（公告用）
 * - `sourceUrl`：原文链接。公告正文被剥成纯文本之后，**这是唯一能看原貌的路**，
 *   必须存下来（`course_announcements.html_url` 同步写入）。
 * - `announcementId`：指向 `course_announcements.id`。applier 靠它回查正文去解析 ——
 *   不把正文塞进 payload，是因为正文可能很长，而消息栏只读摘要。
 * - `landing`：`true` = 有结构化落点（按钮叫「确认」）；`false` = 纯通知（按钮叫「知道了」）。
 *   判定见 `lib/course-update/landing.ts`。
 */
export type MessagePayload = {
  title: string
  details?: string[]
  courseId?: string
  courseName?: string
  confidence?: 'high' | 'low'
  /** 原文链接（点「原文」跳过去）。没有就是 null —— 绝不编一个链接。 */
  sourceUrl?: string | null
  /** 公告账的 id（`course_announcements.id`）。 */
  announcementId?: string
  /** 有没有结构化落点。 */
  landing?: boolean
  /**
   * 确认后写入的业务数据行 id（P0-3-26 撤销用）。
   *
   * 只在 applier 真正写了东西时才有值；无落点公告（"知道了"）或写入失败都是 undefined。
   * 撤销时按这些 id 精准回滚（考试还要重跑派生链移除派生任务），**绝不**整表清空。
   */
  applied?: MessageApplied
  /**
   * 确认后的回执文案（P0-3-26，持久化的人话，刷新后仍在）。
   *
   * 由 applier 产出（如「已写入 2 条考试，该课现在共 7 条」），确认那一刻落库。
   * 与 `summary` 表是两回事：这里是确认动作的回执，那里是公告的 AI 要点。
   */
  receipt?: string
  /**
   * 「通知类公告」的合并摘要（P0-3-25 C 口径）。
   *
   * 只有**无落点**的公告走这条路：它们合并成一条消息，逐条列在这里。
   * 读取侧必须当"可能不存在 / 可能是任何形状"处理（jsonb 无 schema 约束）。
   */
  digest?: MessageDigestItem[]
  /** 条数超过上限（`MAX_DIGEST_ITEMS`）时，没被列进 `digest` 的条数。 */
  digestOverflow?: number
  /**
   * 漂移核对的进度（P0-3-20）。**只有 `syllabus_drift` 类型有**。
   *
   * 缺字段 = 老数据 / 别的产出方 → 读取侧一律按"没有这套状态"处理（不因此禁用按钮）。
   */
  driftStatus?: MessageDriftStatus
  /** 这一版大纲对应的 `course_files.id`（按需路径靠它定位要下载哪个文件）。 */
  syllabusFileId?: string
  /** 该文件的 `course_files.modified_at` —— 提案的依据，也是"这是哪一版"的凭据。 */
  syllabusModifiedAt?: string | null
  /** 差异明细（懒补产出）。`driftStatus` 为 `pending` / `failed` 时不存在。 */
  drift?: MessageDrift
  /** 核对失败的人话原因（`driftStatus='failed'` 时必有）。机器可读的那一份。 */
  driftError?: string
  /**
   * 自测卷账的 id（`practice_tests.id`，P0-3-23）。
   *
   * 与下面的 `paperPath` 是一对：这个是**数据**（去重键 `contains('payload', …)`
   * 靠它认人，见 `findPracticeTestMessageId`），那个是**给用户点的入口**。
   */
  practiceTestId?: string
  /**
   * 自测卷页的**站内路径**（P0-3-23），如 `/courses/<id>/practice-tests/new?exam=<fileId>`。
   *
   * 🔴 是**路径**不是外链。读取侧由 `readInternalPath` 守卫（只放行单个 `/` 开头的
   * 站内路径，挡掉 `//host` 这种协议相对 URL），渲染层用 `<Link>` 走客户端导航。
   * 与 `sourceUrl`（外站 → http(s) 白名单 + `target="_blank"`）**刻意分成两个字段**：
   * 混成一个早晚会有人把相对路径喂给只放行 http(s) 的守卫（链接凭空消失），
   * 或者给站内路径加上 `target="_blank"`。
   */
  paperPath?: string
  /**
   * 考试 / 成绩构成提案（P0-3-29，懒补产出）。**只有 `announcement` 类型有**。
   *
   * `examProposalsStatus` 为 `ready` 时 applier 直接照它写（不再解析正文）；
   * 为 `pending` / `failed` / 字段缺失时退回"确认时解析"。
   */
  examProposals?: MessageExamProposal[]
  /** 与考试提案同批解析出来的成绩构成（同样是为了省掉确认时那次解析）。 */
  componentProposals?: MessageComponentProposal[]
  examProposalsStatus?: MessageExamProposalsStatus
  /** 核对不出来的人话原因（`examProposalsStatus='failed'` 时必有）。 */
  examProposalsError?: string
  [key: string]: unknown
}

/**
 * 一条消息的 AI 要点（P0-3-25b，缓存表 `message_summaries`）。
 *
 * ### 🔴 它是**缓存**，不是消息的一部分
 * 要点由模型从公告原文提炼，生成一次就永久复用（公告正文不可变：老师改了内容
 * 会是一条新公告）。所以它不写进 `payload`：payload 是同步的产物，
 * 而这是"事后补上的派生物"，两者混在一起会让"重放同步"和"重算要点"互相踩。
 *
 * ### `status: 'failed'` 的语义是"别再问了"
 * `failed` 的行照样会出现在这里（`points` 为空数组）—— 界面上什么都不画，
 * 但**要点的生成方能看到"这条已经问过了"**，于是不会每次打开消息栏都重打一次模型。
 * 这与 `points: []`（模型说"这条公告没有实质信息"）在界面上长得一样，
 * 但语义不同，所以两个字段都留着。
 */
export type MessageSummary = {
  points: string[]
  /** 实际喂给模型的公告条数。 */
  itemsUsed: number
  /** 这条消息挂着的公告总数。两者不等时界面必须标出覆盖率。 */
  itemsTotal: number
  status: 'ok' | 'failed'
  createdAt: string
}

/**
 * 一条**考试提案**（P0-3-29，懒补产出）。
 *
 * ### 为什么要在点「确认」**之前**就把它算出来
 * 老师公告「Midterm 1 改期到 9/27」时，真正要用户裁决的是
 * 「要不要把 9/28 那条改成 9/27」。若等用户点了确认才解析，他点的是一个
 * 不知道会改哪一条的按钮 —— 那与 ADR-015「已确认的绝不被自动覆盖」直接冲突。
 * 所以打开消息栏时先算一次（`POST /api/v1/messages/exam-proposals`），
 * 把 `before → after` 写进 `payload.details` 给本人看。
 *
 * ### 确认时**复用**这一份
 * applier 不再重新解析公告正文：一是省一次模型调用，二是"所见即所写" ——
 * 重新解析可能给出不一样的结论，那回执就和界面上那句对不上了。
 */
export type MessageExamProposal = {
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
  sourceExcerpt: string
  /** 与 `lib/course-update/exam-match.ts` 的 `ExamResolutionKind` 同一套取值。 */
  kind: 'create' | 'update' | 'duplicate' | 'ambiguous' | 'unidentifiable' | 'missing'
  /** `update` 时命中的那一行 id；其余为 null。 */
  targetId: string | null
  /** 旧值的人话（`update` 时必有）—— 界面与回执都用它，不许再拼一遍。 */
  beforeLabel: string | null
  /** 新值的人话。 */
  afterLabel: string
  /** 多命中 / 不可辨识时列出来让人挑（id + 人话）。 */
  candidates: { id: string; label: string }[]
  /** 不写的原因（人话）。`create` / `update` 为 null。 */
  reason: string | null
}

/** 一条成绩构成提案（P0-3-29，与考试提案同批懒补 —— 省掉确认时那次解析）。 */
export type MessageComponentProposal = {
  name: string
  weightPercent: number | null
  notes: string | null
  sourceExcerpt: string
}

/**
 * 考试提案的核对进度（P0-3-29）—— 与 `driftStatus` 同一套形状，同一个理由：
 * 它是**这一条提案**的属性，与 `receipt` / `applied` 同级，另开一张表会让
 * "重放同步"与"重算提案"互相踩（ADR-024）。
 *
 * ⚠️ **与 drift 不同**：`pending` / `failed` **不禁用「确认」**。
 * 公告没有提案也能确认（applier 会退回"确认时解析"那条老路），
 * 卡住按钮只会让用户没法处理一条本来能处理的公告。
 */
export type MessageExamProposalsStatus = 'pending' | 'ready' | 'clean' | 'failed'

/** 提案（camelCase，供 UI 使用；snake_case 的列名只出现在 `lib/messages.ts`）。 */
export type Message = {
  id: string
  type: MessageType
  payload: MessagePayload
  status: MessageStatus
  createdAt: string
  /** 确认 / 撤销那一刻（P0-3-26，供 24h 撤销窗口判定）。未处理过为 null。 */
  decidedAt: string | null
  /**
   * AI 要点（P0-3-25b）。**可选**，因为两条读取路径的取法不同：
   * - 列表（`loadMessages`）会一并查出来附上 —— 打开消息栏时要立刻看到缓存里的要点，
   *   而不是先画一遍空白再等客户端补（那会闪一下）；
   * - 单条 / PATCH 的返回值不带 —— 已处理的提案只画一行回执，要点在那儿没有位置。
   */
  summary?: MessageSummary | null
}

/** `messages` 表在数据库中的行（与 Database.md / 迁移一致）。 */
export type MessageRow = {
  id: string
  user_id: string
  type: string
  payload: unknown
  status: string
  created_at: string
  decided_at: string | null
}

/**
 * 确认后写入的业务数据行 id（P0-3-26 撤销用）。
 *
 * 只记"这次确认新写入了哪些行"，撤销按 id 精准回滚。
 * 考试删除后还要重跑 `syncExamToTask` 移除对应的派生任务（ADR-004 唯一派生实现）；
 * 成绩构成没有派生任务，直接删。
 */
export type MessageApplied = {
  examDateIds?: string[]
  gradeComponentIds?: string[]
  /**
   * **被更正**的考试行（P0-3-20 加）。
   *
   * ### 为什么不能复用 `examDateIds`
   * 大纲漂移里「变动 Y」是 **update，不是 insert** —— 撤销不可能按 id 去删，
   * 那会把一行用户本来就有的考试连根删掉。要还原就必须知道**旧值**，
   * 而旧值只在写入那一刻存在于库里（写完就被覆盖了）。
   *
   * 所以确认时在这里留一份快照，撤销时按 `id` 写回去。
   * ⚠️ 字段是**结构化的值**（不是界面上的 `before` 那句人话）：
   * 「Unit 3 Exam · 2026-10-20 · 7-9pm」这句话拆不回 `exam_time`。
   */
  examRestores?: MessageExamRestore[]
}

/** 一行考试的旧值快照（`exam_dates` 里所有会被写入器改动的字段）。 */
export type MessageExamRestore = {
  id: string
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
  /**
   * 旧值的原文摘录。**必须一起还原** —— 摘录是"这个值凭什么这么写"的证据，
   * 把新值的摘录留在还原后的旧值旁边，等于在库里留了一条对不上的溯源信息。
   */
  sourceExcerpt: string | null
}
