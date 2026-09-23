/**
 * P0-3-35 **在线探针**：找出同一门课里的**重复考试行**（只读，不删不改）。
 *
 * 运行：`npx -y tsx scripts/probe-exam-duplicates.ts`
 *
 * ### 它回答什么
 * 总览页「最近的考试」里出现过**两个 Midterm 1**（9/28 与 10/1）。`exam_dates` 是考试的
 * **权威源**，同一场考试出现两行意味着：派生出的 task 也是两条（各显示一次），
 * 而改期时 `resolveExamTargets()` 会判成"多命中" → **干脆不写**（P0-3-29 的纪律）。
 * 也就是说重复行不只是显示重复，它会让后续的改期**静默失效**。
 *
 * 本探针按**考试名归一**（`normalizeExamName`，与 `resolveExamTargets()` 同一份判据，
 * 不另写一套）分组，把每组的每行列出来：谁先谁后、来源是什么、日期/地点是否矛盾。
 * 人看了才知道该留哪条、该怎么防。
 *
 * ### 副作用
 * **零写入**。只 SELECT `exam_dates` 与 `courses`。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { normalizeExamName } from '@/lib/course-update/exam-match'

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

type ExamRow = {
  id: string
  course_id: string
  exam_name: string
  exam_date: string | null
  exam_time: string | null
  location: string | null
  source: string
  is_confirmed: boolean
  source_excerpt: string | null
  created_at: string
}

type CourseRow = { id: string; course_name: string }

async function main(): Promise<void> {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（见 .env.local）')
    process.exit(1)
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const [{ data: exams, error: examError }, { data: courses, error: courseError }] =
    await Promise.all([
      supabase
        .from('exam_dates')
        .select(
          'id, course_id, exam_name, exam_date, exam_time, location, source, is_confirmed, source_excerpt, created_at',
        )
        .order('created_at', { ascending: true }),
      supabase.from('courses').select('id, course_name'),
    ])
  if (examError) throw new Error(examError.message)
  if (courseError) throw new Error(courseError.message)

  const names = new Map<string, string>(
    ((courses ?? []) as CourseRow[]).map((row) => [row.id, row.course_name]),
  )
  const rows = (exams ?? []) as ExamRow[]

  const groups = new Map<string, ExamRow[]>()
  for (const row of rows) {
    const key = `${row.course_id}::${normalizeExamName(row.exam_name)}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const duplicates = [...groups.values()].filter((list) => list.length > 1)
  console.log(`exam_dates 共 ${rows.length} 行，按「课程 + 考试名归一」分成 ${groups.size} 组`)
  console.log(`重复组：${duplicates.length}`)

  // 全量清单一并打印：重复组只是"症状"，要看清一门课到底有哪些考试行，
  // 才知道「两个 Midterm 1」是同课重复还是不同课的同名考试（后者是合法的）。
  console.log('')
  console.log('── 全部考试行（按课程）')
  for (const [key, list] of groups) {
    const course = names.get(list[0]!.course_id) ?? list[0]!.course_id
    const dates = list.map((row) => row.exam_date ?? 'TBD').join(', ')
    console.log(`   ${course.padEnd(28)} ${list[0]!.exam_name.padEnd(20)} ${list.length} 行：${dates}`)
    void key
  }

  // ── 第二类：**同课 + 同日期 + 名字不同**（按名分组抓不到，却是真重复的主要形态）
  // 例：Chem 1A 的 `Unit 1 Exam`(9/22) 与 `Chem 1A exam`(9/22) —— 归一后是两个键，
  // 但同一门课同一天考两场不同名的考试几乎不可能，多半是对话框插入时没匹配上已有行。
  // 这类重复最危险：它让 `resolveExamTargets()` 判成"多命中" → **改期静默不写**。
  const byCourseDate = new Map<string, ExamRow[]>()
  for (const row of rows) {
    if (row.exam_date === null) continue // TBD 无法按日期比对
    const key = `${row.course_id}::${row.exam_date}`
    const list = byCourseDate.get(key)
    if (list) list.push(row)
    else byCourseDate.set(key, [row])
  }
  const sameDay = [...byCourseDate.values()].filter(
    (list) => list.length > 1 && new Set(list.map((row) => normalizeExamName(row.exam_name))).size > 1,
  )
  console.log('')
  console.log(`同课同日不同名：${sameDay.length}`)
  for (const list of sameDay) {
    const course = names.get(list[0]!.course_id) ?? list[0]!.course_id
    console.log(`── ${course} · ${list[0]!.exam_date}`)
    for (const row of list) {
      console.log(
        `   ${row.id}  ${row.exam_name.padEnd(20)} loc=${row.location ?? 'null'}  time=${row.exam_time ?? 'null'}  source=${row.source}  confirmed=${row.is_confirmed}  created=${row.created_at}`,
      )
      if (row.source_excerpt) console.log(`        excerpt: ${row.source_excerpt.slice(0, 120)}`)
    }
  }

  for (const list of duplicates) {
    const course = names.get(list[0]!.course_id) ?? list[0]!.course_id
    console.log('')
    console.log(`── ${course} · 「${list[0]!.exam_name}」（归一键 ${normalizeExamName(list[0]!.exam_name)}）`)
    for (const row of list) {
      console.log(
        `   ${row.id}  ${row.exam_name.padEnd(18)} date=${row.exam_date ?? 'null'}  time=${row.exam_time ?? 'null'}  loc=${row.location ?? 'null'}  source=${row.source}  confirmed=${row.is_confirmed}  created=${row.created_at}`,
      )
      if (row.source_excerpt) {
        console.log(`        excerpt: ${row.source_excerpt.slice(0, 120)}`)
      }
    }
    const dates = new Set(list.map((row) => row.exam_date))
    if (dates.size > 1) {
      console.log(`   ⚠️ 组内日期不一致（${[...dates].join(' / ')}）—— 改期时会被判「多命中」而不写`)
    } else {
      console.log('   （组内日期一致：这是**完全同义的重复行**，不是两场考试）')
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
