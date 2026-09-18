import {
  MAX_PAGES_PER_COURSE_FILES,
  filePreviewUrl,
  filesPath,
  folderPathById,
  foldersPath,
  toCanvasFiles,
  toCanvasFolders,
} from '@/lib/canvas/files'
import { sameNumber } from '@/lib/numbers'
import { sameInstant } from '@/lib/time'
import {
  MAX_REQUESTS_PER_SYNC,
  fetchCanvasPages,
  type CanvasBudget,
} from '@/lib/sync/canvas-request'
import type { CanvasFile, CanvasFolder } from '@/types/canvas'
import type { SyncFileSummary } from '@/types/sync'

import type { getCurrentUser } from '@/lib/api/response'

/**
 * Canvas 文件**元数据** → `course_files` 表的落库与编排（P0-3-19）。
 *
 * ### 🔴 本文件最重要的三条纪律（改这里之前先读完）
 *
 * **1. `/files` 的 403 是常态，绝不能当凭证失效**
 * 实测（2026-09-18，Steven 真账号）：**14 门课里 8 门** `/files` 返回 403
 * （Assessment Pilot / GBA / Hazing Prevention / PartySafe / SHAPE …
 * —— 这些课压根没开 Files 区），而同一个 token 打它们的 `/assignments` 与 `/folders` 全是 200。
 * 若按 Sync-Strategy §8 的通用规则把它判成 `unauthorized` →
 * 会立刻 `markCredentialFailed` 并**停掉该用户的全部同步**。
 * --------- 凭证明明有效，却被一门没开 Files 的课连坐 ---------
 * 故本模块的 401/403 **只跳过那门课，绝不写凭证状态**。
 * **凭证有效性只由作业同步判定**（`lib/sync/canvas-sync.ts` 里作业跑在最前面，
 * token 真失效时根本轮不到本模块）。
 *
 * **2. 资料区是附加能力，它的失败不污染同步主状态**
 * 与公告（P0-3-25）同一条：它挂掉时把整次同步判成 `partial`，
 * 用户会以为作业也没同步上 —— 那是误报。失败只记进 `SyncFileSummary.error` 与日志。
 *
 * **3. 拉取不完整时绝不做删除判定**（Sync-Strategy §7）
 * `complete: false`（翻页触顶 / 预算耗尽）时跳过软删除 ——
 * 一次不完整的拉取会把没拿到的行判成"老师删掉了它们"，那是同步里最伤用户的事故。
 *
 * ### 为什么先打 `/files` 再打 `/folders`
 * 顺序是**省请求**的：8/14 的课 `/files` 直接 403，先打它就能在花第二个请求之前收工。
 * 反过来（先 folders）等于每门没开 Files 的课都白烧一个请求 —— 而单次同步只有 20 个预算。
 *
 * ### 🔴 日志红线（Security-Privacy 第 8 节）
 * 明文 token 只在参数里，不进日志、不进响应、不进异常消息。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/**
 * 一门课的资料区多久重扫一次（默认 24 小时）。
 *
 * ### 为什么要有这个门槛
 * 单次同步的 Canvas 请求预算是 **20 个**（Sync-Strategy §5），作业要 N 个、公告 1 个。
 * 资料区每门课 2 个请求，若每轮都扫，6 门课 = 12 个 —— **会定期把预算吃满**，
 * 结果是作业还没同步完就被熔断，主功能被附加功能挤掉。
 * 而文件目录是低频变化的（老师传一次课件可能几周不动），所以走独立节奏。
 *
 * ⚠️ 这是**预算保护**，不是新鲜度承诺：老师刚传的文件最长可能 24 小时后才出现。
 * 这是刻意接受的代价 —— 拿主同步的预算换课件目录的分钟级新鲜度不划算。
 * 手动刷新（T2）会**无视**这个门槛：用户点了刷新就该立刻看到（与 T2 放宽同一条纪律）。
 */
export const FILES_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 同步读取这几列只为了「和本次拉到的比对」。 */
const EXISTING_COLUMNS =
  'id, canvas_file_id, display_name, content_type, size_bytes, folder_path, file_url, modified_at, is_deleted'

/** 待扫描的一门课。 */
export type FileTarget = {
  /** 本地课程 uuid。 */
  id: string
  courseName: string
  /** Canvas 侧课程 ID。 */
  canvasCourseId: string
  /** 上次扫描资料区的时刻；null = 从没扫过。 */
  filesScannedAt: string | null
}

/** 一行待写入的 `course_files`。 */
type FileRow = {
  canvas_file_id: string
  display_name: string
  content_type: string | null
  size_bytes: number | null
  folder_path: string
  file_url: string
  modified_at: string | null
}

export async function syncCourseFiles(input: {
  supabase: SupabaseClient
  /**
   * 用户 ID。本模块按 `courseId` 操作（`course_files` 没有 `user_id` 列），
   * 但写 `courses.files_scanned_at` 时必须带上它 —— 定时同步走 service role，RLS 不生效。
   */
  userId: string
  domain: string
  token: string
  targets: FileTarget[]
  budget: CanvasBudget
  startedAtMs: number
  /** 本次同步的时刻（ISO 串），写 `courses.files_scanned_at`。 */
  now: string
  /** 无视 24 小时门槛（手动刷新用）。 */
  force: boolean
}): Promise<SyncFileSummary> {
  const { supabase, userId, domain, token, targets, budget, startedAtMs, now, force } = input

  const summary: SyncFileSummary = {
    status: 'success',
    coursesScanned: 0,
    coursesSkipped: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    hiddenSkipped: 0,
    incomplete: false,
    error: null,
  }

  if (targets.length === 0) return summary

  const errors: string[] = []

  for (const target of targets) {
    // ---------- 预算：留两个请求给资料区，不够就整门课留给下一轮 ----------
    //
    // 作业同步跑在前面且优先级更高；这里**不抢占**它的预算。
    // 熔断不是故障（Sync-Strategy §6.3）：剩下的课下次再补，标 `partial` 就够。
    if (budget.requestsUsed + 2 > MAX_REQUESTS_PER_SYNC) {
      summary.coursesSkipped += 1
      continue
    }

    // ---------- 24 小时门槛（手动刷新除外） ----------
    if (!force && scannedRecently(target.filesScannedAt, Date.now())) {
      summary.coursesSkipped += 1
      continue
    }

    // ---------- 1) 先打 /files：403 直接收工，省掉 /folders 那一个请求 ----------
    const files = await fetchCanvasPages<CanvasFile>({
      domain,
      token,
      path: filesPath(target.canvasCourseId),
      budget,
      startedAtMs,
      maxPages: MAX_PAGES_PER_COURSE_FILES,
      map: toCanvasFiles,
    })

    if (!files.ok) {
      // 🔴 401/403 一律只跳过这门课，**绝不写凭证状态**（纪律 1）。
      // 「没开 Files 区」是一门课的稳定事实，24h 内不再试 —— 不设门槛的话
      // 这 8 门课每轮同步都会白烧一个请求。
      await markScanned(supabase, userId, target.id, now)
      summary.coursesSkipped += 1
      if (files.kind !== 'unauthorized' && files.kind !== 'not_found') {
        // 5xx / 超时 / 网络是**真的出错**：不设门槛（下一轮该重试），并记进 error。
        await markScanned(supabase, userId, target.id, null)
        errors.push(`${target.courseName}：${files.message}`)
      }
      continue
    }

    if (budget.requestsUsed + 1 > MAX_REQUESTS_PER_SYNC) {
      // 只剩一个请求了：宁可这轮不建目录，也不让文件夹拉取把预算打穿。
      summary.coursesSkipped += 1
      continue
    }

    // ---------- 2) 再打 /folders：拿每个文件夹的路径 ----------
    const folders = await fetchCanvasPages<CanvasFolder>({
      domain,
      token,
      path: foldersPath(target.canvasCourseId),
      budget,
      startedAtMs,
      maxPages: MAX_PAGES_PER_COURSE_FILES,
      map: toCanvasFolders,
    })

    if (!folders.ok) {
      errors.push(`${target.courseName}：${folders.message}`)
      continue
    }

    // ---------- 3) 拼路径：落在不可见文件夹里的文件不索引 ----------
    const pathById = folderPathById(folders.items)
    const rows: FileRow[] = []
    let hiddenSkipped = 0

    for (const file of files.items) {
      const folderPath = file.folderId === null ? undefined : pathById.get(file.folderId)
      // 文件夹不可见（教师区 / 未发布）→ 学生在 Canvas 上看不见这个文件 → 不索引。
      // 实测 Chem 1AL：55 个文件夹里 24 个 hidden。
      if (folderPath === undefined) {
        hiddenSkipped += 1
        continue
      }
      rows.push({
        canvas_file_id: file.externalId,
        display_name: file.displayName,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
        folder_path: folderPath,
        file_url: filePreviewUrl(domain, target.canvasCourseId, file.externalId),
        modified_at: file.modifiedAt,
      })
    }

    summary.hiddenSkipped += hiddenSkipped

    // ---------- 4) 落库 ----------
    const applied = await applyCourseFiles({
      supabase,
      courseId: target.id,
      files: rows,
      // 两段拉取**都**完整才允许做删除判定（纪律 3）。
      complete: files.complete && folders.complete,
    })

    if (!applied.ok) {
      errors.push(`${target.courseName}：资料已拉取但写入失败（${applied.error}）`)
      continue
    }

    if (!files.complete || !folders.complete) {
      summary.incomplete = true
    }

    summary.created += applied.counts.created
    summary.updated += applied.counts.updated
    summary.deleted += applied.counts.deleted
    summary.coursesScanned += 1
    await markScanned(supabase, userId, target.id, now)
  }

  if (errors.length > 0) {
    summary.status = 'failed'
    summary.error = errors[0]
  }
  return summary
}

/**
 * 把一次拉取到的文件对齐到数据库。
 *
 * @param complete 本次拉取是否**完整**。为 false 时跳过删除步骤 ——
 *   不完整的拉取会把没拿到的行误判成"老师删掉了它们"（Sync-Strategy §7）。
 */
export async function applyCourseFiles({
  supabase,
  courseId,
  files,
  complete,
}: {
  supabase: SupabaseClient
  courseId: string
  files: FileRow[]
  complete: boolean
}): Promise<
  { ok: true; counts: { created: number; updated: number; deleted: number } } | { ok: false; error: string }
> {
  const { data, error } = await supabase
    .from('course_files')
    .select(EXISTING_COLUMNS)
    .eq('course_id', courseId)

  if (error) {
    return { ok: false, error: error.message }
  }

  type ExistingRow = {
    id: string
    canvas_file_id: string
    display_name: string
    content_type: string | null
    size_bytes: number | null
    folder_path: string
    file_url: string
    modified_at: string | null
    is_deleted: boolean
  }

  const existingRows = (data ?? []) as ExistingRow[]
  const byFileId = new Map<string, ExistingRow>()
  for (const row of existingRows) {
    byFileId.set(row.canvas_file_id, row)
  }

  const seenFileIds = new Set<string>()
  const inserts: Record<string, unknown>[] = []
  const updates: { id: string; patch: Record<string, unknown> }[] = []

  for (const file of files) {
    // 同一批里重复出现的以第一条为准（去重，避免插入撞唯一索引）。
    if (seenFileIds.has(file.canvas_file_id)) continue
    seenFileIds.add(file.canvas_file_id)

    const existing = byFileId.get(file.canvas_file_id)
    if (!existing) {
      inserts.push({ course_id: courseId, ...file, is_deleted: false })
      continue
    }

    if (hasChanged(existing, file)) {
      // ⚠️ 刻意不含任何"用户可改"的字段：`course_files` 没有用户主权字段，
      // 整行都是 Canvas 真相（Database.md §4.1 的写入封闭集在这里 = 全部业务列）。
      updates.push({ id: existing.id, patch: { ...file, is_deleted: false } })
    }
  }

  // ---------- 1) 新增 ----------
  let created = 0
  if (inserts.length > 0) {
    const result = await insertFiles(supabase, courseId, inserts as (FileRow & { course_id: string; is_deleted: boolean })[])
    if (!result.ok) return { ok: false, error: result.error }
    created = result.created
  }

  // ---------- 2) 更新（逐条：每行的值都不同，无法批量） ----------
  let updated = 0
  for (const { id, patch } of updates) {
    const { error: updateError } = await supabase
      .from('course_files')
      .update(patch)
      .eq('id', id)
      .eq('course_id', courseId)
    if (updateError) {
      return { ok: false, error: updateError.message }
    }
    updated += 1
  }

  // ---------- 3) 软删除缺席的行 ----------
  let deleted = 0
  if (complete) {
    const missingIds = existingRows
      .filter((row) => !seenFileIds.has(row.canvas_file_id) && !row.is_deleted)
      .map((row) => row.id)

    if (missingIds.length > 0) {
      const { error: deleteError } = await supabase
        .from('course_files')
        .update({ is_deleted: true })
        .in('id', missingIds)
        .eq('course_id', courseId)
      if (deleteError) {
        return { ok: false, error: deleteError.message }
      }
      deleted = missingIds.length
    }
  }

  return { ok: true, counts: { created, updated, deleted } }
}

// ---------- 内部 ----------

/** 判断一行已存在的文件是否需要写入。 */
function hasChanged(existing: {
  display_name: string
  content_type: string | null
  size_bytes: number | null
  folder_path: string
  file_url: string
  modified_at: string | null
  is_deleted: boolean
}, incoming: FileRow): boolean {
  return (
    // 之前被软删除的行这次又出现了（老师删错了又传回来）→ 必须写一次把它恢复，
    // 否则用户会看到"文件在 Canvas 上、但资料区里没有"。
    existing.is_deleted ||
    existing.display_name !== incoming.display_name ||
    existing.folder_path !== incoming.folder_path ||
    existing.file_url !== incoming.file_url ||
    existing.content_type !== incoming.content_type ||
    !sameNumber(existing.size_bytes, incoming.size_bytes) ||
    // 🔴 时间用 epoch 比（CodingRules §10.1 第 13 条）：PostgREST 与 Canvas 的
    // 时区写法不同，比字符串会永远判成"变了"→ 每轮同步全表重写一遍。
    !sameInstant(existing.modified_at, incoming.modified_at)
  )
}

/**
 * 批量插入；撞唯一索引时退化为逐条插入并跳过冲突行。
 *
 * 与 `lib/sync/canvas-tasks.ts` 的 `insertNewTasks` 同一条理由：
 * 理论上不该并发写同一门课（编排层有 5 分钟锁），但两个标签页或锁到期后重试都可能撞上，
 * 一行撞车不该让整门课的资料索引失败。
 */
async function insertFiles(
  supabase: SupabaseClient,
  courseId: string,
  inserts: (FileRow & { course_id: string; is_deleted: boolean })[],
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const { error } = await supabase.from('course_files').insert(inserts)
  if (!error) {
    return { ok: true, created: inserts.length }
  }
  if (error.code !== UNIQUE_VIOLATION) {
    return { ok: false, error: error.message }
  }

  let created = 0
  for (const row of inserts) {
    const { error: oneError } = await supabase.from('course_files').insert(row)
    if (!oneError) {
      created += 1
    }
  }
  return { ok: true, created }
}

/** PostgREST 唯一约束冲突码。 */
const UNIQUE_VIOLATION = '23505'

/** 24 小时内是否刚扫过（时间解析不出来时当作"没扫过"，宁可多扫一次）。 */
function scannedRecently(filesScannedAt: string | null, nowMs: number): boolean {
  if (filesScannedAt === null) return false
  const scannedMs = Date.parse(filesScannedAt)
  if (Number.isNaN(scannedMs)) return false
  return nowMs - scannedMs < FILES_SCAN_INTERVAL_MS
}

/**
 * 写回 `courses.files_scanned_at`。失败只记日志 —— 记账失败不该把已索引好的资料说成失败。
 *
 * @param at 传 `null` 表示**撤销**这次标记（端点真的出错时，下一轮应当重试）。
 */
async function markScanned(
  supabase: SupabaseClient,
  userId: string,
  courseId: string,
  at: string | null,
): Promise<void> {
  // 🔴 `.eq('user_id', userId)` 不是冗余：定时同步（T3）传进来的是 **service role** 客户端，
  // RLS 不生效。少了这一行，一个串了的 courseId 会去改别人的课程行。
  // 与 `canvas-sync.ts` 查目标课程时那一条是同一个理由（P0-2-6 第二拍补的）。
  const { error } = await supabase
    .from('courses')
    .update({ files_scanned_at: at })
    .eq('id', courseId)
    .eq('user_id', userId)

  if (error) {
    console.error('[sync] 写回课程资料扫描时间失败:', courseId, error.message)
  }
}
