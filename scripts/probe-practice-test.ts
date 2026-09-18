/**
 * P0-3-23 **在线探针**：拿真实账号把「自测卷」那条链跑一遍（只读，零写入）。
 *
 * 运行：`npx -y tsx scripts/probe-practice-test.ts`
 * （`probe:practice-test` 这条 npm script 由收尾 commit 补上 —— 本卡与 P0-3-20
 * 并行进行、共用 package.json，按窗口纪律先不改它。）
 *
 * ### 它验证什么（全部复用线上同一份函数，不另写一遍逻辑）
 * 1. **配对规则在真实数据上的命中率** —— 把 3-19 索引过的**全部** `course_files`
 *    按课程分组跑一遍 `isExamLike()` / `pairAnswerKey()`（纯函数、零成本），
 *    看有多少份文件像试卷、其中多少份真的配到了答案。这是"规则是不是为某一份文件写死的"
 *    唯一诚实的检验方式。
 * 2. **能取到新鲜下载链** —— 库里存的 `file_url` 是给人点的预览页，真正要的是单文件端点
 *    返的、带短时 verifier 的那条 `url`。
 * 3. **下载 + 抽文本** —— 试卷与答案各抽出多少字、多少页。
 * 4. **切题结果是否符合三条红线** —— 打印标题 / 题数 / 有几题没找到答案，
 *    并跑 `validatePracticeOutput()`（与线上同一份校验）；
 *    逐题打印**答案来源**，肉眼可核对"答案是不是从答案文件里来的"。
 * 5. **逐题讲解** —— 对第一题跑一次讲解链，打印步骤。
 * 6. **能力边界**：PPTX / 图片类必须在**发任何请求之前**被判掉。
 *
 * ### 副作用
 * **零写入**：不写 `practice_tests`、不写 `practice_test_explanations`、不写 `llm_runs`
 * （`record: false`）。因此**这个探针不需要先跑迁移** —— 它只读 3-19 已有的 `course_files`。
 * 会花掉 2 次模型调用（切题 1 次 + 讲解 1 次）。这是本探针唯一"有成本"的地方。
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { detectExtractableExtension } from '@/lib/course-files/extractable'
import { MAX_DOWNLOAD_BYTES, downloadFile, resolveDownloadUrl } from '@/lib/course-files/summary/generate'
import { extractSyllabusText } from '@/lib/extract'
import { runStructured } from '@/lib/llm/run'
import { loadPracticeExamContext, resolveKeyChoice } from '@/lib/practice-test/files'
import { PAIRING_RULE_LABELS, isExamLike, pairAnswerKey } from '@/lib/practice-test/pairing'
import type { PairingFile } from '@/lib/practice-test/pairing'
import {
  EXPLANATION_PROMPT_VERSION,
  PRACTICE_TEST_PROMPT_VERSION,
  buildExplanationInput,
  buildExplanationMessages,
  buildPracticeInput,
  buildPracticeMessages,
  explanationSchema,
  practiceSchema,
  validateExplanationOutput,
  validatePracticeOutput,
} from '@/lib/practice-test/prompt'

const here = path.dirname(fileURLToPath(import.meta.url))

/** tsx 不自动加载 .env.local（那是 Next 的特权），与其它探针同一手法。 */
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

/** 首选的验收基准：Chem 1A 那一对（走"子目录 Answer Keys"规则）。 */
const WANTED_EXAM = 'PracticeMidterm1_F23.pdf'

type FileRow = {
  id: string
  course_id: string
  canvas_file_id: string | null
  display_name: string
  content_type: string | null
  size_bytes: number | null
  folder_path: string
  file_url: string
  modified_at: string | null
}

function short(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
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

  // ---------- 1) 纯判定在**全部真实数据**上的表现 ----------
  const { data: allFiles, error: filesError } = await supabase
    .from('course_files')
    .select(
      'id, course_id, canvas_file_id, display_name, content_type, size_bytes, folder_path, file_url, modified_at',
    )
    .eq('is_deleted', false)
  if (filesError) throw filesError

  const rows = (allFiles ?? []) as FileRow[]
  const byCourse = new Map<string, FileRow[]>()
  for (const row of rows) {
    const list = byCourse.get(row.course_id) ?? []
    list.push(row)
    byCourse.set(row.course_id, list)
  }

  console.log(`\n===== 配对规则在真实数据上的表现 =====`)
  console.log(`索引里共 ${rows.length} 份文件，分属 ${byCourse.size} 门课。（零下载：这一段全是纯函数）\n`)

  let examLikeTotal = 0
  let pairedTotal = 0
  for (const [courseId, list] of byCourse) {
    const files: PairingFile[] = list.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      folderPath: row.folder_path,
    }))
    const examLike = files.filter((file) => isExamLike(file))
    if (examLike.length === 0) continue

    let paired = 0
    const rules = new Map<string, number>()
    for (const exam of examLike) {
      const pairing = pairAnswerKey(
        exam,
        files.filter((file) => file.id !== exam.id),
      )
      if (pairing.key && pairing.rule) {
        paired += 1
        rules.set(pairing.rule, (rules.get(pairing.rule) ?? 0) + 1)
      }
    }
    examLikeTotal += examLike.length
    pairedTotal += paired

    const sample = examLike
      .slice(0, 3)
      .map((file) => file.displayName)
      .join(' / ')
    console.log(
      `  课程 ${courseId.slice(0, 8)}…：像试卷 ${examLike.length} 份，配到答案 ${paired} 份` +
        (rules.size > 0
          ? `（${[...rules.entries()].map(([rule, n]) => `${rule}×${n}`).join('、')}）`
          : '') +
        `\n      例：${short(sample, 100)}`,
    )
  }
  console.log(
    `\n  合计：${examLikeTotal} 份像试卷，其中 ${pairedTotal} 份配到了答案` +
      `（配不到的会如实报「没找到答案文件」，**绝不硬塞**）`,
  )

  // ---------- 2) 选一份做深链路验证 ----------
  const wanted = rows.find((row) => row.display_name === WANTED_EXAM)
  const fallback = rows.find(
    (row) =>
      isExamLike({ id: row.id, displayName: row.display_name, folderPath: row.folder_path }) &&
      detectExtractableExtension(row.display_name, row.content_type) === 'pdf',
  )
  const target = wanted ?? fallback
  if (!target) {
    console.log('\n库里没有可用作基准的 PDF 试卷，跳过深链路验证。')
    return
  }

  console.log(`\n===== 深链路验证：${target.display_name} =====`)
  if (!wanted) console.log(`（没找到 ${WANTED_EXAM}，退到第一份 PDF 试卷）`)

  const { context, error } = await loadPracticeExamContext(supabase, target.id)
  if (error || !context) {
    console.log(`读取文件上下文失败：${error ?? '找不到这份文件'}`)
    return
  }
  console.log(`课程：${context.courseName} · 文件夹：${context.exam.folderPath || '(根目录)'}`)
  console.log(`同课程候选文件：${context.siblings.length} 份`)

  const choice = resolveKeyChoice({ exam: context.exam, siblings: context.siblings, explicitKeyFileId: null })
  if (choice.key === null) {
    console.log('没配到答案文件 —— 卷子会只有题目（这是如实结果，不是错误）。')
  } else {
    console.log(
      `配到的答案：${choice.key.displayName}` +
        `\n  目录：${choice.key.folderPath || '(根目录)'}` +
        `\n  依据：${choice.rule ? PAIRING_RULE_LABELS[choice.rule] : '(无)'}`,
    )
    const others = choice.ranked.filter((entry) => entry.file.id !== choice.key?.id)
    if (others.length > 0) {
      console.log(
        `  另有 ${others.length} 个候选（页面可换）：${others
          .slice(0, 3)
          .map((entry) => entry.file.displayName)
          .join(' / ')}`,
      )
    }
  }

  // ---------- 3) 能力边界必须在发请求之前 ----------
  const examExt = detectExtractableExtension(context.exam.displayName, context.exam.contentType)
  if (examExt !== 'pdf' && examExt !== 'docx') {
    console.log(`🔴 能力边界：这份试卷被判为 ${examExt ?? '不可抽'} —— 探针到此为止，不发请求、不调模型。`)
    return
  }
  if (choice.key) {
    const keyExt = detectExtractableExtension(choice.key.displayName, choice.key.contentType)
    if (keyExt === 'pptx') {
      console.log('🔴 能力边界：答案文件是 PPTX —— 本卡不解析幻灯片，线上会明确失败并让用户换一份。')
      return
    }
  }

  // ---------- 4) 取链 → 下载 → 抽文本 ----------
  async function fetchText(file: NonNullable<typeof choice.key> | typeof context.exam, roleLabel: string) {
    if (!file.canvasFileId) {
      console.log(`${roleLabel}：缺少 Canvas 文件标识`)
      return null
    }
    const resolved = await resolveDownloadUrl({
      domain: credential!.canvasDomain,
      token: credential!.token,
      canvasCourseId: context!.canvasCourseId ?? '',
      canvasFileId: file.canvasFileId,
    })
    if (!resolved.url) {
      console.log(`${roleLabel}：取下载链失败（${resolved.message}）`)
      return null
    }
    console.log(`${roleLabel}：下载链主机 ${new URL(resolved.url).host}`)

    const download = await downloadFile(resolved.url, MAX_DOWNLOAD_BYTES)
    if (!download.ok) {
      console.log(`${roleLabel}：下载失败（${download.message}，permanent=${download.permanent}）`)
      return null
    }
    const ext = detectExtractableExtension(file.displayName, file.contentType)
    if (!ext) {
      console.log(`${roleLabel}：类型不可抽`)
      return null
    }
    const extracted = await extractSyllabusText(ext, download.bytes)
    if (extracted.status !== 'extracted' || extracted.text === null) {
      console.log(`${roleLabel}：抽文本失败（${extracted.error}）`)
      return null
    }
    console.log(
      `${roleLabel}：${download.bytes.byteLength} 字节 → ${extracted.method}` +
        ` · ${extracted.pageCount ?? '-'} 页 · ${extracted.text.length} 字`,
    )
    return extracted.text
  }

  const examText = await fetchText(context.exam, '试卷')
  if (examText === null) return
  const keyText = choice.key ? await fetchText(choice.key, '答案文件') : null

  // ---------- 5) 切题 ----------
  const input = buildPracticeInput({
    courseName: context.courseName,
    examFileName: context.exam.displayName,
    keyFileName: choice.key?.displayName ?? null,
    examText,
    keyText,
  })

  const startedAt = Date.now()
  const result = await runStructured<unknown>({
    userId: 'probe-local',
    purpose: 'probe_practice_test',
    promptVersion: PRACTICE_TEST_PROMPT_VERSION,
    // 🔴 不写 llm_runs：脚本没有请求上下文，也不该往审计表里插噪音。
    record: false,
    capability: 'text',
    schema: practiceSchema(),
    schemaName: 'PracticePaper',
    messages: buildPracticeMessages(input),
    temperature: 0,
    maxOutputTokens: 4_000,
  })
  const elapsed = Date.now() - startedAt

  if (!result.ok) {
    console.log(`❌ 模型失败：${result.error.code} ${result.error.message}`)
    return
  }

  const validated = validatePracticeOutput(result.data, 'PracticeMidterm1_F23')
  if (!validated.ok) {
    console.log(`❌ 校验不过：${validated.message}`)
    return
  }

  const paper = validated.value
  console.log(
    `\n模型：${result.usage.model} · ${elapsed}ms · in=${result.usage.inputTokens ?? '-'} out=${result.usage.outputTokens ?? '-'}`,
  )
  console.log(`标题：${paper.title}`)
  console.log(`切出 ${paper.questions.length} 题；其中 ${validated.answerless} 题没找到答案`)
  if (validated.dropped > 0) console.log(`⚠️ 丢弃坏/超量条目 ${validated.dropped} 条`)
  if (input.truncated) {
    console.log(
      `⚠️ 材料被截断：试卷共 ${input.examSourceChars} 字、答案共 ${input.keySourceChars} 字，已截断后才喂模型`,
    )
  }

  console.log('\n前 5 题（题干截断显示；答案逐题标出来源）：')
  for (const question of paper.questions.slice(0, 5)) {
    console.log(`  ${question.number}. ${short(question.text, 110)}`)
    console.log(
      question.answer === null
        ? '     答案：⚠️ 没找到（如实标出，**不猜**）'
        : `     答案：${short(question.answer, 110)}`,
    )
  }
  if (paper.questions.length > 5) {
    console.log(`  …另有 ${paper.questions.length - 5} 题未打印`)
  }

  // ---------- 6) 逐题讲解（第一题） ----------
  const first = paper.questions[0]
  if (!first) return
  console.log(`\n===== 逐题讲解（${first.number}） =====`)
  const explanationInput = buildExplanationInput({
    courseName: context.courseName,
    paperTitle: paper.title,
    questionNumber: first.number,
    questionText: first.text,
    officialAnswer: first.answer,
  })
  const explanationStarted = Date.now()
  const explanationResult = await runStructured<unknown>({
    userId: 'probe-local',
    purpose: 'probe_practice_explanation',
    promptVersion: EXPLANATION_PROMPT_VERSION,
    record: false,
    capability: 'text',
    schema: explanationSchema(),
    schemaName: 'PracticeExplanation',
    messages: buildExplanationMessages(explanationInput),
    temperature: 0,
    maxOutputTokens: 900,
  })
  if (!explanationResult.ok) {
    console.log(`❌ 讲解模型失败：${explanationResult.error.code} ${explanationResult.error.message}`)
  } else {
    const explanation = validateExplanationOutput(explanationResult.data)
    if (!explanation.ok) {
      console.log(`❌ 讲解校验不过：${explanation.message}`)
    } else {
      console.log(
        `模型：${explanationResult.usage.model} · ${Date.now() - explanationStarted}ms`,
      )
      explanation.value.steps.forEach((step, index) => {
        console.log(`  ${index + 1}. ${step}`)
      })
      if (explanation.value.concepts.length > 0) {
        console.log(`  概念/公式：${explanation.value.concepts.join(' | ')}`)
      }
    }
  }

  console.log('\n===== 汇总 =====')
  console.log('零写入：未写 practice_tests、未写 practice_test_explanations、未写 llm_runs（record: false）。')
  console.log('本探针只读 3-19 已索引的 course_files —— **不需要先跑迁移**。')
  console.log('线上页面的路径：/courses/<课程 id>/practice-tests/new?exam=<course_files id>')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
