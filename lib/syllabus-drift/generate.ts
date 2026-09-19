/**
 * 大纲漂移的**按需路径**：下载那一个 syllabus 文件 → 抽文本 → 调模型 → 算出差异（P0-3-20）。
 *
 * ### 🔴 它走的是 ADR-026 的哪条路
 * ADR-026 把 3-19 的「绝不下载内容」限定到**索引路径**（同步）上，并明确：
 * 「**批量/后台路径零下载**，用户触发的路径才读内容、且原文不落库」。
 * 3-20 因此被切成两半：
 * - **同步侧**（`lib/sync/syllabus-drift.ts`）：只看 `course_files.modified_at`，零下载、零 LLM；
 * - **本文件**（用户打开消息栏后由 `POST /api/v1/messages/drift` 触发）：下载、抽取、调模型。
 * 于是"大纲变了"这件事仍然是**自动发现**的，而"到底变了什么"在你真的要看的时候才算。
 *
 * 这么切的第二个理由（不是推演）：定时同步跑在 **service role + 无请求上下文**，
 * `runStructured()` 的 `llm_runs` 审计写不进去（实测报 `cookies was called outside a request scope`）
 * —— 在同步路径调模型会打穿 ADR-003 的审计要求，而且只在 T1/T2 能跑（行为不一致）。
 *
 * ### 复用而不是重写
 * 取文件字节那一整条链（能力凭据换下载链 → 下载 → 抽文本）**原样复用 3-19b**：
 * `resolveDownloadUrl` / `downloadFile` / `MAX_DOWNLOAD_BYTES` / `extractSyllabusText`。
 * 那些函数里踩过的坑（Canvas 的 `url` 是能力凭据、`/download` 端点 404、扫描件抽出空串）
 * 不需要在第二个地方再踩一遍。
 *
 * ### 🔴 三道闸门都在"发请求之前"判（ADR-026）
 * ① 扩展名/MIME 白名单 ② 库里已知的 `size_bytes`（null 直接拒 —— 判不了成本宁可拒绝）
 * ③ 文件属于这门课且未被软删。图片 / 音视频 / 压缩包在这一步就被判掉，不下载、不调模型。
 *
 * ### 失败二分法（与 ADR-024/026 同一条）
 * **确定性失败**（抽不出文字、不是文字版 PDF、类型不支持）→ 写成 `driftStatus='failed'`，
 * **不再重试**（重试只会烧钱且结果相同）；**暂时性失败**（网络 / 5xx / 限流 / 凭据临时不可用）
 * → **不写回 payload**，下次打开消息栏自然重试。
 *
 * ### 🔴 红线
 * - 明文 token 只在 `loadDecryptedCredential()` 的返回值里，不进日志 / 响应 / 异常消息；
 * - **原文与抽取出的全文不落库、不落盘、不进日志** —— 只把差异结论与 ≤200 字符的摘录写进 payload。
 */

import {
  MAX_DOWNLOAD_BYTES,
  downloadFile,
  resolveDownloadUrl,
} from '@/lib/course-files/fetch-content'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { EXAM_DATE_COLUMNS, toExamDate } from '@/lib/exam-dates'
import type { ExamDateRow } from '@/lib/exam-dates'
import { GRADE_COMPONENT_COLUMNS, toGradeComponent } from '@/lib/grade-components'
import type { GradeComponentRow } from '@/lib/grade-components'
import { extractSyllabusText } from '@/lib/extract'
import { runStructured } from '@/lib/llm/run'
import {
  MAX_SOURCE_CHARS,
  SYLLABUS_DRIFT_PROMPT_VERSION,
  SYLLABUS_DRIFT_PURPOSE,
  attachBeforeValues,
  buildDriftMessages,
  driftSchema,
  validateDriftOutput,
} from '@/lib/syllabus-drift/prompt'
import type { CurrentExam } from '@/lib/syllabus-drift/prompt'
import type {
  MessageDrift,
  MessageDriftChangedExam,
  MessageDriftStatus,
  MessagePayload,
} from '@/types/message'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** `error_message` 上限（同 `llm_runs` 的纪律：精简、不含用户内容）。 */
const ERROR_MESSAGE_MAX = 200

/**
 * 低于这个字符数就不相信这份抽取结果。
 *
 * 实测一份 7 页的正常 syllabus 抽出来是 13,947 字符；而"扫了图片的 PDF"抽出来是 0。
 * 400 这个门槛卡的是中间地带：`extractSyllabusText` 只判"全空"，
 * 而"抽出一百来个字的页眉页脚"同样不可用 —— 那种文本上做出来的 diff 等于瞎猜。
 * 此时**不调模型**（省一次钱，也免得模型对着残片编出差异），直接判失败 + 低置信度。
 */
const MIN_TEXT_CHARS = 400

/** 气泡里最多列几行差异。「新增 1 条、变动 1 条」之外再多就是"该去课程页看"的信号。 */
const MAX_DETAIL_LINES = 10

/** 算一份差异的结果。`patch` 是要写回 `messages.payload` 的那部分。 */
export type DriftPatch = {
  driftStatus: MessageDriftStatus
  drift?: MessageDrift
  driftError?: string
  /** 结算后的 `payload.details`（气泡里那几行）。由服务端拼，界面不重算。 */
  details: string[]
  confidence: 'high' | 'low'
}

export type DriftOutcome =
  | { status: 'ready' | 'clean' | 'failed'; patch: DriftPatch }
  /**
   * 没算（**什么都不该写回**）。
   * `permanent: false` = 暂时性失败（网络 / 5xx / 限流）→ 下次打开消息栏自然重试。
   */
  | { status: 'skipped'; reason: string; message: string; permanent: boolean }

/** 库里那一行 `course_files`（本文件只需要这几列）。 */
type TargetFile = {
  id: string
  courseId: string
  displayName: string
  contentType: string | null
  sizeBytes: number | null
  modifiedAt: string | null
  canvasFileId: string | null
  isDeleted: boolean
}

async function loadTargetFile(
  supabase: ServerSupabase,
  courseId: string,
  syllabusFileId: string,
): Promise<{ file: TargetFile | null; error: string | null }> {
  const { data, error } = await supabase
    .from('course_files')
    .select('id, course_id, display_name, content_type, size_bytes, modified_at, canvas_file_id, is_deleted')
    .eq('id', syllabusFileId)
    .maybeSingle()

  if (error) return { file: null, error: error.message }
  if (!data) return { file: null, error: null }

  const row = data as {
    id: string
    course_id: string
    display_name: string
    content_type: string | null
    size_bytes: number | null
    modified_at: string | null
    canvas_file_id: string | null
    is_deleted: boolean
  }

  // 归属一致性：提案说的课与文件实际的课必须一致。不一致说明数据被改过 ——
  // 停下来报错，绝不"以文件为准"往另一门课写（与公告 applier 同一条纪律）。
  if (row.course_id !== courseId) return { file: null, error: null }

  return {
    file: {
      id: row.id,
      courseId: row.course_id,
      displayName: row.display_name,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      canvasFileId: row.canvas_file_id,
      isDeleted: row.is_deleted,
    },
    error: null,
  }
}

/** 读取这门课当前的考试 / 成绩构成（差异的另一半）。 */
async function loadCurrentSections(
  supabase: ServerSupabase,
  courseId: string,
): Promise<{
  exams: CurrentExam[]
  /** 供判定"能不能自动更正"的元数据，与 `exams` 同序同长。 */
  examMeta: Map<string, { source: string; isConfirmed: boolean }>
  components: { name: string; weightPercent: number | null }[]
  error: string | null
}> {
  const [examsRes, componentsRes] = await Promise.all([
    supabase.from('exam_dates').select(EXAM_DATE_COLUMNS).eq('course_id', courseId).order('created_at', { ascending: true }),
    supabase
      .from('grade_components')
      .select(GRADE_COMPONENT_COLUMNS)
      .eq('course_id', courseId)
      .order('created_at', { ascending: true }),
  ])

  const firstError = examsRes.error ?? componentsRes.error
  if (firstError) {
    return { exams: [], examMeta: new Map(), components: [], error: firstError.message }
  }

  const exams: CurrentExam[] = []
  const examMeta = new Map<string, { source: string; isConfirmed: boolean }>()
  for (const row of (examsRes.data ?? []) as ExamDateRow[]) {
    const exam = toExamDate(row)
    exams.push({
      id: exam.id,
      examName: exam.examName,
      examDate: exam.examDate,
      examTime: exam.examTime,
      location: exam.location,
    })
    examMeta.set(exam.id, { source: exam.source, isConfirmed: exam.isConfirmed })
  }

  const components = ((componentsRes.data ?? []) as GradeComponentRow[])
    .map(toGradeComponent)
    .map((item) => ({ name: item.name, weightPercent: item.weightPercent }))

  return { exams, examMeta, components, error: null }
}

/**
 * 算一份漂移差异。**不写库**（写回消息由 `ensureDrift` 负责）——
 * 这样在线探针可以在零写入的前提下跑完同一条链。
 *
 * @param record 是否写 `llm_runs` 审计行。业务调用用默认 true；
 *   独立脚本传 false（没有请求上下文，`cookies()` 会抛，且不该往审计表插探针噪音）。
 */
export async function computeDrift(input: {
  supabase: ServerSupabase
  userId: string
  courseId: string
  courseName: string
  syllabusFileId: string
  record?: boolean
}): Promise<DriftOutcome> {
  const { supabase, userId, courseId, courseName, syllabusFileId } = input

  const loaded = await loadTargetFile(supabase, courseId, syllabusFileId)
  if (loaded.error) {
    return { status: 'skipped', reason: 'file_load_failed', message: `读取文件信息失败：${loaded.error}`, permanent: false }
  }
  if (!loaded.file || loaded.file.isDeleted) {
    // 文件在 Canvas 上被删了 / 不是这门课的 → 确定性：再问一次也是这个答案。
    return {
      status: 'failed',
      patch: failurePatch('这个 syllabus 文件已经不在资料里了（老师可能在 Canvas 上删掉了它）。'),
    }
  }
  const file = loaded.file

  // ---------- 闸门 ①：抽得动吗（发请求之前判） ----------
  const ext = detectExtractableExtension(file.displayName, file.contentType)
  if (!ext) return { status: 'failed', patch: failurePatch(unsupportedReason(file.displayName, file.contentType)) }

  // ---------- 闸门 ②：大小（发请求之前判） ----------
  // 🔴 `size_bytes === null` 不下载（ADR-026 的红线）：判不了成本宁可拒绝。
  if (file.sizeBytes === null) {
    return { status: 'failed', patch: failurePatch('这个文件的大小未知，Tempo 不下载大小未知的文件。') }
  }
  if (file.sizeBytes > MAX_DOWNLOAD_BYTES) {
    return { status: 'failed', patch: failurePatch('这个文件太大，超过核对上限。') }
  }

  // ---------- 另一半：当前已确认的内容 ----------
  const sections = await loadCurrentSections(supabase, courseId)
  if (sections.error) {
    return { status: 'skipped', reason: 'sections_load_failed', message: `读取课程记录失败：${sections.error}`, permanent: false }
  }

  // ---------- 凭据 ----------
  //
  // 顺带把 `course_name` 也取回来：调用方（懒补路径）手里只有 payload 里的名字，
  // 而那是**同步当时**写下的。课程改过名的话，prompt 里的课程名会和库里的对不上，
  // 模型的结论本身不受影响（它核对的是正文与考试记录），但排障时会对不上账。
  // 取真值优先，payload 那份当兜底 —— 一次查询顺手做掉，不额外发请求。
  const courseRow = await supabase
    .from('courses')
    .select('canvas_course_id, course_name')
    .eq('id', courseId)
    .maybeSingle()
  if (courseRow.error) {
    return { status: 'skipped', reason: 'course_load_failed', message: `读取课程失败：${courseRow.error.message}`, permanent: false }
  }
  const courseFields = courseRow.data as { canvas_course_id: string | null; course_name: string } | null
  const canvasCourseId = courseFields?.canvas_course_id ?? null
  const effectiveCourseName = courseFields?.course_name ?? courseName
  if (!canvasCourseId || !file.canvasFileId) {
    return { status: 'failed', patch: failurePatch('这个文件缺少 Canvas 标识，无法定位。') }
  }

  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    return { status: 'skipped', reason: 'not_connected', message: '还没有连接 Canvas，无法取到大纲内容。', permanent: false }
  }
  if (credential.status !== 'active') {
    return { status: 'skipped', reason: 'credential_inactive', message: 'Canvas 连接已失效，请重新生成 token 后再试。', permanent: false }
  }

  // ---------- 下载（复用 3-19b 的那条链） ----------
  const resolved = await resolveDownloadUrl({
    domain: credential.canvasDomain,
    token: credential.token,
    canvasCourseId,
    canvasFileId: file.canvasFileId,
  })
  if (!resolved.url) {
    if (resolved.permanent) {
      return { status: 'failed', patch: failurePatch(resolved.message ?? '取下载链接失败。') }
    }
    return { status: 'skipped', reason: 'download_url_failed', message: resolved.message ?? '取下载链接失败', permanent: false }
  }

  const download = await downloadFile(resolved.url, MAX_DOWNLOAD_BYTES)
  if (!download.ok) {
    if (download.permanent) return { status: 'failed', patch: failurePatch(download.message) }
    return { status: 'skipped', reason: 'download_failed', message: download.message, permanent: false }
  }

  // ---------- 抽文本 ----------
  const extracted = await extractSyllabusText(ext, download.bytes)
  if (extracted.status !== 'extracted' || extracted.text === null) {
    // 「扫描件 / 图片型 PDF」抽出来正好是空串（或极短）→ **确定性失败**，不再重试。
    // 卡片要求的「置信度」在这里落地：这类提案一律标低，**不许一键接受**。
    return {
      status: 'failed',
      patch: failurePatch(extracted.error ?? '这份文件抽不出文字，无法核对。'),
    }
  }

  const text = extracted.text.slice(0, MAX_SOURCE_CHARS)
  const truncated = extracted.text.length > MAX_SOURCE_CHARS
  if (text.trim().length < MIN_TEXT_CHARS) {
    return {
      status: 'failed',
      patch: failurePatch(
        `这份大纲抽出来的文字太少（${text.trim().length} 字符），很可能不是文字版 PDF，无法可靠核对。`,
      ),
    }
  }

  // ---------- 调模型（用户触发路径，有请求上下文，审计能写） ----------
  const result = await runStructured<unknown>({
    userId,
    purpose: SYLLABUS_DRIFT_PURPOSE,
    record: input.record ?? true,
    promptVersion: SYLLABUS_DRIFT_PROMPT_VERSION,
    capability: 'text',
    schema: driftSchema(),
    schemaName: 'SyllabusDrift',
    messages: buildDriftMessages({
      courseName: effectiveCourseName,
      fileName: file.displayName,
      currentExams: sections.exams,
      currentComponents: sections.components,
      text,
    }),
    // 要的是**忠实对照**不是创作：温度高一点就会补出原文没有的考试。
    temperature: 0,
    maxOutputTokens: 1600,
  })

  if (!result.ok) {
    // 模型侧不稳定（429 / 超时 / 5xx）**不写回 payload** —— 下次打开自然重试。
    // 只有"模型稳定地给不出符合 schema 的结果"才值得判死（与 3-19b 同一条分法）。
    const message = `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX)
    console.error('[syllabus-drift] 调用模型失败:', courseId, message)
    if (result.error.code === 'schema_mismatch' || result.error.code === 'refused') {
      return { status: 'failed', patch: failurePatch(`AI 核对失败：${result.error.message}`) }
    }
    return { status: 'skipped', reason: 'llm_failed', message: '核对服务暂时不可用', permanent: false }
  }

  const validated = validateDriftOutput(
    result.data,
    sections.exams.map((exam) => exam.id),
  )
  if (!validated.ok) {
    return { status: 'failed', patch: failurePatch(`AI 没能读通这份大纲（${validated.message}）。`) }
  }

  if (validated.dropped > 0) {
    // 不拦（已算出的照常给用户），但留痕："模型开始写超量条目"是 prompt 该修的早期信号。
    console.warn(`[syllabus-drift] 模型多写了 ${validated.dropped} 条，已丢弃:`, courseId)
  }

  const { changes, missing } = attachBeforeValues(validated.draft.changes, sections.exams)
  if (missing.length > 0) {
    console.warn('[syllabus-drift] 变动指向的考试已不存在，已丢弃:', missing.join('、'))
  }

  // ---------- 能不能自动更正（2026-09-18 Steven 拍板） ----------
  //
  // 🔴 只改 `source='syllabus'` 且 `is_confirmed=false` 的行。用户亲手确认过的那一行
  // 是权威源（ADR-015），**绝不自动覆盖** —— 只能提示他去课程页改。
  const changedExams: MessageDriftChangedExam[] = changes.map((change) => {
    const meta = sections.examMeta.get(change.id)
    const writable = meta?.source === 'syllabus' && meta.isConfirmed === false
    return {
      id: change.id,
      examName: change.examName,
      before: change.before,
      after: change.after,
      examDate: change.examDate,
      examTime: change.examTime,
      location: change.location,
      sourceExcerpt: change.sourceExcerpt,
      writable,
      blockedReason: writable
        ? null
        : '这条你已经确认过，Tempo 不自动覆盖 —— 请到课程页手动修改',
    }
  })

  const drift: MessageDrift = {
    addedExams: validated.draft.addedExams,
    changedExams,
    addedComponents: validated.draft.addedComponents,
    notes: validated.draft.notes,
    sourceChars: text.length,
    model: result.usage.model,
  }

  const writableChanges = changedExams.filter((change) => change.writable).length
  const hasWork = drift.addedExams.length + writableChanges + drift.addedComponents.length > 0

  const details = buildDetails({
    drift,
    skipped: validated.skipped,
    truncated,
  })

  return {
    status: hasWork ? 'ready' : 'clean',
    patch: {
      driftStatus: hasWork ? 'ready' : 'clean',
      drift,
      // 🔴 `uncertain` → 低置信度 → 不许一键接受（卡片要求的闸）。
      // 只有"真的有东西要写"时这个闸才有意义；`clean` 不写任何数据，见 `lib/messages/view.ts`。
      confidence: validated.draft.uncertain ? 'low' : 'high',
      details: hasWork
        ? details
        : [
            '已核对：Canvas 上的大纲与你的记录一致，没有需要写入的变更',
            ...details.slice(0, MAX_DETAIL_LINES - 1),
          ],
    },
  }
}

/**
 * 算出来之后把结果写回消息的 payload（`pending` → `ready` / `clean` / `failed`）。
 *
 * 返回**写进去的那一份 payload**（而不只是"成功没成功"）：调用方要把更新后的
 * `Message` 直接还给客户端，而重查一次库既多一次往返、又引入"读到的是不是刚写的那份"
 * 的疑问（两次读之间可能被别的请求改过）。这里给的就是本次真正落库的字节。
 */
export async function persistDrift(
  supabase: ServerSupabase,
  messageId: string,
  payload: Record<string, unknown>,
  patch: DriftPatch,
): Promise<{ error: string | null; payload: MessagePayload | null }> {
  const next = {
    ...payload,
    driftStatus: patch.driftStatus,
    details: patch.details,
    confidence: patch.confidence,
    ...(patch.drift ? { drift: patch.drift } : {}),
    ...(patch.driftError ? { driftError: patch.driftError } : {}),
  }

  const { error } = await supabase.from('messages').update({ payload: next }).eq('id', messageId)
  if (error) return { error: error.message, payload: null }
  return { error: null, payload: next as MessagePayload }
}

/** 确定性失败的一整套回写（状态 + 人话 + 低置信度）。 */
function failurePatch(message: string): DriftPatch {
  const trimmed = message.slice(0, ERROR_MESSAGE_MAX)
  return {
    driftStatus: 'failed',
    driftError: trimmed,
    // 🔴 失败一律标低置信度：卡片要求"低置信度不许一键接受"。
    // 状态本身也已经拦住了确认按钮，这里是双保险（两条判据都指向同一个结论）。
    confidence: 'low',
    details: [`无法核对这份大纲：${trimmed}`, '可以点下面的「原文 ↗」到 Canvas 上看，或到课程页手动修改'],
  }
}

/**
 * 把差异拼成气泡里那几行（人话）。
 *
 * 为什么在服务端拼：同一句话要出现在**气泡**与**确认后的回执**两处，
 * 各拼一遍就会漂成两种说法（CodingRules §10.1 第 21 条的形状）。
 */
export function buildDetails(input: {
  drift: MessageDrift
  skipped: string[]
  truncated: boolean
}): string[] {
  const { drift, skipped, truncated } = input
  const lines: string[] = []

  for (const exam of drift.addedExams) {
    lines.push(`新增考试：${exam.examDate === null ? `${exam.examName}（日期待定）` : `${exam.examName} · ${exam.examDate}`}`)
  }
  for (const change of drift.changedExams) {
    lines.push(`变动：${change.before} → ${change.after}`)
  }
  for (const component of drift.addedComponents) {
    lines.push(
      `新增成绩构成：${component.weightPercent === null ? `${component.name}（未标占比）` : `${component.name} · ${component.weightPercent}%`}`,
    )
  }
  for (const note of drift.notes) {
    lines.push(`其他：${note}`)
  }

  const blocked = drift.changedExams.filter((change) => !change.writable).length
  if (blocked > 0) {
    lines.push(`${blocked} 条变动命中了你已确认过的记录，Tempo 不自动改 —— 请到课程页手动修改`)
  }
  if (truncated) {
    lines.push('这份大纲很长，只核对了前面一部分 —— 请到 Canvas 上看完整原文')
  }
  if (skipped.length > 0) {
    lines.push(`另有 ${skipped.length} 条读不出原文依据的条目未计入（${skipped[0]}）`)
  }

  if (lines.length <= MAX_DETAIL_LINES) return lines
  const shown = lines.slice(0, MAX_DETAIL_LINES)
  shown.push(`另有 ${lines.length - MAX_DETAIL_LINES} 条差异未列出，请到课程页查看`)
  return shown
}
