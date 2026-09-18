/**
 * P0-3-25b **在线探针**：把真账号的公告原文喂给**线上同款** prompt + schema，
 * 再用**真校验器**验收输出。**零写入。**
 *
 * 运行：`npm run probe:message-summaries`
 *
 * ### 为什么必须有这个脚本
 * 本卡改的是「降英文公告成中文要点」这件事，而它**错得再离谱也不会报错**：
 * - 模型把 `HW7 due 9/20` 说成「作业 9/22 截止」→ 类型、schema、校验器全绿；
 * - prompt 里"术语保留英文"那一句被谁删掉 → 输出变成「化学一A」，`build` 照样通过；
 * - 输出整份跑偏成英文、或写出一条 300 字的作文 → 只有真跑一次才看得见。
 *
 * ### 它验证什么（全部复用线上同一份函数，一行判定都不重写）
 * 1. **输入组装**：真消息 → `buildSummaryInput()` → 打印喂进去几条、覆盖率怎么算
 *    （和界面会给用户看的覆盖率文案对照）；
 * 2. **模型输出过真校验器**（`validateSummaryOutput`）—— 这是"能不能落库展示"的判据；
 * 3. **中文要点真的生效**：至少一条要点含中文字符（否则 prompt 改废了）；
 * 4. **长度与条数**：≤ 4 条、每条 ≤ 80 字符；
 * 5. **🔴 日期不凭空出现**：要点里出现的每个日期（`M/D`、`Sep 4`、`9 月 4 日` 都归一化后）
 *    必须能在**喂进去的原文**里找到对应 —— 这是本功能最不可原谅的失败，
 *    也是唯一能自动化的幻觉检测（用同一套提取规则比，避免格式差异造成误报）。
 *
 * ### 副作用
 * **零**：只读数据库（service role 只用来选几条真消息）、`record: false` 不写 `llm_runs`、
 * 不写 `message_summaries`。要点落库只在端点里发生（`POST /api/v1/messages/summaries`）。
 * 🔴 为了看清效果，本脚本**刻意不落库** —— 跑完不会让消息栏"提前"出现要点。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { runStructured } from '@/lib/llm/run'
import { coverageLabel } from '@/lib/messages/summary/locale'
import { validateSummaryOutput } from '@/lib/messages/summary/normalize'
import {
  MAX_POINTS,
  MAX_POINT_CHARS,
  SUMMARY_PROMPT_VERSION,
  buildSummaryInput,
  buildSummaryMessages,
  summarySchema,
} from '@/lib/messages/summary/prompt'
import { loadAnnouncementsForMessages } from '@/lib/messages/summary/store'

const here = path.dirname(fileURLToPath(import.meta.url))

/** tsx 不自动加载 .env.local（那是 Next 的特权），与其余探针同一手法。 */
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

/** 一次探几条消息（每条一次模型调用）。 */
const PROBE_MESSAGES = 4

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

/**
 * 把文本里的日期统一抽成 `M/D` 集合。
 *
 * 三种写法都要认（公告里混着用）：`9/4`、`Sep 4` / `September 4th`、`9 月 4 日`。
 * **两侧用同一个函数**，所以"模型换了一种写法"不会误判成幻觉 ——
 * 只有"原文里根本没有这个月日"才会被标出来。
 */
function dateTokens(text: string): Set<string> {
  const found = new Set<string>()
  const push = (month: string, day: string) => {
    const m = Number(month)
    const d = Number(day)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) found.add(`${m}/${d}`)
  }

  for (const match of text.matchAll(/(\d{1,2})[/\-.](\d{1,2})/g)) push(match[1], match[2])
  for (const match of text.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})/gi)) {
    push(String(MONTHS[match[1].slice(0, 3).toLowerCase()]), match[2])
  }
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) push(match[1], match[2])
  return found
}

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function main(): Promise<void> {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（.env.local）')
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

  console.log(`prompt 版本：${SUMMARY_PROMPT_VERSION}`)
  console.log(`上限：每条消息最多喂 ${MAX_POINTS} 条要点以内 / 单条要点 ≤ ${MAX_POINT_CHARS} 字符\n`)

  // ---------- 1) 挑少量真消息做样本 ----------
  //
  // ⚠️ 这里用 service role 只是为了"不依赖某个用户的登录态"（Phase 0 单用户）。
  //    线上生成走的是**会话 client + RLS**（见 `generate.ts` 文件头），
  //    脚本读得比线上宽，所以脚本绿不等于越权问题不存在 —— 那是端点的事，不是这里的。
  //
  // ### 为什么**不**只挑 pending（尽管线上只对 pending 生成）
  // 线上只对"仍待处理"的消息花模型钱是对的（已处理的只剩一行回执，要点没位置）。
  // 但探针的目的是**验证 prompt**，而用户在验收期间往往已经把消息处理掉了 ——
  // 那时探针挑不到任何样本，"验证不了"会被误读成"功能没问题"。
  // 所以这里刻意放宽到所有公告消息，并把两种形态都覆盖到：
  //   ① 池化（一条消息挂着几十条公告，摘要消息）—— 最容易被模型带偏的形态；
  //   ② 单条（有落点的公告，一条消息一条公告）—— 最常见、最该逐条准确的形态。
  const { data: messages, error: messageError } = await supabase
    .from('messages')
    .select('id, payload, created_at, status')
    .eq('type', 'announcement')
    .order('created_at', { ascending: false })
    .limit(12)

  if (messageError) throw messageError
  if (!messages || messages.length === 0) {
    console.log('库里一条公告消息都没有（先在 Tempo 里打开一次 dashboard 触发同步）。')
    return
  }

  const allIds = (messages as { id: string }[]).map((row) => row.id)
  const { byMessage, error: annError } = await loadAnnouncementsForMessages(supabase, allIds)
  if (annError) throw new Error(annError)

  const rows = (messages as { id: string; payload: unknown; created_at: string; status: string }[])
    .map((row) => ({ ...row, sources: byMessage.get(row.id) ?? [] }))
    .filter((row) => row.sources.length > 0)

  if (rows.length === 0) {
    console.log('公告消息都没有关联的公告正文（数据异常，线上会把它们落成 failed）。')
    return
  }

  const pooled = [...rows].sort((a, b) => b.sources.length - a.sources.length)[0]
  const singles = rows.filter((row) => row.sources.length === 1).slice(0, 3)
  const picked: typeof rows = []
  for (const row of [pooled, ...singles]) {
    if (!picked.some((item) => item.id === row.id)) picked.push(row)
    if (picked.length >= PROBE_MESSAGES) break
  }

  console.log(`公告消息 ${rows.length} 条（历史，含已处理），挑 ${picked.length} 条做样本：`)
  console.log(
    `  池化样本 ${pooled.sources.length} 条公告 / 单条样本 ${singles.length} 条` +
      `（线上只对 pending 生成，本脚本只看 prompt 效果）\n`,
  )

  for (const raw of picked) {
    const title =
      typeof (raw.payload as Record<string, unknown>)?.title === 'string'
        ? String((raw.payload as Record<string, unknown>).title)
        : '（无标题）'
    const sources = raw.sources

    console.log(`— 消息 ${raw.id.slice(0, 8)}（${raw.status}）：${title}`)
    console.log(`  关联公告 ${sources.length} 条`)

    const input = buildSummaryInput({
      messageTitle: title,
      announcements: sources.map((source) => ({
        title: source.title,
        courseName: source.courseName,
        postedAt: source.postedAt,
        bodyText: source.bodyText,
      })),
      locale: 'zh-CN',
    })
    console.log(
      `  喂给模型：${input.itemsUsed} / ${input.itemsTotal} 条（丢掉 ${input.omitted} 条）` +
        `，界面会标：「${coverageLabel(input.itemsUsed, input.itemsTotal) ?? '（不标覆盖率）'}」`,
    )
    console.log(`  模型看到的正文（前 2 块预览）：`)
    for (const block of input.blocks.slice(0, 2)) {
      console.log(`    ${block.split('\n')[0]}`)
      console.log(`    ${(block.split('\n')[1] ?? '').slice(0, 80)}…`)
    }

    if (input.itemsUsed === 0) {
      console.log('  ⚪ 没有正文可喂（线上会把这条落成 failed，不会调模型）\n')
      continue
    }

    const result = await runStructured<unknown>({
      userId: 'probe-local',
      purpose: 'probe_message_summaries',
      promptVersion: SUMMARY_PROMPT_VERSION,
      // 🔴 不写 llm_runs：脚本没有请求上下文，也不该往审计表里插噪音。
      record: false,
      capability: 'text',
      schema: summarySchema('zh-CN'),
      schemaName: 'AnnouncementSummary',
      messages: buildSummaryMessages(input, 'zh-CN'),
      temperature: 0,
      maxOutputTokens: 320,
    })

    if (!result.ok) {
      failed += 1
      console.error(`  ✗ 模型调用失败：${result.error.code} — ${result.error.message}\n`)
      continue
    }

    const validated = validateSummaryOutput(result.data)
    check('模型输出通过线上校验器', validated.ok, validated.ok ? undefined : validated.message)
    if (!validated.ok) {
      console.log('')
      continue
    }

    const { points } = validated.value
    for (const point of points) console.log(`    · ${point}`)
    if (points.length === 0) console.log('    （模型认为这条公告没有实质信息 → points 为空）')

    check(`条数 ≤ ${MAX_POINTS}`, points.length <= MAX_POINTS, String(points.length))
    check(
      `每条 ≤ ${MAX_POINT_CHARS} 字符`,
      points.every((point) => point.length <= MAX_POINT_CHARS),
      String(Math.max(0, ...points.map((p) => p.length))),
    )
    check(
      '有要点时是中文（course code 之外应有汉字）',
      points.length === 0 || points.some((point) => /[\u4e00-\u9fff]/.test(point)),
      points[0],
    )

    // ---- 幻觉检测：要点里的日期必须能在喂进去的原文里找到 ----
    const sourceDates = dateTokens(input.blocks.join('\n'))
    const pointDates = dateTokens(points.join('\n'))
    const invented = [...pointDates].filter((date) => !sourceDates.has(date))
    check(
      '要点里的日期都能在原文里找到（没有编日期）',
      invented.length === 0,
      invented.length > 0 ? `可疑：${invented.join(', ')}` : undefined,
    )

    console.log(
      `  （模型：${result.usage.model} / ${result.usage.latencyMs}ms / ` +
        `in ${result.usage.inputTokens ?? '?'} out ${result.usage.outputTokens ?? '?'} tokens）\n`,
    )
  }

  console.log(`结果：${passed} 通过 / ${failed} 失败`)
  console.log('本次运行**零写入**：要点没有落库，消息栏不会有任何变化。')
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
