/**
 * P0-3-19b **在线探针**：拿真实账号把「一键总结」那条链跑一遍（只读，不写库）。
 *
 * 运行：`npm run probe:file-summary`
 *
 * ### 它验证什么（全部复用线上同一份函数，不另写一遍逻辑）
 * 1. **能取到新鲜下载链** —— 库里存的 `file_url` 是给人点的预览页，
 *    真正要的是单文件端点返的、带短时 verifier 的那条 `url`；
 * 2. **下载 + 抽文本** —— 三个真实 PDF（syllabus / 讲义 / 答案 key）各自抽出多少字、多少页；
 * 3. **模型能不能只依据材料给出结构化结果** —— 打印概述 + 要点条数 + 公式条数，
 *    并跑 `validateSummaryOutput()`（与线上同一份校验）；
 * 4. **能力边界**：图片类必须在**发任何请求之前**被判掉（`unsupportedReason`），
 *    不许下载完再说"读不了"。
 *
 * ### 副作用
 * **零写入**：不写 `file_summaries`、不写 `llm_runs`（`record: false`）。
 * 会花掉几次模型调用 —— 这是本探针唯一"有成本"的地方，故默认只跑 3 个文件。
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import {
  MAX_DOWNLOAD_BYTES,
  downloadFile,
  loadSummaryTarget,
  resolveDownloadUrl,
} from '@/lib/course-files/summary/generate'
import {
  SUMMARY_PROMPT_VERSION,
  buildSummaryInput,
  buildSummaryMessages,
  summarySchema,
  validateSummaryOutput,
} from '@/lib/course-files/summary/prompt'
import { extractSyllabusText } from '@/lib/extract'
import { runStructured } from '@/lib/llm/run'

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

/** 想探的几类文件：验收标准里的 syllabus / 讲义 / 答案 key，外加一个"读不了"的对照。 */
const WANTED = ['Chem1A_Syllabus_Fall2026.pdf', 'L1 Slides.pdf', 'PracticeMidterm1KEY_F23.pdf']

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

  // 从库里找目标（`course_files` 已经被 3-19 索引过，这里只读）。
  const { data: rows, error: rowError } = await supabase
    .from('course_files')
    .select('id, display_name, folder_path, content_type, size_bytes')
    .eq('is_deleted', false)
  if (rowError) throw rowError

  const candidates = (rows ?? []) as {
    id: string
    display_name: string
    folder_path: string
    content_type: string | null
    size_bytes: number | null
  }[]

  // 认名字优先；库里没有（换了学期/换了课）就退到"随便三个能读的"。
  const named = WANTED.map((name) => candidates.find((r) => r.display_name === name)).filter(
    (r): r is (typeof candidates)[number] => r !== undefined,
  )
  const targets =
    named.length > 0
      ? named
      : candidates
          .filter((r) => detectExtractableExtension(r.display_name, r.content_type) !== null)
          .slice(0, 3)
  // 一个读不了的对照：图片类。
  const image = candidates.find((r) => (r.content_type ?? '').startsWith('image/'))

  console.log(`\n待测文件 ${targets.length} 个 + 对照（图片）\n`)

  for (const row of targets) {
    console.log(`── ${row.display_name}`)
    console.log(`   ${row.folder_path || '(根目录)'} · ${row.content_type} · ${row.size_bytes} 字节`)

    const ext = detectExtractableExtension(row.display_name, row.content_type)
    console.log(`   判定可读性：${ext ?? '❌ 不支持'}`)
    if (!ext) {
      console.log(`   理由：${unsupportedReason(row.display_name, row.content_type)}\n`)
      continue
    }

    const { target, error } = await loadSummaryTarget(supabase, row.id)
    if (error || !target) {
      console.log(`   ⏭ 读不到目标行：${error ?? '不存在'}\n`)
      continue
    }

    const resolved = await resolveDownloadUrl({
      domain: credential.canvasDomain,
      token: credential.token,
      canvasCourseId: target.canvasCourseId ?? '',
      canvasFileId: target.canvasFileId ?? '',
    })
    if (!resolved.url) {
      console.log(`   ⏭ 取下载链失败：${resolved.message}\n`)
      continue
    }
    console.log(`   下载链主机：${new URL(resolved.url).host}`)

    const download = await downloadFile(resolved.url, MAX_DOWNLOAD_BYTES)
    if (!download.ok) {
      console.log(`   ⏭ 下载失败：${download.message}（permanent=${download.permanent}）\n`)
      continue
    }
    console.log(`   下载 ${download.bytes.byteLength} 字节`)

    const extracted = await extractSyllabusText(ext, download.bytes)
    if (extracted.status !== 'extracted' || extracted.text === null) {
      console.log(`   ⏭ 抽文本失败：${extracted.error}\n`)
      continue
    }
    console.log(
      `   抽取：${extracted.method} · ${extracted.pageCount ?? '-'} 页 · ${extracted.text.length} 字`,
    )

    const input = buildSummaryInput({
      fileName: target.displayName,
      folderPath: target.folderPath,
      courseName: target.courseName,
      text: extracted.text,
    })

    const startedAt = Date.now()
    const result = await runStructured<unknown>({
      userId: 'probe-local',
      purpose: 'probe_file_summary',
      promptVersion: SUMMARY_PROMPT_VERSION,
      // 🔴 不写 llm_runs：脚本没有请求上下文，也不该往审计表里插噪音。
      record: false,
      capability: 'text',
      schema: summarySchema(),
      schemaName: 'CourseFileSummary',
      messages: buildSummaryMessages(input),
      temperature: 0,
      maxOutputTokens: 900,
    })
    const elapsed = Date.now() - startedAt

    if (!result.ok) {
      console.log(`   ❌ 模型失败：${result.error.code} ${result.error.message}\n`)
      continue
    }

    const validated = validateSummaryOutput(result.data)
    if (!validated.ok) {
      console.log(`   ❌ 校验不过：${validated.message}\n`)
      continue
    }

    const { overview, points, formulas } = validated.value
    console.log(
      `   模型：${result.usage.model} · ${elapsed}ms · ` +
        `in=${result.usage.inputTokens ?? '-'} out=${result.usage.outputTokens ?? '-'}`,
    )
    console.log(`   概述：${overview || '(空)'}`)
    console.log(`   要点 ${points.length} 条：`)
    for (const point of points) console.log(`     - ${point}`)
    if (formulas.length > 0) {
      console.log(`   公式/术语 ${formulas.length} 条：${formulas.join(' | ')}`)
    }
    if (validated.dropped > 0) console.log(`   ⚠️ 丢弃超量条目 ${validated.dropped} 条`)
    if (input.truncated) {
      console.log(`   ⚠️ 材料被截断：共 ${input.sourceChars} 字，只用了前 ${input.text.length} 字`)
    }
    console.log('')
  }

  if (image) {
    console.log('── 对照：图片类')
    console.log(`   ${image.display_name} · ${image.content_type}`)
    const ext = detectExtractableExtension(image.display_name, image.content_type)
    console.log(`   判定：${ext ?? '❌ 不支持（正确 —— 连下载都不该发生）'}`)
    console.log(`   理由：${unsupportedReason(image.display_name, image.content_type)}`)
    console.log(
      `   🔴 这一条必须在**发请求之前**就被拦掉：探针到此为止，没有下载、没有调模型。\n`,
    )
  }

  console.log('===== 汇总 =====')
  console.log('零写入：未写 file_summaries、未写 llm_runs（record: false）。')
  console.log('线上页面的路径：/courses/<课程 id>/files/<file_summaries 主键对应的 course_files id>')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
