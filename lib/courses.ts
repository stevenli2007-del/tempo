import type {
  Course,
  CourseSyncStatus,
  CreateCourseInput,
  UpdateCourseInput,
} from '@/types/course'

/**
 * courses 表在数据库中的行（snake_case，与 Database.md 第 3.2 节一致）。
 * 只有这一处知道数据库列名，其余代码一律用 camelCase 的 Course。
 */
export type CourseRow = {
  id: string
  semester: string
  course_name: string
  course_code: string | null
  instructor_name: string | null
  canvas_course_id: string | null
  is_demo: boolean
  is_archived: boolean
  last_synced_at: string | null
  sync_status: string
  sync_error: string | null
}

/** 列表与详情查询统一用这份 select，避免各处字段不齐导致形状漂移。 */
export const COURSE_COLUMNS =
  'id, semester, course_name, course_code, instructor_name, canvas_course_id, is_demo, is_archived, last_synced_at, sync_status, sync_error'

/** 与迁移 20260902003000 :59-60 的 CHECK 约束保持一致。 */
const SYNC_STATUSES = new Set<string>(['never', 'success', 'failed'])

export function toCourse(row: CourseRow): Course {
  return {
    id: row.id,
    semester: row.semester,
    courseName: row.course_name,
    courseCode: row.course_code,
    instructorName: row.instructor_name,
    isDemo: row.is_demo,
    isArchived: row.is_archived,
    canvasCourseId: row.canvas_course_id,
    canvasLinked: row.canvas_course_id !== null,
    lastSyncedAt: row.last_synced_at,
    syncStatus: toSyncStatus(row.sync_status),
    syncError: row.sync_error,
  }
}

/**
 * 收窄 sync_status。
 *
 * 数据库有 CHECK 约束保证取值闭合，正常永远走不到 throw。这里选择抛错而不是给个
 * 兜底值——sync_status 会被直接展示成"最后同步于 X / 同步失败"，编一个状态出来
 * 就是静默的错误数据（CodingRules 7：不吞异常、不编造）。
 */
function toSyncStatus(value: string): CourseSyncStatus {
  if (!SYNC_STATUSES.has(value)) {
    throw new Error(`courses.sync_status 出现约束外的取值: ${value}`)
  }
  return value as CourseSyncStatus
}

// ---------- 输入校验 ----------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

const MAX_SEMESTER = 50
const MAX_COURSE_NAME = 120
const MAX_COURSE_CODE = 50
const MAX_INSTRUCTOR_NAME = 120

/** 标记"字段类型不对"，与"字段没传"（undefined）和"清空字段"（null）区分开。 */
const INVALID = Symbol('invalid')

function normalizeText(value: unknown): string | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return INVALID
  const trimmed = value.trim()
  // 空串视为"清空该字段"，而不是存一个空字符串进去。
  return trimmed === '' ? null : trimmed
}

function isInvalid(value: unknown): boolean {
  return value === INVALID
}

export function parseCreateCourseInput(body: unknown): ValidationResult<CreateCourseInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const raw = body as Record<string, unknown>

  const semester = normalizeText(raw.semester)
  const courseName = normalizeText(raw.courseName)
  const courseCode = normalizeText(raw.courseCode)
  const instructorName = normalizeText(raw.instructorName)

  if ([semester, courseName, courseCode, instructorName].some(isInvalid)) {
    return { ok: false, message: '字段类型错误：文本字段必须是字符串' }
  }
  // 上面已排除 INVALID，这里都是 string | null | undefined。
  const s = semester as string | null | undefined
  const n = courseName as string | null | undefined
  const c = courseCode as string | null | undefined
  const i = instructorName as string | null | undefined

  if (!s) return { ok: false, message: '学期不能为空' }
  if (!n) return { ok: false, message: '课程名不能为空' }
  if (s.length > MAX_SEMESTER) return { ok: false, message: `学期不能超过 ${MAX_SEMESTER} 个字符` }
  if (n.length > MAX_COURSE_NAME)
    return { ok: false, message: `课程名不能超过 ${MAX_COURSE_NAME} 个字符` }
  if (c && c.length > MAX_COURSE_CODE)
    return { ok: false, message: `课程编码不能超过 ${MAX_COURSE_CODE} 个字符` }
  if (i && i.length > MAX_INSTRUCTOR_NAME)
    return { ok: false, message: `教师姓名不能超过 ${MAX_INSTRUCTOR_NAME} 个字符` }

  return {
    ok: true,
    value: { semester: s, courseName: n, courseCode: c ?? null, instructorName: i ?? null },
  }
}

/**
 * PATCH 的语义：undefined = 这个字段不改，null = 清空这个字段。
 * semester / courseName 是数据库 NOT NULL 字段，因此不允许被清空。
 */
export function parseUpdateCourseInput(body: unknown): ValidationResult<UpdateCourseInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const raw = body as Record<string, unknown>

  const semester = normalizeText(raw.semester)
  const courseName = normalizeText(raw.courseName)
  const courseCode = normalizeText(raw.courseCode)
  const instructorName = normalizeText(raw.instructorName)

  if ([semester, courseName, courseCode, instructorName].some(isInvalid)) {
    return { ok: false, message: '字段类型错误：文本字段必须是字符串' }
  }

  const s = semester as string | null | undefined
  const n = courseName as string | null | undefined
  const c = courseCode as string | null | undefined
  const i = instructorName as string | null | undefined

  if ([s, n, c, i].every((v) => v === undefined)) {
    return { ok: false, message: '没有需要更新的字段' }
  }
  if (s !== undefined && !s) return { ok: false, message: '学期不能为空' }
  if (n !== undefined && !n) return { ok: false, message: '课程名不能为空' }
  if (s && s.length > MAX_SEMESTER)
    return { ok: false, message: `学期不能超过 ${MAX_SEMESTER} 个字符` }
  if (n && n.length > MAX_COURSE_NAME)
    return { ok: false, message: `课程名不能超过 ${MAX_COURSE_NAME} 个字符` }
  if (c && c.length > MAX_COURSE_CODE)
    return { ok: false, message: `课程编码不能超过 ${MAX_COURSE_CODE} 个字符` }
  if (i && i.length > MAX_INSTRUCTOR_NAME)
    return { ok: false, message: `教师姓名不能超过 ${MAX_INSTRUCTOR_NAME} 个字符` }

  const patch: UpdateCourseInput = {}
  if (s !== undefined) patch.semester = s
  if (n !== undefined) patch.courseName = n
  if (c !== undefined) patch.courseCode = c
  if (i !== undefined) patch.instructorName = i
  return { ok: true, value: patch }
}

// ---------- 同步状态（P0-2-5） ----------

/**
 * 同步结果写入的列。
 *
 * ⚠️ **`sync_status` 只有 `success` / `failed` 两个取值，没有 `partial`**
 * （迁移 `20260902003000` :59-60 的 CHECK 约束只放行 never / success / failed）。
 *
 * 这不是遗漏：`partial` 天然是**一批**同步的属性（"N 门成功 M 门失败"），
 * 不是某一门课的属性 —— 一门课的同步要么成功要么失败。
 * 所以整体状态记在 `sync_runs.status`（它的 CHECK 含 `partial`），
 * 逐课状态记在 `courses.sync_status`，两者合起来正好是 Sync-Strategy §9 要展示的东西，
 * 且**不需要改表结构**（改 CHECK 约束要 Steven 手动跑 SQL，能不欠就不欠）。
 */
export function toSyncStateUpdate(state: {
  lastSyncedAt: string
  syncStatus: 'success' | 'failed'
  syncError: string | null
}): {
  last_synced_at: string
  sync_status: string
  sync_error: string | null
} {
  return {
    last_synced_at: state.lastSyncedAt,
    sync_status: state.syncStatus,
    sync_error: state.syncError,
  }
}

// ---------- Canvas 关联（P0-2-4） ----------

/**
 * Canvas 课程 ID 的外形约束。
 *
 * Canvas 给的是数字（`1558822`），Tempo 只当字符串存（ID 不参与算术）。
 * 字符集限制到「字母数字 + 连字符 + 下划线」并限长，是为了挡住误粘贴的
 * 一整段文本 —— 那种值关联进去，同步时只会变成一个永远拉不到的课程号。
 *
 * 刻意**不**去 Canvas 校验这个 ID 是否真的存在：那要多发一次上游请求
 * （连带限流与失败分支），而 UI 只能从列表里选，直接调 API 的人填错了
 * 最坏也就是同步时拿不到作业（P0-2-5 会明确报错）。不为一个理论上的
 * 误用付出一次真实的网络往返。
 */
const CANVAS_COURSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * 校验 `POST /canvas-link` 的请求体，返回 trim 后的 Canvas 课程 ID。
 */
export function parseCanvasLinkInput(body: unknown): ValidationResult<string> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }

  const value = (body as Record<string, unknown>).externalCourseId
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'externalCourseId 必填' }
  }

  const externalCourseId = value.trim()
  if (!CANVAS_COURSE_ID_PATTERN.test(externalCourseId)) {
    return { ok: false, message: 'externalCourseId 不是合法的 Canvas 课程 ID' }
  }

  return { ok: true, value: externalCourseId }
}

/**
 * 关联与解除关联都只动这一列 —— 列名只在 `lib/courses.ts` 出现一次。
 *
 * @param externalCourseId 关联目标；`null` = 解除关联。
 */
export function toCanvasCourseIdUpdate(externalCourseId: string | null): { canvas_course_id: string | null } {
  return { canvas_course_id: externalCourseId }
}

// ---------- 写库用的列映射 ----------

export function toCourseInsert(input: CreateCourseInput) {
  return {
    semester: input.semester,
    course_name: input.courseName,
    course_code: input.courseCode ?? null,
    instructor_name: input.instructorName ?? null,
  }
}

/** 只输出本次真正要改的列，避免把没传的字段写成 null。 */
export function toCourseUpdate(patch: UpdateCourseInput): Record<string, string | null> {
  const update: Record<string, string | null> = {}
  if (patch.semester !== undefined) update.semester = patch.semester
  if (patch.courseName !== undefined) update.course_name = patch.courseName
  if (patch.courseCode !== undefined) update.course_code = patch.courseCode
  if (patch.instructorName !== undefined) update.instructor_name = patch.instructorName
  return update
}
