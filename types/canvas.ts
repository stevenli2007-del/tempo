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
