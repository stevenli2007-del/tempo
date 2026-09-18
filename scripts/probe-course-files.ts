/**
 * P0-3-19 **在线只读探针**：拿真实账号打一遍 Canvas `/files` + `/folders`。
 *
 * 运行：`npm run probe:course-files`
 *
 * ### 为什么必须有这个脚本
 * 本卡动的是「端点对不对」「字段叫什么」「学生看不见的东西长什么样」，
 * 而这三件事**错了都不报错**，且 `tsc` / `eslint` / `next build` 全绿：
 * - 端点拼错 → Canvas 回 404，看起来像"这门课没资料"；
 * - 字段名记错（如拿 `updated_at` 当内容变更时间）→ 数据照样落库，
 *   只是 3-20/3-23 会白跑一次解析（安静地烧钱）；
 * - 过滤条件写反 → 要么整门课的资料消失，要么把教师区的文件搬给用户。
 *
 * ### 它验证什么（全部复用线上同一份函数）
 * 1. **`/files` 的 403 有多常见** —— 这是本卡最关键的一条实测：
 *    14 门课里 8 门没开 Files 区。若把它当成凭证失效，全站同步会被连坐停掉；
 * 2. **学生看不见的文件 / 文件夹**有多少（locked / hidden / *_for_user）；
 * 3. **分组结构**：打印 `folder_path → 条数`，这就是课程页「资料」区会画出来的东西
 *    —— 验收标准①（Chem 1A 的 `Lecture Slides/Unit 1-4`、
 *    `Practice Exams/Unit 1 Exam/Answer Keys`）靠这一节对；
 * 4. **外链形态**：打印拼出来的 URL（必须是 `/courses/:cid/files/:fid`）；
 * 5. **请求预算**：每门课几个请求、全部课程加起来是否逼近 20 的上限。
 *
 * ### 副作用
 * **零**。只发 GET，不写库、不写 `sync_runs`。
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import {
  MAX_PAGES_PER_COURSE_FILES,
  countRestrictedFiles,
  filePreviewUrl,
  filesPath,
  folderPathById,
  foldersPath,
  toCanvasFiles,
  toCanvasFolders,
} from '@/lib/canvas/files'
import { canvasGet } from '@/lib/canvas/client'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { groupByFolder } from '@/lib/course-files/grouping'
import type { CourseFileView } from '@/lib/course-files/grouping'
import type { CanvasFile, CanvasFolder } from '@/types/canvas'

const here = path.dirname(fileURLToPath(import.meta.url))

/** PostgREST「列不存在」—— 迁移没跑时的降级判据。 */
const MISSING_COLUMN = '42703'

/** tsx 不自动加载 .env.local（那是 Next 的特权）。 */
function loadEnvLocal(): void {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(here, '..', name)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}

/** 沿 Link 头翻页（与线上同一套：最多 `MAX_PAGES_PER_COURSE_FILES` 页）。 */
async function fetchAll<T>(
  domain: string,
  token: string,
  firstPath: string,
  map: (raw: unknown) => T[],
): Promise<{ items: T[]; pages: number; status: number | null; rawRestricted: number }> {
  let next: string | null = firstPath
  let pages = 0
  let status: number | null = null
  let rawRestricted = 0
  const items: T[] = []

  while (next !== null && pages < MAX_PAGES_PER_COURSE_FILES) {
    const result = await canvasGet<unknown>(domain, token, next)
    pages += 1
    if (!result.ok) {
      // 只报分类，不打印 token / 完整 URL（Security-Privacy §8）。
      console.log(`    ↳ 请求失败：kind=${result.kind}`)
      return { items, pages, status, rawRestricted }
    }
    status = 200
    if (firstPath.includes('/files?')) {
      rawRestricted += countRestrictedFiles(result.data)
    }
    items.push(...map(result.data))
    next = result.nextPath
  }

  return { items, pages, status, rawRestricted }
}

async function main(): Promise<void> {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（.env.local）')
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: creds, error: credError } = await supabase
    .from('canvas_credentials')
    .select('user_id')
    .limit(5)
  if (credError) throw credError
  if (!creds || creds.length === 0) {
    console.log('没有 Canvas 凭据，跳过（先连接 Canvas 再跑本探针）。')
    return
  }

  const userId = (creds[0] as { user_id: string }).user_id
  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    console.log('凭据读取失败。')
    return
  }
  console.log(`凭据：status=${credential.status} domain=${credential.canvasDomain}`)
  if (credential.status !== 'active') {
    console.log('⚠️ 凭据不是 active，Canvas 会拒绝本探针。')
  }

  // `files_scanned_at` 由本卡的迁移新增。迁移没跑时（42703）**降级**为不带该列再查一次 ——
  // 探针的职责是先让人看到"资料长什么样"，它不该被"迁移还没跑"挡在门外
  // （那一列只影响刷新节奏，不影响本探针要验的分组结构与外链）。
  const withScanColumn = await supabase
    .from('courses')
    .select('id, course_name, canvas_course_id, files_scanned_at')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .not('canvas_course_id', 'is', null)

  let courses = withScanColumn.data
  let courseError = withScanColumn.error
  if (courseError?.code === MISSING_COLUMN) {
    console.log('⚠️ `courses.files_scanned_at` 不存在 —— 迁移 20260921000000 还没跑，本次不显示扫描时间。')
    const fallback = await supabase
      .from('courses')
      .select('id, course_name, canvas_course_id')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .not('canvas_course_id', 'is', null)
    courses = fallback.data
    courseError = fallback.error
  }
  if (courseError) throw courseError

  const targets = (courses ?? []) as {
    id: string
    course_name: string
    canvas_course_id: string | null
    files_scanned_at?: string | null
  }[]
  if (targets.length === 0) {
    console.log('没有已关联 Canvas 的课程，跳过。')
    return
  }

  console.log(`\n已关联课程 ${targets.length} 门\n`)

  let totalRequests = 0
  let totalIndexed = 0
  let noFilesArea = 0

  for (const course of targets) {
    const canvasCourseId = course.canvas_course_id
    if (!canvasCourseId) continue

    console.log(`── ${course.course_name}（Canvas ${canvasCourseId}）`)
    console.log(`   上次扫描：${course.files_scanned_at ?? '从未（或迁移未跑）'}`)

    // 🔴 顺序与线上一致：**先 /files**（403 就收工，省掉第二个请求）。
    const files = await fetchAll<CanvasFile>(
      credential.canvasDomain,
      credential.token,
      filesPath(canvasCourseId),
      toCanvasFiles,
    )
    totalRequests += files.pages

    if (files.status === null) {
      // 403 / 404 都会走到这里：这是本卡的**常态**，不是故障。
      noFilesArea += 1
      console.log('   ⏭ 跳过（这门课没有可访问的 Files 区 —— 实测 14 门里 8 门如此）')
      continue
    }

    const folders = await fetchAll<CanvasFolder>(
      credential.canvasDomain,
      credential.token,
      foldersPath(canvasCourseId),
      toCanvasFolders,
    )
    totalRequests += folders.pages

    const pathById = folderPathById(folders.items)
    const hiddenFolders = folders.items.filter((f) => !f.visible).length

    const views: CourseFileView[] = []
    let hiddenSkipped = 0
    for (const file of files.items) {
      const folderPath = file.folderId === null ? undefined : pathById.get(file.folderId)
      if (folderPath === undefined) {
        hiddenSkipped += 1
        continue
      }
      views.push({
        id: file.externalId,
        displayName: file.displayName,
        folderPath,
        fileUrl: filePreviewUrl(credential.canvasDomain, canvasCourseId, file.externalId),
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
      })
    }

    totalIndexed += views.length

    console.log(
      `   /files 200：${files.pages} 页 · 映射后 ${files.items.length} 条` +
        `（原始响应里 ${files.rawRestricted} 条是学生看不见的，已跳过）`,
    )
    console.log(
      `   /folders 200：${folders.pages} 页 · ${folders.items.length} 个` +
        `（其中 ${hiddenFolders} 个不可见）`,
    )
    console.log(
      `   → 会索引 ${views.length} 个文件（另有 ${hiddenSkipped} 个落在不可见文件夹里，跳过）`,
    )

    // 分组结构 = 课程页「资料」区会画出来的东西（验收标准①）。
    const groups = groupByFolder(views)
    for (const group of groups) {
      console.log(`     · ${group.label || '(根目录)'} — ${group.files.length} 个`)
      for (const file of group.files.slice(0, 3)) {
        console.log(`         ${file.displayName}`)
      }
      if (group.files.length > 3) {
        console.log(`         … 另 ${group.files.length - 3} 个`)
      }
    }

    if (views.length > 0) {
      console.log(`     外链样例：${views[0].fileUrl}`)
    }
    console.log('')
  }

  console.log('===== 汇总 =====')
  console.log(`扫了 ${targets.length} 门课，其中 ${noFilesArea} 门没有可访问的 Files 区`)
  console.log(`会索引 ${totalIndexed} 个文件`)
  console.log(
    `Canvas 请求数：${totalRequests}（单次同步上限 20 —— ` +
      `${totalRequests > 20 ? '⚠️ 已超，靠 24h 门槛与熔断分摊' : '✅ 在预算内'}）`,
  )
  console.log('\n提示：本探针只读，不写库。要真正落库请触发一次同步（手动刷新会无视 24h 门槛）。')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
