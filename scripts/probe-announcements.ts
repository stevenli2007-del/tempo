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
 * ### 它验证什么（都打印出来对照，**全部复用线上同一份函数**）
 * 1. **窗口推演**（2026-09-18 收窄）：锚点不同 → 窗口不同；常态必须落在"今天 + 昨天"，
 *    断更必须自动回补。这是"只抓当天"**不会漏数据**的唯一证据；
 * 2. **陷阱复现**：宽窗口下只传 `start_date` 拿到几条；
 * 3. **收窄效果**：14 天窗口拿到几条 vs 本轮动态窗口拿到几条（消息栏被灌满的来源）；
 * 4. **真映射器**：用线上同一份 `toCanvasAnnouncements()` 映射，看还剩几条、归属对不对；
 * 5. **C 口径的操作数**（2026-09-18 拍板）：用线上同一份 `partitionByLanding()` 分流，
 *    数出"消息栏会新增几条" —— 这是 C 路线**唯一的实测依据**，也是验收最该看的数字；
 * 6. **摘要长什么样**：用线上同一份 `buildAnnouncementDigestPayload()` 生成并打印，
 *    探针输出 = 消息栏里会画出来的东西（标题 / 预览行 / 可展开条数 / 按钮文案）。
 *
 * ### 副作用
 * **零**。只发 GET，不写库、不写 `llm_runs`。三次 Canvas 请求（相对 20/轮的预算是零头）。
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import {
  ANNOUNCEMENT_WINDOW_MAX_DAYS,
  announcementWindow,
  announcementsPath,
  pickWindowAnchor,
  toCanvasAnnouncements,
} from '@/lib/canvas/announcements'
import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { canvasGet } from '@/lib/canvas/client'
import { validateExamInput, validateGradeComponentInput } from '@/lib/course-update/normalize'
import { parseCourseUpdate } from '@/lib/course-update/parse'
import {
  MAX_DIGEST_ITEMS,
  buildAnnouncementDigestPayload,
  partitionByLanding,
  type FreshAnnouncement,
} from '@/lib/sync/announcements'

const here = path.dirname(fileURLToPath(import.meta.url))

/** N 天前（负数）/ 后（正数）此刻的 ISO 串 —— 只用来喂 `announcementWindow` 的锚点。 */
function addDaysIso(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString()
}

/**
 * 两个 `YYYY-MM-DD` 之间跨几天。
 *
 * **不加 1**：窗口语义是 `[start, end)` 半开区间，`09-16 ~ 09-18` 覆盖的是
 * 16 与 17 两天。加 1 会让"常态窗口"读成 3 天，与直觉不符。
 */
function daySpan(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

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

  // ---------- 2) 已关联的课程（顺带取 last_synced_at → 窗口锚点） ----------
  //
  // 锚点必须是 `last_synced_at`：窗口起点跟着"上次成功同步那天"走。
  // 见 `lib/canvas/announcements.ts` 的 `announcementWindow`。
  const { data: courses, error: courseError } = await supabase
    .from('courses')
    .select('id, course_name, canvas_course_id, last_synced_at')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .not('canvas_course_id', 'is', null)
  if (courseError) throw courseError

  const courseRows = (courses ?? []) as {
    id: string
    course_name: string
    canvas_course_id: string
    last_synced_at: string | null
  }[]

  const targets = courseRows.map((row) => ({
    id: row.id,
    courseName: row.course_name,
    canvasCourseId: row.canvas_course_id,
  }))
  if (targets.length === 0) {
    console.log('没有已关联 Canvas 的课程，跳过。')
    return
  }
  console.log(`已关联课程 ${targets.length} 门：${targets.map((t) => t.courseName).join(' / ')}`)

  const externalIds = targets.map((t) => t.canvasCourseId)

  // ---------- 3) 窗口：锚点推演 + 本轮真实窗口 ----------
  //
  // 🔴 这一段是 2026-09-18 收窄窗口（"只抓当天"）的**验收依据**。
  // 窗口不再写死 14 天，而是起点 = 上次成功同步那天；把推演表打出来，
  // 才能一眼看出"常态确实是当天"以及"断更会不会漏"。
  const anchor = pickWindowAnchor(courseRows.map((row) => row.last_synced_at))
  const now = new Date()
  const window = announcementWindow(now, anchor)

  console.log(`\n窗口锚点（各课 last_synced_at 取最早）：${anchor ?? '（无 —— 首次同步）'}`)
  console.log('  各课 last_synced_at：')
  for (const row of courseRows) {
    console.log(`    · ${row.course_name}: ${row.last_synced_at ?? '从未成功同步'}`)
  }

  console.log('\n窗口推演（同样一个"今天"，锚点不同会得到什么窗口）：')
  const probes: Array<[string, string | null]> = [
    ['锚点=今天（常态：今天已同步过）', addDaysIso(now, 0)],
    ['锚点=2 天前（整整一个日历日没同步）', addDaysIso(now, -2)],
    ['锚点=3 天前（断更）', addDaysIso(now, -3)],
    ['锚点=30 天前（夹到上限）', addDaysIso(now, -30)],
    ['无锚点（首次安装 → 也走常态，不灌历史）', null],
  ]
  for (const [label, iso] of probes) {
    const w = announcementWindow(now, iso)
    console.log(`  ${label} → ${w.startDate} ~ ${w.endDate}（跨 ${daySpan(w.startDate, w.endDate)} 天）`)
  }

  console.log(`\n⇒ 本轮真实窗口：${window.startDate} → ${window.endDate}`)
  const windowDays = daySpan(window.startDate, window.endDate)
  console.log(
    windowDays <= 3
      ? `   ✅ 常态窗口（${windowDays} 天）—— 只覆盖"今天 + 昨天"的冗余量，历史存量不再重灌消息栏。`
      : `   ⚠️ 窗口 ${windowDays} 天 —— 说明有课断更了（锚点被拉旧）。这是**刻意**的：宁可多扫几条，也不漏。`,
  )

  // ---------- 4) 对照实验：只传 start_date vs 两端都传 ----------
  //
  // A 组刻意**手拼**一个只带 start_date 的路径（不是调 announcementsPath ——
  // 那个函数根本不给"只传一个"的机会），这正是 §14 记录的那个坑。
  //
  // ⚠️ 这个复现必须用**宽窗口**才成立：陷阱的机理是 end_date 默认
  // `start_date + 28 天`，于是窗口被推到"起点之后 28 天"。如果起点就是昨天，
  // 那 [昨天, 昨天+28] 照样覆盖今天 —— **不再漏数据**（收窄窗口顺带免疫了这个陷阱）。
  // 所以这里显式用 14 天窗口复现历史证据，然后**另外**用动态窗口量本轮真实量。
  const trapWindow = announcementWindow(now, addDaysIso(now, -ANNOUNCEMENT_WINDOW_MAX_DAYS))
  const trapParams = new URLSearchParams()
  for (const id of externalIds) trapParams.append('context_codes[]', `course_${id}`)
  trapParams.set('start_date', trapWindow.startDate)
  trapParams.set('per_page', '50')
  const trapPath = `/api/v1/announcements?${trapParams.toString()}`

  const trap = await canvasGet<unknown>(credential.canvasDomain, credential.token, trapPath)
  if (!trap.ok) {
    console.log(`\n❌ A 组（只传 start_date）失败：${trap.kind} — ${trap.message}`)
  }
  const trapItems = trap.ok ? toCanvasAnnouncements(trap.data) : []

  const widePath = announcementsPath(externalIds, trapWindow)
  const wide = await canvasGet<unknown>(credential.canvasDomain, credential.token, widePath)
  const wideItems = wide.ok ? toCanvasAnnouncements(wide.data) : []

  const realPath = announcementsPath(externalIds, window)
  const real = await canvasGet<unknown>(credential.canvasDomain, credential.token, realPath)
  if (!real.ok) {
    console.log(`❌ 本轮真实窗口失败：${real.kind} — ${real.message}`)
    return
  }
  const realItems = toCanvasAnnouncements(real.data)

  console.log(`\nA 组 · ${ANNOUNCEMENT_WINDOW_MAX_DAYS} 天窗口 + 只传 start_date（§14 记录的陷阱）`)
  console.log(`  原始条数 ${Array.isArray(trap.data) ? trap.data.length : 0} / 映射后 ${trapItems.length}`)
  console.log(`B 组 · ${ANNOUNCEMENT_WINDOW_MAX_DAYS} 天窗口 + 两端都传（§14 时期的实现）`)
  console.log(`  原始条数 ${Array.isArray(wide.data) ? wide.data.length : 0} / 映射后 ${wideItems.length}`)
  console.log(`C 组 · **本轮真实窗口** ${window.startDate}~${window.endDate} + 两端都传（当前实现）`)
  console.log(`  原始条数 ${Array.isArray(real.data) ? real.data.length : 0} / 映射后 ${realItems.length}`)

  console.log('\n结论：')
  if (wideItems.length > trapItems.length) {
    console.log(`  ✅ 陷阱仍然存在：只传 start_date 时 ${trapItems.length} 条，两端都传 ${wideItems.length} 条。`)
    console.log('     （end_date 默认 = start_date + 28 天，所以"最近一段"会静默落空。）')
  } else if (wideItems.length > 0) {
    console.log(`  ✅ 宽窗口下 A/B 都是 ${wideItems.length} 条 —— 这两个月没有"更近的"公告，`)
    console.log('     所以这次没复现出差异（不代表陷阱不存在，§14 有 2 vs 71 的实测记录）。')
  }
  console.log(
    `  ⇒ **收窄效果**：${ANNOUNCEMENT_WINDOW_MAX_DAYS} 天窗口拿到 ${wideItems.length} 条，` +
      `本轮动态窗口只拿到 ${realItems.length} 条（少 ${wideItems.length - realItems.length} 条历史存量）。`,
  )
  console.log('     这正是"消息栏不再被历史公告灌满"的来源，且因为窗口跟着锚点走，跨零点的公告不会漏。')

  // ---------- 4) 真映射器的产出（用户核对用） ----------
  if (realItems.length > 0) {
    const byCourse = new Map(targets.map((t) => [t.canvasCourseId, t.courseName]))
    console.log('\n本轮窗口内拿到的公告（真映射器输出，**含已在账上的**）：')
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

  // ---------- 5) 去重账：这一轮**真的**会新增几条 ----------
  //
  // 🔴 上半段量的是"窗口里有多少条公告"，而用户真正关心的是
  // "我下次打开消息栏会不会又冒出一堆"。这两件事差一个**去重账**：
  // 窗口内的公告绝大多数早在之前的轮次里落过账（`course_announcements` 唯一键），
  // 同步时会被 `seen` 挡掉、不产生消息。
  //
  // 不数这一步，就会把"窗口里 5 条"误读成"消息栏要新增 1 条摘要"。
  const { data: existingRows, error: existingError } = await supabase
    .from('course_announcements')
    .select('course_id, canvas_announcement_id')
    .in(
      'course_id',
      targets.map((t) => t.id),
    )
  if (existingError) throw existingError

  const existingKeys = new Set(
    ((existingRows ?? []) as { course_id: string; canvas_announcement_id: string }[]).map(
      (row) => `${row.course_id}|${row.canvas_announcement_id}`,
    ),
  )

  const targetByExternalId = new Map(targets.map((t) => [t.canvasCourseId, t]))
  const allFresh: FreshAnnouncement[] = []
  const newFresh: FreshAnnouncement[] = []
  for (const item of realItems) {
    const target = targetByExternalId.get(item.courseExternalId)
    if (!target) continue
    const entry: FreshAnnouncement = {
      announcement: item,
      courseId: target.id,
      courseName: target.courseName,
    }
    allFresh.push(entry)
    if (!existingKeys.has(`${target.id}|${item.externalId}`)) newFresh.push(entry)
  }

  console.log(`\n去重账（决定"下次打开会不会又冒出来"）：`)
  console.log(`  公告账 course_announcements 现有：${existingKeys.size} 行`)
  console.log(`  本轮窗口内：${allFresh.length} 条`)
  console.log(`  其中已在账上（会被唯一键挡掉）：${allFresh.length - newFresh.length} 条`)
  console.log(
    `  ⇒ **本轮真正会新增：${newFresh.length} 条**` +
      (newFresh.length === 0
        ? '  ✅ 消息栏不会新增任何东西 —— 收窄窗口后这就是常态。'
        : '  下面是这些新公告会怎么进站。'),
  )

  // ---------- 6) 落点分布 ----------
  //
  // 🔴 这里**必须**用线上同一份 `partitionByLanding()`，不能在探针里自己重写一遍
  // `hasStructuredLanding(...) ? a : b`：那样数出来的就不是"同步真实会做的事"，
  // 而是"我以为同步会做的事"（P0-3-15 的教训：两处各写一遍、都绿、肉眼才看得出分叉）。
  const { withLanding: landing, plain: noise } = partitionByLanding(newFresh)

  console.log('\n落点分布 / 消息栏要新增几条（C 口径：有落点逐条 + 无落点合并一条）：')
  if (newFresh.length === 0) {
    // 常态。三行都一样的话（"0 条 / 合并成 1 条摘要：0 条"）读起来自相矛盾，
    // 所以这里直接给结论。
    console.log('  本轮没有新公告 → **一条消息都不产生**（不新增、也不打扰）✅')
  } else {
    console.log(`  公告总数：${newFresh.length} 条`)
    console.log(`  ① 有落点 → 逐条进消息栏（按钮「确认」）：${landing.length} 条`)
    console.log(
      noise.length > 0
        ? `  ② 无落点 → 合并成 1 条摘要（按钮「知道了」）：${noise.length} 条`
        : '  ② 无落点：0 条（没有要合并的）',
    )
    const inboxCount = landing.length + (noise.length > 0 ? 1 : 0)
    console.log(`  ⇒ 消息栏实际新增 **${inboxCount} 条**，用户最少点 ${inboxCount} 次`)
    console.log(
      `     （对比：每条各进一次的旧口径是 ${newFresh.length} 次 —— ADR-016「操作量趋零」的差距就在这）`,
    )
    if (newFresh.length !== allFresh.length) {
      console.log(
        `     ⚠️ 上面用的是**去重后**的 ${newFresh.length} 条。若把窗口内全部 ${allFresh.length} 条都当新的，`,
      )
      console.log('        那只是个假想数字 —— 实际同步时它们全被唯一键挡掉了。')
    }
  }

  if (landing.length > 0) {
    console.log('\n  ① 有落点的这些（各自一条消息）：')
    for (const item of landing) {
      console.log(
        `    · [${item.courseName}] ${item.announcement.title} — ${item.announcement.bodyText
          .slice(0, 50)
          .replace(/\n/g, ' ')}…`,
      )
    }
  }

  if (noise.length > 0) {
    // 用**真实构造器**生成摘要载荷 —— 打印出来的就是消息栏里会画出来的东西。
    const digest = buildAnnouncementDigestPayload(noise)
    const items = digest.digest ?? []
    console.log('\n  ② 那条摘要消息会长这样（真构造器输出）：')
    console.log(`     标题：${String(digest.title)}`)
    for (const line of digest.details ?? []) console.log(`     · ${line}`)
    console.log(
      `     可展开列表：${items.length} 条` +
        (digest.digestOverflow ? `（另有 ${digest.digestOverflow} 条超出上限 ${MAX_DIGEST_ITEMS}）` : ''),
    )
    console.log(`     landing=${String(digest.landing)}（false → 按钮是「知道了」，不写任何字段）`)
    for (const item of items.slice(0, 5)) {
      console.log(
        `       - [${item.courseName}] ${item.title} · ${item.postedAtLabel}` +
          (item.sourceUrl ? ' · 有原文链接' : ' · ⚠️ 无原文链接'),
      )
    }
    if (items.length > 5) console.log(`       … 其余 ${items.length - 5} 条略`)
  }

  // ---------- 7) 有落点的公告**真的能写出东西吗**（验收 ② 的真检验） ----------
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
      text: item.announcement.bodyText,
      purpose: 'announcement_probe',
      // 探针不写 llm_runs（脚本没有请求上下文，也不该插审计噪音）。
      record: false,
    })
    if (!parsed.ok) {
      console.log(`  ⚠️ [${item.announcement.title}] 解析失败：${parsed.message}`)
      continue
    }

    const exams = (parsed.data.exams ?? []).map(validateExamInput).filter((r) => r.ok)
    const components = (parsed.data.gradeComponents ?? [])
      .map(validateGradeComponentInput)
      .filter((r) => r.ok)
    const total = exams.length + components.length
    if (total > 0) writable += 1
    console.log(
      `  ${total > 0 ? '✅' : '⚪'} [${item.announcement.title}] 考试 ${exams.length} / 成绩构成 ${components.length}` +
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
