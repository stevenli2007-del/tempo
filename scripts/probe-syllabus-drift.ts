/**
 * P0-3-20 **在线探针**：拿真实账号把「大纲漂移」那条链跑一遍（只读，不写库）。
 *
 * 运行：`npm run probe:syllabus-drift`
 *
 * ### 它验证什么（全部复用线上同一份函数，不另写一遍逻辑）
 * 1. **同步侧能定位到 syllabus** —— 对每门课跑 `pickSyllabusFile()`，
 *    打印它挑中的是哪个文件、有几个候选（这是"文件选错"这类错误的唯一暴露点）；
 * 2. **差量判定在真数据上给出什么结论** —— `decideDrift()`：首次 `baseline` /
 *    版本没变 `unchanged` / 变了 `propose`。这一步**不写锚点**；
 * 3. **按需链能真跑通** —— 对挑出来的那门课调 `computeDrift()`：
 *    取下载链 → 下载 → 抽文本 → 调模型 → `validateDriftOutput()`，
 *    打印 `driftStatus` / `confidence` / 差异行（**这就是验收里那句
 *    「列「新增 X / 变动 Y」」的真凭据**）；
 * 4. **迁移是否真的生效** —— 读 `courses.syllabus_file_id` /
 *    `syllabus_seen_modified_at`。缺列会返回 42703，这里**如实报出来**
 *    （Dashboard 的 `Success` 不是证据，见 `.workbuddy/memory/MEMORY.md`）。
 *
 * ### 副作用
 * **零写入**：不写 `courses` 锚点、不写 `messages`、不写 `llm_runs`（`record: false`）。
 * 会花掉**一次**模型调用（只对 1 门课跑完整链）—— 这是本探针唯一有成本的地方。
 *
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import {
  decideDrift,
  pickSyllabusFile,
  toSyllabusFileCandidate,
  type CourseFileDriftRow,
  type DriftAnchor,
} from '@/lib/syllabus-drift/files'
import { computeDrift } from '@/lib/syllabus-drift/generate'

const here = path.dirname(fileURLToPath(import.meta.url))

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}

const COURSE_FILE_COLUMNS =
  'id, course_id, canvas_file_id, display_name, folder_path, content_type, size_bytes, modified_at, file_url, is_deleted'

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
    .limit(1)
  if (credError) throw credError
  if (!creds || creds.length === 0) {
    console.log('没有 Canvas 凭据，跳过。')
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
    console.log('⚠️ 凭据不是 active —— 完整链那一步会跳过（按需路径会判 credential_inactive）。')
  }

  // ---------- 1) 迁移核验：两列真的在吗 ----------
  console.log('\n【迁移核验】courses 的差量锚点两列')
  const probe = await supabase
    .from('courses')
    .select('id, course_name, syllabus_file_id, syllabus_seen_modified_at')
    .order('course_name', { ascending: true })

  let anchorsAvailable = true
  if (probe.error) {
    anchorsAvailable = false
    console.log(`  ❌ 读不到锚点两列：${probe.error.code ?? '?'} ${probe.error.message}`)
    console.log('     → 迁移 `20260923000000_syllabus_drift.sql` 还没跑（或没跑完）。')
    console.log('     下面的判定一律按「从没核对过」算（anchor 全 null），只验选文件逻辑。')
  } else {
    const rows = (probe.data ?? []) as {
      id: string
      course_name: string
      syllabus_file_id: string | null
      syllabus_seen_modified_at: string | null
    }[]
    const baselined = rows.filter((row) => row.syllabus_file_id !== null).length
    console.log(`  ✓ 两列都在（共 ${rows.length} 门课，其中 ${baselined} 门已有锚点）`)
  }

  // 锚点在读不到时统一按 null（"从没核对过"），下面照样能跑完选文件那一段。
  const courseRows = anchorsAvailable
    ? ((probe.data ?? []) as {
        id: string
        course_name: string
        syllabus_file_id: string | null
        syllabus_seen_modified_at: string | null
      }[])
    : (
        (await supabase.from('courses').select('id, course_name').order('course_name', { ascending: true }))
          .data ?? []
      ).map((row) => ({
        ...(row as { id: string; course_name: string }),
        syllabus_file_id: null,
        syllabus_seen_modified_at: null,
      }))

  if (courseRows.length === 0) {
    console.log('没有课程，跳过。')
    return
  }

  // ---------- 2) 选文件 + 差量判定（零写入、零请求） ----------
  const { data: fileRows, error: fileError } = await supabase
    .from('course_files')
    .select(COURSE_FILE_COLUMNS)
    .eq('is_deleted', false)
  if (fileError) throw fileError

  const byCourse = new Map<string, ReturnType<typeof toSyllabusFileCandidate>[]>()
  for (const row of (fileRows ?? []) as CourseFileDriftRow[]) {
    const list = byCourse.get(row.course_id)
    const candidate = toSyllabusFileCandidate(row)
    if (list) list.push(candidate)
    else byCourse.set(row.course_id, [candidate])
  }

  console.log('\n【选文件 + 差量判定】（零下载、零模型调用）')
  const decisions: { courseId: string; courseName: string; kind: string; fileId: string | null }[] = []

  for (const course of courseRows) {
    const all = byCourse.get(course.id) ?? []
    const picked = pickSyllabusFile(all)
    const anchor: DriftAnchor = {
      syllabusFileId: course.syllabus_file_id,
      syllabusSeenModifiedAt: course.syllabus_seen_modified_at,
    }
    const decision = decideDrift({ anchor, candidate: picked })

    const kindLabel =
      decision.kind === 'skip'
        ? decision.reason === 'no_file'
          ? 'skip/no_file（没有合格的大纲文件 —— 常态）'
          : 'skip/unchanged（版本没变）'
        : decision.kind === 'baseline'
          ? 'baseline（首次 / 换文件 → 只记锚点，不提案）'
          : '✅ propose（版本变了 → 该建提案）'

    console.log(`─ ${course.course_name}`)
    console.log(`   候选 ${all.length} 个 → 挑中：${picked ? picked.displayName : '（无）'}`)
    if (picked) {
      console.log(
        `   ${picked.folderPath || '(根目录)'} · ${picked.contentType ?? '?'} · ${picked.sizeBytes} 字节 · modified ${picked.modifiedAt ?? '?'}`,
      )
      console.log(`   锚点：fileId=${anchor.syllabusFileId ?? 'null'} seen=${anchor.syllabusSeenModifiedAt ?? 'null'}`)
    }
    console.log(`   判定：${kindLabel}`)

    if (picked) {
      decisions.push({
        courseId: course.id,
        courseName: course.course_name,
        kind: decision.kind,
        fileId: picked.id,
      })
    }
  }

  const withFile = decisions.length
  const proposals = decisions.filter((item) => item.kind === 'propose').length
  console.log(`\n小结：${withFile}/${courseRows.length} 门课有合格大纲文件；本轮会提案 ${proposals} 条。`)

  // ---------- 2b) 诊断：没候选的课到底是"真没有"还是"名字不匹配" ----------
  //
  // 这一段是**刻意加的**：选文件靠名字里的 `syllabus` / `大纲`，而"6 门课里只有 1 门
  // 命中"这种结果有两种完全不同的解释 —— ① 那些课真没上传大纲（常态）；
  // ② 大纲在，但叫 `Course Info` / `Course Overview` 之类。
  // 不把可疑文件名打出来，就永远分不清是哪一种，而①和②要做的处置完全相反。
  //
  // ⚠️ 这只是把可疑的文件名**列给人看**，不参与任何判定 ——
  // 真正的判定仍然是 `pickSyllabusFile()` 那一个函数（唯一判定点）。
  // ⚠️ 词边界是必须的：`info` 不带 `\b` 会把 R4A 那门课的阅读材料
  // `…about Misinformation.pdf` 全捞出来（实测），把诊断本身变成噪音。
  const SUSPECT = /\b(info|information|overview|polic(y|ies)|course|handbook|packet|description)\b/i
  const noFileCourses = courseRows.filter((course) => !decisions.some((item) => item.courseId === course.id))
  if (noFileCourses.length > 0) {
    console.log('\n【诊断】没有合格大纲文件的课 —— 名字里像"课程信息"的文件（仅供人判断，不参与判定）')
    for (const course of noFileCourses) {
      const all = byCourse.get(course.id) ?? []
      const suspects = all.filter((item) => SUSPECT.test(item.displayName)).slice(0, 8)
      console.log(`─ ${course.course_name}（共索引 ${all.length} 个文件）`)
      if (all.length === 0) {
        console.log('   （这门课一个文件都没索引到 —— 多半没开 Files 区，见 3-19 的 `coursesSkipped`）')
      } else if (suspects.length === 0) {
        console.log('   可疑条目 0 个 → 看起来是真的没传大纲（不是名字不匹配）')
      } else {
        for (const item of suspects) {
          console.log(`   ? ${item.folderPath ? `${item.folderPath}/` : ''}${item.displayName}（${item.sizeBytes ?? '大小未知'} 字节）`)
        }
      }
    }
  }

  // ---------- 3) 按需链：真下载 + 真抽文本 + 真调模型（只对 1 门课） ----------
  const target = decisions[0]
  if (!target) {
    console.log('\n没有任何课有合格的大纲文件，跳过按需链。')
    return
  }

  console.log(`\n【按需链】对「${target.courseName}」跑一遍完整核对（1 次模型调用，零写入）`)
  if (credential.status !== 'active') {
    console.log('  ⏭ 凭据不是 active，按需链会判 credential_inactive（属预期，跳过）。')
    return
  }

  const startedAt = Date.now()
  const outcome = await computeDrift({
    // 服务端类型来自会话 client，但这里是脚本的 service-role client —— 结构一致，
    // 且本探针只读（`computeDrift` 自己不写库，`record: false` 也不写 llm_runs）。
    supabase: supabase as never,
    userId,
    courseId: target.courseId,
    courseName: target.courseName,
    syllabusFileId: target.fileId,
    record: false,
  })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

  if (outcome.status === 'skipped') {
    console.log(`  ⏭ 没算（${outcome.reason}）：${outcome.message}`)
    console.log(`     permanent=${outcome.permanent}（false = 下次打开消息栏会自然重试）`)
    return
  }

  console.log(`  driftStatus=${outcome.patch.driftStatus} · confidence=${outcome.patch.confidence} · 用时 ${elapsed}s`)
  console.log('  ── 差异行（界面上就是这几行）')
  for (const line of outcome.patch.details) console.log(`     · ${line}`)

  const drift = outcome.patch.drift
  if (drift) {
    console.log(
      `  ── 明细：新增考试 ${drift.addedExams.length} / 变动 ${drift.changedExams.length}（可自动更正 ${drift.changedExams.filter((c) => c.writable).length}）/ 新增构成 ${drift.addedComponents.length}`,
    )
    console.log(`     正文 ${drift.sourceChars} 字符 · 模型 ${drift.model ?? '?'}`)
    for (const change of drift.changedExams) {
      console.log(`     ${change.writable ? '✎' : '🚫'} ${change.before} → ${change.after}`)
      if (!change.writable) console.log(`        （${change.blockedReason}）`)
    }
  }
  if (outcome.patch.driftError) console.log(`  ── 失败原因：${outcome.patch.driftError}`)

  console.log('\n✅ 探针结束（本次零写入：没动 courses 锚点、没建 messages、没写 llm_runs）。')
}

void main()
