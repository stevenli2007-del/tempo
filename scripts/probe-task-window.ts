/**
 * P0-3-35 **在线探针**：证明「已完成的历史吃掉总览窗口」这个 bug 与它的修法（只读）。
 *
 * 运行：`npx -y tsx scripts/probe-task-window.ts`
 *
 * ### 它回答三个问题
 * ① 旧取数（只有时间上界）里，**多少条名额被"已完成的历史"占掉**？
 * ② 未来 7 天到期的任务，旧取数取回了几条、新取数取回几条？（这是 bug 的症状）
 * ③ 新加的两条 `or` filter **真的生效了吗**？
 *
 * ### ③ 为什么必须打真库
 * 修法依赖两个 PostgREST 行为，任何一个不成立，filter 会被**静默忽略**（不报错）：
 *   - 多次 `.or()` 调用之间是 **AND**（`doneHistoryFilters()` 返回两条，靠这个合成交集）；
 *   - `or()` 串里的 `column.neq.value` 被正确解析（不是被当成字面量吃掉）。
 * 这类"SQL 侧静默放宽"正是 `tsc` / `eslint` / `build` 全绿也抓不到的那一类
 * （回归脚本 `regress-task-window.ts` 只钉纯函数，钉不住服务端解析）。
 *
 * 判定方式：若 filter 被忽略，新查询的行集会与旧查询**完全一致**；
 * 所以断言"旧集合里的已完成历史 > 0 且新集合里的已完成历史 == 0"即为生效的硬证据。
 *
 * ### 副作用
 * **零写入**。只对 Supabase 发 SELECT（service role 只读），不碰 Canvas、不调 LLM。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { doneHistoryFilters } from '@/lib/tasks'
import { isEffectivelyDone } from '@/lib/tasks/progress'
import { addDays, dayKeyToUtcDate, schoolDayKey } from '@/lib/time'

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

type Row = {
  id: string
  title: string
  due_date: string | null
  status: string
  submission_state: string | null
  course_id: string
}

const RANGE_DAYS = 7
const HISTORY_DAYS = 7
const LIMIT = 50

function isDone(row: Row): boolean {
  return isEffectivelyDone({
    status: row.status === 'done' ? 'done' : 'pending',
    submissionState: row.submission_state as never,
  })
}

async function main(): Promise<void> {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（见 .env.local）')
    process.exit(1)
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const now = new Date()
  const until = new Date(now.getTime() + RANGE_DAYS * 86_400_000).toISOString()
  const since = dayKeyToUtcDate(addDays(schoolDayKey(now), -HISTORY_DAYS)).toISOString()
  const sinceMs = new Date(since).getTime()
  const nowMs = now.getTime()

  console.log(`now            = ${now.toISOString()}`)
  console.log(`until (+${RANGE_DAYS}d)  = ${until}`)
  console.log(`since (-${HISTORY_DAYS}d)  = ${since}`)

  // 只统计未归档课程（与总览页同一口径）。
  const { data: courseRows, error: courseError } = await supabase
    .from('courses')
    .select('id')
    .eq('is_archived', false)
  if (courseError) throw new Error(courseError.message)
  const courseIds = (courseRows ?? []).map((row) => row.id as string)
  if (courseIds.length === 0) {
    console.log('没有未归档课程，无法探测。')
    return
  }

  const COLS = 'id, title, due_date, status, submission_state, course_id'

  // ① 旧取数：只有时间上界。
  const before = await supabase
    .from('tasks')
    .select(COLS)
    .in('course_id', courseIds)
    .eq('is_deleted', false)
    .or(`due_date.lte."${until}",due_date.is.null`)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .range(0, LIMIT - 1)
  if (before.error) throw new Error(before.error.message)
  const beforeRows = (before.data ?? []) as Row[]

  const filters = doneHistoryFilters(since)
  for (const filter of filters) {
    console.log(`filter         = or=(${filter})`)
  }

  /** 按给定 filter 组合跑一次取数（其余条件与旧取数完全一致）。 */
  async function runWith(applied: string[]): Promise<Row[]> {
    let query = supabase
      .from('tasks')
      .select(COLS)
      .in('course_id', courseIds)
      .eq('is_deleted', false)
      .or(`due_date.lte."${until}",due_date.is.null`)
    for (const filter of applied) query = query.or(filter)
    const result = await query
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(0, LIMIT - 1)
    if (result.error) throw new Error(result.error.message)
    return (result.data ?? []) as Row[]
  }

  const [onlyStatus, onlySubmission] = await Promise.all([
    runWith([filters[0]!]),
    runWith([filters[1]!]),
  ])
  const afterRows = await runWith(filters)

  const staleDone = (rows: Row[]): Row[] =>
    rows.filter(
      (row) =>
        isDone(row) && row.due_date !== null && new Date(row.due_date).getTime() < sinceMs,
    )
  const future = (rows: Row[]): Row[] =>
    rows.filter((row) => row.due_date !== null && new Date(row.due_date).getTime() >= nowMs)
  const overdueUndone = (rows: Row[]): Row[] =>
    rows.filter(
      (row) => !isDone(row) && row.due_date !== null && new Date(row.due_date).getTime() < nowMs,
    )

  console.log('')
  console.log(`【旧取数】取回 ${beforeRows.length} 条（limit ${LIMIT}）`)
  console.log(`  已完成且早于下界（该让位的）: ${staleDone(beforeRows).length}`)
  console.log(`  未来到期（now 之后）        : ${future(beforeRows).length}`)
  console.log(`  逾期未完成                  : ${overdueUndone(beforeRows).length}`)
  console.log('')
  console.log(`【单条 ① status 轴】已完成历史还剩 ${staleDone(onlyStatus).length}`)
  console.log(`【单条 ② 提交态轴】已完成历史还剩 ${staleDone(onlySubmission).length}`)
  console.log('')
  console.log(`【新取数】取回 ${afterRows.length} 条（limit ${LIMIT}）`)
  console.log(`  已完成且早于下界（应为 0）  : ${staleDone(afterRows).length}`)
  console.log(`  未来到期（now 之后）        : ${future(afterRows).length}`)
  console.log(`  逾期未完成（不该变少）      : ${overdueUndone(afterRows).length}`)

  const failures: string[] = []
  if (staleDone(beforeRows).length === 0) {
    failures.push('旧取数里没有"已完成的历史"，本探针无法证明 filter 生效（数据不具备代表性）')
  }
  if (staleDone(afterRows).length !== 0) {
    failures.push(
      `新取数仍带回 ${staleDone(afterRows).length} 条已完成的历史 —— filter 未生效或被静默忽略`,
    )
  }
  // 🔴 多次 `.or()` 若是 OR 而不是 AND，两条各管一半、合起来反而更松 ——
  // 那样"已完成的历史"会漏网，而单跑任何一条时都不会暴露（正是要钉的组合行为）。
  if (staleDone(afterRows).length > Math.min(staleDone(onlyStatus).length, staleDone(onlySubmission).length)) {
    failures.push('两条 or filter 合起来比单条更松 —— 多次 or() 不是 AND，交集假设不成立')
  }
  if (future(afterRows).length < future(beforeRows).length) {
    failures.push('新取数的未来任务反而变少了 —— 修法有副作用')
  }
  if (overdueUndone(afterRows).length < overdueUndone(beforeRows).length) {
    failures.push('逾期未完成的任务变少了 —— 下界误伤了未完成的行（等于帮用户逃避）')
  }

  console.log('')
  if (failures.length > 0) {
    for (const failure of failures) console.error(`❌ ${failure}`)
    process.exit(1)
  }
  console.log('✅ filter 生效，且未误伤未完成的任务')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
