/**
 * P0-3-25 **在线只读探针**：拿真实账号打一次 Canvas 公告批量端点。
 *
 * 运行：`npm run probe:announcements`
 *
 * ### 为什么必须有这个脚本
 * 本卡动的是「路径怎么拼」和「日期怎么传」，而这两件事**错了都不报错**：
 * - 参数名写错 → Canvas 忽略它，用默认值，返回 200 和一批少的可怜的数据；
 * - 日期只传一个 → 窗口变成 `[start, start+28天]`，**最近一个月全部落空**（§14 实测 2 条 vs 71 条）；
 * - `context_codes[]` 编码写错 → 一条都不返回，看起来像"这门课没公告"。
 *
 * `tsc` / `eslint` / `next build` 对以上三种**全绿**。只有真打一次才知道。
 *
 * ### 它验证什么（三个都打印出来对照）
 * 1. **陷阱复现**：只传 `start_date` 拿到几条；
 * 2. **本卡实现**：`announcementWindow()` + `announcementsPath()` 两端显式传，拿到几条；
 * 3. **真映射器**：用线上同一份 `toCanvasAnnouncements()` 映射，看还剩几条、归属对不对。
 *
 * ### 副作用
 * **零**。只发 GET，不写库、不写 `llm_runs`。两次 Canvas 请求（相对 20/轮的预算是零头）。
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import {
  announcementWindow,
  announcementsPath,
  toCanvasAnnouncements,
} from '@/lib/canvas/announcements'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { canvasGet } from '@/lib/canvas/client'
import { hasStructuredLanding } from '@/lib/course-update/landing'
import { validateExamInput, validateGradeComponentInput } from '@/lib/course-update/normalize'
import { parseCourseUpdate } from '@/lib/course-update/parse'

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

async function main(): Promise<void> {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（.env.local）')
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

  // ---------- 1) 找到唯一的 Canvas 凭据（Phase 0 只有一个用户） ----------
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
  if (creds.length > 1) {
    console.log(`⚠️ 库里有 ${creds.length} 份凭据，只探第一份（Phase 0 仍单用户）。`)
  }

  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    console.log('凭据读取失败。')
    return
  }
  console.log(`凭据：status=${credential.status} domain=${credential.canvasDomain}`)
  if (credential.status !== 'active') {
    console.log('⚠️ 凭据不是 active，Canvas 会拒绝本探针。')
  }

  // ---------- 2) 已关联的课程 ----------
  const { data: courses, error: courseError } = await supabase
    .from('courses')
    .select('id, course_name, canvas_course_id')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .not('canvas_course_id', 'is', null)
  if (courseError) throw courseError

  const targets = ((courses ?? []) as { id: string; course_name: string; canvas_course_id: string }[]).map(
    (row) => ({ id: row.id, courseName: row.course_name, canvasCourseId: row.canvas_course_id }),
  )
  if (targets.length === 0) {
    console.log('没有已关联 Canvas 的课程，跳过。')
    return
  }
  console.log(`已关联课程 ${targets.length} 门：${targets.map((t) => t.courseName).join(' / ')}\n`)

  const externalIds = targets.map((t) => t.canvasCourseId)
  const window = announcementWindow(new Date())
  console.log(`本卡窗口：${window.startDate} → ${window.endDate}（滚动，含边界余量）\n`)

  // ---------- 3) 对照实验：只传 start_date vs 两端都传 ----------
  //
  // A 组刻意**手拼**一个只带 start_date 的路径（不是调 announcementsPath ——
  // 那个函数根本不给"只传一个"的机会），这正是 §14 记录的那个坑。
  const trapParams = new URLSearchParams()
  for (const id of externalIds) trapParams.append('context_codes[]', `course_${id}`)
  trapParams.set('start_date', window.startDate)
  trapParams.set('per_page', '50')
  const trapPath = `/api/v1/announcements?${trapParams.toString()}`

  const realPath = announcementsPath(externalIds, window)

  const trap = await canvasGet<unknown>(credential.canvasDomain, credential.token, trapPath)
  if (!trap.ok) {
    console.log(`❌ A 组（只传 start_date）失败：${trap.kind} — ${trap.message}`)
  }
  const trapItems = trap.ok ? toCanvasAnnouncements(trap.data) : []

  const real = await canvasGet<unknown>(credential.canvasDomain, credential.token, realPath)
  if (!real.ok) {
    console.log(`❌ B 组（两端都传）失败：${real.kind} — ${real.message}`)
    return
  }
  const realItems = toCanvasAnnouncements(real.data)

  console.log('A 组 · 只传 start_date（§14 记录的陷阱）')
  console.log(`  原始条数 ${Array.isArray(trap.data) ? trap.data.length : 0} / 映射后 ${trapItems.length}`)
  console.log('B 组 · 两端都传（本卡实现）')
  console.log(`  原始条数 ${Array.isArray(real.data) ? real.data.length : 0} / 映射后 ${realItems.length}`)

  console.log('\n结论：')
  if (realItems.length === 0) {
    console.log('  ⚠️ B 组一条都没拿到 —— 要么这两周真的没有公告，要么参数仍然不对。')
    console.log('     可以手动把窗口放大（改 announcementWindow 的 days）再跑一次确认。')
  } else if (realItems.length > trapItems.length) {
    console.log(`  ✅ 陷阱复现 + 本卡实现有效：${trapItems.length} → ${realItems.length} 条。`)
    console.log('     只传 start_date 确实会漏掉最近一段（end_date 默认 = start_date + 28 天）。')
  } else {
    console.log(`  ✅ B 组拿到 ${realItems.length} 条，与 A 组一致 —— 这两周没有"更近的"公告，`)
    console.log('     所以这次没复现出差异（不代表陷阱不存在，§14 有 2 vs 71 的实测记录）。')
  }

  // ---------- 4) 真映射器的产出（用户核对用） ----------
  if (realItems.length > 0) {
    const byCourse = new Map(targets.map((t) => [t.canvasCourseId, t.courseName]))
    console.log('\n本卡实现拿到的公告（真映射器输出）：')
    for (const item of realItems.slice(0, 20)) {
      const courseName = byCourse.get(item.courseExternalId) ?? `未关联(${item.courseExternalId})`
      const posted = item.postedAt ? item.postedAt.slice(0, 10) : '时间未知'
      const link = item.htmlUrl ? '有链接' : '⚠️ 无链接'
      console.log(`  · [${courseName}] ${posted} ${item.title}（正文 ${item.bodyText.length} 字，${link}）`)
    }
    if (realItems.length > 20) console.log(`  … 其余 ${realItems.length - 20} 条略`)

    const missingLink = realItems.filter((item) => item.htmlUrl === null).length
    if (missingLink > 0) {
      console.log(`\n⚠️ ${missingLink} 条没有 html_url —— 消息栏上就没有「原文」入口（用户看不到原貌）。`)
    }
  }

  // ---------- 5) 落点分布（产品口径的诊断，不是功能验证） ----------
  //
  // 同步一轮会把**窗口内每一条**公告投进消息栏。这个数字直接决定用户要处理多少条 ——
  // 而 ADR-016 说"用户操作量趋零才是成功"。所以把分布量出来，别靠感觉。
  const landing = realItems.filter((item) => hasStructuredLanding(item.bodyText))
  const noise = realItems.filter((item) => !hasStructuredLanding(item.bodyText))

  console.log('\n落点分布（决定用户要点几次）：')
  console.log(`  有落点（按钮是「确认」）：${landing.length} 条`)
  console.log(`  无落点（按钮是「知道了」）：${noise.length} 条`)
  if (landing.length > 0) {
    console.log('  有落点的这些：')
    for (const item of landing) {
      console.log(`    · [${item.title}] ${item.bodyText.slice(0, 60).replace(/\n/g, ' ')}…`)
    }
  }
  if (noise.length > 0) {
    console.log('  无落点的样本（这些确认后什么都不写）：')
    for (const item of noise.slice(0, 5)) {
      console.log(`    · [${item.title}]`)
    }
  }
  console.log('\n⚠️ 这个数字如果很大，说明"每条公告都进消息栏"会让用户被淹没 ——')
  console.log('   那是产品口径的问题（要不要只在有落点时进站），不是本脚本能决定的。')

  // ---------- 6) 有落点的公告**真的能写出东西吗**（验收 ② 的真检验） ----------
  //
  // 粗筛只认关键词，判"有落点"不等于"能写出考试 / 成绩构成"。
  // 判定过宽的代价：用户点「确认」→ 得到「没有可写入的内容」→ 白点一次。
  // 这一步用**线上同一份 prompt + schema + 校验器**跑，数出真实转化率。
  if (landing.length === 0) return

  console.log(`\n对 ${landing.length} 条"有落点"的公告跑真解析（同一份 prompt / schema / 校验器）：`)
  let writable = 0
  for (const item of landing) {
    const parsed = await parseCourseUpdate({
      userId,
      text: item.bodyText,
      purpose: 'announcement_probe',
      // 探针不写 llm_runs（脚本没有请求上下文，也不该插审计噪音）。
      record: false,
    })
    if (!parsed.ok) {
      console.log(`  ⚠️ [${item.title}] 解析失败：${parsed.message}`)
      continue
    }

    const exams = (parsed.data.exams ?? []).map(validateExamInput).filter((r) => r.ok)
    const components = (parsed.data.gradeComponents ?? [])
      .map(validateGradeComponentInput)
      .filter((r) => r.ok)
    const total = exams.length + components.length
    if (total > 0) writable += 1
    console.log(
      `  ${total > 0 ? '✅' : '⚪'} [${item.title}] 考试 ${exams.length} / 成绩构成 ${components.length}` +
        (parsed.data.tasks?.length ? ` / 作业类 ${parsed.data.tasks.length}（不写）` : ''),
    )
  }
  console.log(
    `\n转化率：${writable} / ${landing.length} 条"有落点"的公告真的能写出字段。` +
      (writable < landing.length
        ? ' 差的那部分是粗筛判宽了 —— 用户会点一次「确认」然后被告知没东西可写。'
        : ''),
  )
}

main().catch((error) => {
  console.error('探针失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
