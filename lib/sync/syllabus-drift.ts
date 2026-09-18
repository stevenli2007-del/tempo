import { pickSyllabusFile, decideDrift, toSyllabusFileCandidate } from '@/lib/syllabus-drift/files'
import type { CourseFileDriftRow, DriftAnchor, SyllabusFileCandidate } from '@/lib/syllabus-drift/files'
import type { MessagePayload } from '@/types/message'
import type { SyncDriftSummary } from '@/types/sync'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * 大纲漂移的**检测**（P0-3-20 同步侧）—— 零下载、零 LLM。
 *
 * ### 为什么这里一个字节都不下载
 * ADR-026 把 3-19 的「绝不下载内容」限定到**索引路径**上，并明确点名 3-20：
 * 「批量/后台路径零下载，用户触发的路径才读内容」。所以这一步只做一件事：
 * **拿 `course_files` 已有的元数据，比一比这门课的大纲文件版本变了没有**。
 * 真去下载那份 PDF、抽文本、算差异，发生在用户打开消息栏之后
 * （`POST /api/v1/messages/drift` → `lib/syllabus-drift/generate.ts`）。
 *
 * ### 零成本是怎么做到的
 * 资料索引（P0-3-19）本来就在同步里跑，`course_files.modified_at` 已经在库里了。
 * 于是本步骤：**1 个 SELECT**（一次把本轮所有课的候选文件捞回来，内存里挑）、
 * **0 个 Canvas 请求**、**0 次模型调用**。不占 §5 的 20 请求预算，也不会把作业挤掉。
 *
 * ⚠️ 代价要说清：**漂移检测的新鲜度 = 资料索引的新鲜度（24h）**。
 * 老师改完 syllabus，最长可能一天后才被发现。这是刻意的取舍 ——
 * 为了分钟级新鲜度去每轮同步下载 PDF，换掉的是主同步的预算与 ADR-026 的红线。
 *
 * ### 🔴 三条纪律
 * 1. **401/403 只跳过**，绝不写 `canvas_credentials.status`（ADR-025）——
 *    本步骤其实一个 Canvas 请求都不发，但"这门课没有可访问的 Files 区"
 *    在 `course_files` 里就表现为"没有候选文件"，同样只是跳过。
 * 2. **失败不进 `failures`、不改同步 `status`**：与公告（3-25）、资料（3-19）同一条 ——
 *    附加能力挂掉不代表作业没同步上，混进去会让 `coursesFailed` 虚高、归因错误。
 * 3. **`.in('course_id', …)` 收口是必须的**：定时同步传进来的是 **service role** 客户端，
 *    RLS 不生效；少了这一行会读到（并据此改）别人的课程锚点。
 *    写 `courses` 时再加 `.eq('user_id', userId)` —— 与 `lib/sync/canvas-files.ts` 同一条。
 *
 * ### 🔴 幂等：锚点先推进、消息后建（刻意，与 3-25 同一条取舍）
 * 反过来（先建消息再推锚点）在锚点写失败时会**每轮重复投递**同一条提案 ——
 * 「用户看到两条一模一样的公告」是最伤信任的一类 bug（3-25 文件头）。
 * 所以这里的取舍是：**宁可少投一次，也不重复投**，消息建失败时留日志（含课程 id，可查）。
 * 代价如实记下：那一次变更会永久丢失（锚点已推进，下一轮不会再判"变了"）。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** 待判的一门课。 */
export type DriftTarget = {
  /** 本地课程 uuid。 */
  id: string
  courseName: string
  /** `courses` 上的差量锚点（这两列由 `canvas-sync.ts` 一并查出来）。 */
  anchor: DriftAnchor
}

/** 本卡只查这几列 —— 与 `toSyllabusFileCandidate` 一一对应。 */
const COURSE_FILE_COLUMNS =
  'id, course_id, canvas_file_id, display_name, folder_path, content_type, size_bytes, modified_at, file_url, is_deleted'

/**
 * 建一条 `syllabus_drift` 提案（`pending`：差异还没算）。
 *
 * 标题刻意**不含结论**（"改期了"之类）—— 此刻我们只知道"文件变了"，
 * 还不知道变了什么。写一个猜的结论就是诬告；真结论由懒补 diff 填进 `details`。
 */
export function buildDriftPayload(input: {
  courseId: string
  courseName: string
  file: SyllabusFileCandidate
}): MessagePayload {
  const { courseId, courseName, file } = input
  return {
    title: `${courseName} 的大纲文件有更新`,
    details: [
      `Canvas 上的「${file.displayName}」这一版与你核对过的版本不同`,
      '正在核对差异…（若这行一直不动，可点下面的「原文 ↗」直接看 Canvas 上那份）',
    ],
    courseId,
    courseName,
    // 拿来核对原文的入口：**拼出来的 Canvas 预览页**（3-19 已落库），
    // 不是 Canvas 返回的能力凭据 URL（ADR-026 第 3 条）。
    sourceUrl: file.fileUrl,
    syllabusFileId: file.id,
    syllabusModifiedAt: file.modifiedAt,
    driftStatus: 'pending',
    // Canvas 上是权威文件、且我们只是"发现它变了"：置信度在这里不适用（差异还没算），
    // 真置信度由懒补那一步产出（`uncertain` → low）。
    confidence: 'high',
  }
}

/**
 * 跑一轮漂移检测。**不抛异常**：任何失败都收敛到 `error` 字段。
 *
 * 与公告 / 资料两步同一条：附加能力失败不改整次同步的状态，但**不被吞** ——
 * 结果会进 `sync_runs.error_message` 与日志。
 */
export async function syncSyllabusDrift(input: {
  supabase: SupabaseClient
  userId: string
  targets: DriftTarget[]
}): Promise<SyncDriftSummary> {
  const { supabase, userId, targets } = input

  const summary: SyncDriftSummary = {
    status: 'success',
    coursesChecked: 0,
    baselined: 0,
    proposed: 0,
    unchanged: 0,
    noFile: 0,
    error: null,
  }

  if (targets.length === 0) return summary

  // ---------- 1) 一次把本轮所有课的候选文件捞回来（0 个 Canvas 请求） ----------
  const courseIds = targets.map((target) => target.id)
  const { data, error } = await supabase
    .from('course_files')
    .select(COURSE_FILE_COLUMNS)
    .in('course_id', courseIds)
    .eq('is_deleted', false)

  if (error) {
    return { ...summary, status: 'failed', error: `读取资料索引失败：${error.message}` }
  }

  const rows = (data ?? []) as CourseFileDriftRow[]
  const byCourse = new Map<string, SyllabusFileCandidate[]>()
  for (const row of rows) {
    const list = byCourse.get(row.course_id)
    const candidate = toSyllabusFileCandidate(row)
    if (list) list.push(candidate)
    else byCourse.set(row.course_id, [candidate])
  }

  // ---------- 2) 逐课判 ----------
  const errors: string[] = []

  for (const target of targets) {
    summary.coursesChecked += 1

    const candidate = pickSyllabusFile(byCourse.get(target.id) ?? [])
    const decision = decideDrift({ anchor: target.anchor, candidate })

    if (decision.kind === 'skip') {
      if (decision.reason === 'no_file') summary.noFile += 1
      else summary.unchanged += 1
      continue
    }

    if (decision.kind === 'baseline') {
      const written = await writeAnchor(supabase, userId, target.id, decision.candidate)
      if (!written.ok) errors.push(`${target.courseName}：${written.error}`)
      else summary.baselined += 1
      continue
    }

    // decision.kind === 'propose' —— 文件真的变了。
    const file = decision.candidate

    // 🔴 顺序（见文件头）：锚点先推进，再建消息。
    const written = await writeAnchor(supabase, userId, target.id, file)
    if (!written.ok) {
      errors.push(`${target.courseName}：${written.error}`)
      continue
    }

    const messageId = await insertDriftMessage(
      supabase,
      userId,
      buildDriftPayload({ courseId: target.id, courseName: target.courseName, file }),
    )
    if (messageId) summary.proposed += 1
  }

  if (errors.length > 0) {
    summary.status = 'failed'
    summary.error = errors[0]
  }
  return summary
}

/**
 * 写回这门课的大纲锚点。
 *
 * 🔴 `.eq('user_id', userId)` 不是冗余：定时同步传进来的是 **service role** 客户端，
 * RLS 不生效。少了这一行，一个串了的 courseId 会去改别人的课程行
 * （与 `lib/sync/canvas-files.ts` 的 `markScanned` 同一条理由）。
 */
async function writeAnchor(
  supabase: SupabaseClient,
  userId: string,
  courseId: string,
  candidate: SyllabusFileCandidate,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('courses')
    .update({
      syllabus_file_id: candidate.id,
      // 存的是**文件版本**（`course_files.modified_at`），不是"现在几点"。
      syllabus_seen_modified_at: candidate.modifiedAt,
    })
    .eq('id', courseId)
    .eq('user_id', userId)

  if (error) {
    console.error('[sync] 写回大纲锚点失败:', courseId, error.message)
    return { ok: false, error: `写回大纲锚点失败：${error.message}` }
  }
  return { ok: true }
}

/**
 * 建一条漂移提案。成功返回 id，失败返回 null（**并留日志**）。
 *
 * 与 3-25 的 `insertAnnouncementMessage` 同一条取舍：失败**不回滚锚点**。
 * 理由见文件头 —— 宁可少投一次，也不重复投。
 */
async function insertDriftMessage(
  supabase: SupabaseClient,
  userId: string,
  payload: MessagePayload,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ user_id: userId, type: 'syllabus_drift', payload, status: 'pending' })
    .select('id')
    .single()

  if (error) {
    // 锚点已推进 → 这一条**不会再重投**（取舍见文件头）。留课程信息便于事后排查。
    console.error('[sync] 大纲漂移提案创建失败（锚点已推进，本条不再重投）:', payload.courseId, error.message)
    return null
  }
  return (data as { id: string }).id
}
