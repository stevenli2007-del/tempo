/**
 * Canvas 凭证与代理响应的类型（P0-2-2，API-Contract.md 第 6 节）。
 *
 * 字段一律 camelCase —— Database.md 规定：数据库 snake_case，TS camelCase，禁止混用。
 *
 * ### 🔴 本文件最重要的约定：密钥字段不出现在对外类型里
 *
 * `CanvasCredentialMeta` 是**唯一**允许流出服务端的凭据形状，
 * 它**没有** `secretEncrypted`、也没有任何 token 字段。
 * Security-Privacy 第 4 节的响应红线写得很死：
 * 「任何 API 响应中不得出现 token 或其派生形式」。
 * 把密钥字段挡在类型系统外面，比靠"记得别写进去"可靠 ——
 * 后者会在加字段时漏，前者会在编译期拦下。
 */

/** 凭证状态。取值与 canvas_credentials.status 的 CHECK 约束一致。 */
export type CredentialStatus = 'active' | 'expired' | 'revoked' | 'error'

/**
 * 凭证类型。Phase 0 只有 `pat`。
 * `ical` 是长期 Plan B（ADR-002），`oauth` 留给 Phase 1，两者都不在本阶段实现。
 */
export type CredentialType = 'pat' | 'ical' | 'oauth'

/**
 * 对外的凭据元数据（GET /api/v1/canvas/credentials 的响应体）。
 *
 * 只含"用户需要知道的连接状态"，不含任何可用于调用 Canvas 的东西。
 */
export type CanvasCredentialMeta = {
  id: string
  canvasDomain: string
  credentialType: CredentialType
  /** ISO 8601。2026-09-04 P0-2-1b 实测：bCourses 强制必填过期时间，上限 90 天。 */
  expiresAt: string
  status: CredentialStatus
  /** 最后一次成功调用 Canvas 的时间，null = 从未成功调用过。 */
  lastUsedAt: string | null
  lastErrorAt: string | null
  /** 最近一次失败原因（给用户看的简短文案，不是堆栈）。 */
  lastErrorMessage: string | null
}

/**
 * Canvas 课程（GET /api/v1/canvas/courses 的响应项，P0-2-3 使用）。
 *
 * 只有 id / 名称 / 学期 —— Security-Privacy 第 6 节的最小权限要求：
 * 不返回成绩、花名册、教师联系方式等任何其他信息。
 */
export type CanvasCourse = {
  /** 源侧课程 ID，字符串形式（Canvas 给的是数字，但 ID 不参与算术，统一当字符串处理）。 */
  externalId: string
  name: string
  /** 学期名，如 "Fall 2026"。Canvas 可能不返回，缺失时为 null。 */
  term: string | null
}

/**
 * Canvas 作业（P0-2-5 同步的输入形状，`GET /api/v1/courses/:id/assignments` 的映射结果）。
 *
 * 刻意**不含** description / 花名册 / 教师信息等字段 ——
 * Security-Privacy 的最小权限要求：多拿一个字段就多一处合规义务。
 *
 * ### P0-3-17 扩了四个字段（都不增加请求数）
 * `htmlUrl` / `pointsPossible` / `submission.score` 全是**同一个 `include[]=submission`
 * 请求已经在返回体里的**内容（实测确认），扩映射不增加任何 Canvas 调用
 * —— 三级熔断（20 请求 / 60 秒 / 单课 3 页）不受影响。
 * 用途：`htmlUrl` → 任务名外链跳 Canvas；`score` + `pointsPossible` → 每作业分数条。
 *
 * ⚠️ `pointsPossible` 与 `submission.score` 都可能为 null，且**含义不同**：
 * 前者 null = Canvas 没设满分；后者 null = 尚未评分。**都不是 0**，
 * 展示层按「有值才画进度条」处理（Database.md §3.9：禁止用假值填充未知）。
 */
export type CanvasAssignment = {
  /** 源侧作业 ID（字符串），落库为 `tasks.source_id`，是去重的唯一依据。 */
  externalId: string
  title: string
  /**
   * Canvas 作业页地址（`html_url`）。实测**全量存在**（P0-3-17 只读探针）。
   * 缺失时为 null —— 任务名就退回纯文本，不编一个链接出来。
   */
  htmlUrl: string | null
  /** 该作业满分（`points_possible`）；null = Canvas 未设满分（**不是 0**）。 */
  pointsPossible: number | null
  /**
   * 截止时刻（ISO 8601）；`null` = Canvas 上没设截止日期。
   *
   * ⚠️ **不编造日期**（Database.md §3.9）：没有就是 null，落库后 UI 显示 TBD，
   * 绝不回填"学期末"之类的假值 —— 假日期比没有日期危险得多。
   */
  dueAt: string | null
  /** 该作业在 Canvas 上的最后更新时间，用于判断是否真的变了（Database.md §4.2）。 */
  externalUpdatedAt: string | null
  /**
   * Canvas 的 `submission_types`（决定有没有"提交"这回事）。
   * 含 `online_upload` / `online_text_entry` / `online_quiz` → 能自动判；
   * 含 `external_tool`（Gradescope 等 LTI 外链）→ Canvas 无提交记录，展示「待确认」；
   * 含 `none` / `not_graded` / `on_paper`（考勤打卡、纸质作业）→ **没有完成态**，永远保留手勾。
   */
  submissionTypes: string[]
  /**
   * 内联的"当前用户提交"对象（请求带 `include[]=submission` 时返回）。
   * `null` = Canvas 在此作业上没有该用户的提交记录（external_tool 外链类常为此态）。
   */
  submission: CanvasSubmission | null
}

/**
 * Canvas 公告（P0-3-25 同步的输入形状，`GET /api/v1/announcements` 的映射结果）。
 *
 * ### 与作业形状的两处关键差异
 * 1. **归属靠 `courseExternalId`**：批量端点一次回多门课，每条公告自带 `context_code`
 *    （形如 `course_1234`），映射时抽出来。没有它就无法判断"这条算谁的课"，会被丢弃。
 * 2. 🔴 **`bodyText` 是剥完标签的纯文本，不是 HTML 原文**。
 *    数据库里刻意不落 HTML（`course_announcements.body_text`），渲染层也禁
 *    `dangerouslySetInnerHTML` —— 两道一起才挡得住 stored XSS。想看原貌请点 `htmlUrl`。
 *
 * 同样不含作者、附件、已读状态等字段（Security-Privacy 最小权限）。
 */
export type CanvasAnnouncement = {
  /** 源侧公告 ID（字符串），落库为 `course_announcements.canvas_announcement_id`，去重的唯一依据。 */
  externalId: string
  /** 源侧**课程** ID（不是本地 uuid），用来映射到 `courses.canvas_course_id`。 */
  courseExternalId: string
  title: string
  /** 已剥标签 / 已解实体的纯文本正文。空串表示这条公告没有正文。 */
  bodyText: string
  /** 公告原页地址，用户点「原文」回跳 Canvas。缺失时为 null（渲染层退回不显示链接）。 */
  htmlUrl: string | null
  /** 发布时间（ISO 8601）；null = Canvas 没给。 */
  postedAt: string | null
}

/** 内联提交对象里 Tempo 用到的字段（P0-3-10，Canvas `submission` 的子集）。 */
export type CanvasSubmission = {
  /** `unsubmitted` / `submitted` / `pending_review` / `graded` / … */
  workflowState: string | null
  /** ISO 8601 或 null（未提交）。 */
  submittedAt: string | null
  /**
   * 当前用户得分（`submission.score`，P0-3-17）。null = 尚未评分（**不是 0 分**）。
   * 与 `CanvasAssignment.pointsPossible` 一起画分数条。
   */
  score: number | null
  /** Canvas 判定迟到。 */
  late: boolean
  /** Canvas 判定缺交（逾期且未交）。 */
  missing: boolean
}
