/**
 * B1 **在线探针**：把「同步不幂等」定位到**具体是哪一行、哪一列**（只读，不写库）。
 *
 * 运行：`npx -y tsx scripts/probe-sync-idempotent.ts`
 *
 * ### 它回答什么
 * 同步每轮报 `updated 2`，但 `updated` 只有一个数字，看不出是谁变了、因为什么变。
 * 本探针**复用线上同一份判定**（`lib/sync/canvas-tasks.ts` 的 `deriveSubmission()` +
 * `lib/numbers.ts` 的 `sameNumber()` / `lib/time.ts` 的 `sameInstant()`，不另写逻辑），
 * 逐条逐字段打印「库里的值 vs 本次拉到的值」，把「哪一列判成变了」摊到明面上。
 *
 * ### 副作用
 * **零写入**。只对 Canvas 发 GET（作业列表，含 `include[]=submission`）；
 * Supabase 侧只有 SELECT。
 *
 * 🔴 明文 token 只在内存里，不打印、不进日志（Security-Privacy §8）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { assignmentsPath, toCanvasAssignments } from '@/lib/canvas/assignments'
import { canvasGet } from '@/lib/canvas/client'
import {
  canvasTaskDiffs,
  toCanvasTaskFields,
  type CanvasTaskDiff,
} from '@/lib/sync/canvas-tasks'
import type { CanvasAssignment } from '@/types/canvas'

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

type ExistingRow = {
  id: string
  course_id: string
  source_id: string | null
  title: string
  due_date: string | null
  external_updated_at: string | null
  is_deleted: boolean
  submission_state: string | null
  submitted_at: string | null
  canvas_url: string | null
  points_possible: number | string | null
  submission_score: number | string | null
  /** P0-3-34：'manual' 的行同步不写也不比那两个分数列（`canvasTaskColumns` 里收口）。 */
  score_source: string | null
}

/**
 * 判定**直接复用生产函数**（`canvasTaskDiffs`），本文件不另写一份 ——
 * 探针里抄一遍判定，等于"用另一份代码验证这份代码"，验不出真东西。
 */
function diffRow(
  existing: ExistingRow,
  incoming: CanvasAssignment,
  now: Date,
): CanvasTaskDiff[] {
  return canvasTaskDiffs(existing, incoming, toCanvasTaskFields(incoming, now))
}

function show(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v)
}

async function main(): Promise<void> {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const domain = process.env.CANVAS_DOMAIN
  const token = process.env.CANVAS_PAT
  const missing = [
    ['NEXT_PUBLIC_SUPABASE_URL', url],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
    ['CANVAS_DOMAIN', domain],
    ['CANVAS_PAT', token],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length > 0) {
    console.error('✗ 缺少环境变量：' + missing.join(' / '))
    process.exit(1)
  }

  const supabase = createClient(url!, serviceKey!, { auth: { persistSession: false } })

  const { data: tasks, error: taskErr } = await supabase
    .from('tasks')
    .select(
      'id, course_id, source_id, title, due_date, external_updated_at, is_deleted, submission_state, submitted_at, canvas_url, points_possible, submission_score, score_source',
    )
    .eq('source', 'canvas')
    .not('source_id', 'is', null)

  if (taskErr) {
    console.error('✗ 读 tasks 失败：' + taskErr.message)
    process.exit(1)
  }
  const rows = (tasks ?? []) as ExistingRow[]

  const { data: courses, error: courseErr } = await supabase
    .from('courses')
    .select('id, course_name, canvas_course_id')
    .not('canvas_course_id', 'is', null)
  if (courseErr) {
    console.error('✗ 读 courses 失败：' + courseErr.message)
    process.exit(1)
  }
  type CourseRow = { id: string; course_name: string; canvas_course_id: string | null }
  const courseList = (courses ?? []) as CourseRow[]

  const byCourse = new Map<string, ExistingRow[]>()
  for (const r of rows) {
    const list = byCourse.get(r.course_id) ?? []
    list.push(r)
    byCourse.set(r.course_id, list)
  }

  console.log(`库内 canvas 任务 ${rows.length} 行，分布在 ${byCourse.size} 门课`)
  console.log('======================================================================')

  const now = new Date()
  let changedRows = 0
  const fieldHits = new Map<string, number>()

  for (const course of courseList) {
    const existing = byCourse.get(course.id)
    if (!existing || existing.length === 0) continue

    const result = await canvasGet<unknown>(
      domain!,
      token!,
      assignmentsPath(course.canvas_course_id!),
    )
    if (!result.ok) {
      console.log(`· ${course.course_name}：Canvas 拉取失败（${result.kind}），跳过`)
      continue
    }
    const assignments = toCanvasAssignments(result.data)
    const bySid = new Map(assignments.map((a) => [a.externalId, a]))

    let courseChanged = 0
    for (const row of existing) {
      const incoming = row.source_id ? bySid.get(row.source_id) : undefined
      if (!incoming) continue // 缺席 = 删除判定，不归本探针管
      const diffs = diffRow(row, incoming, now)
      if (diffs.length === 0) continue
      courseChanged += 1
      changedRows += 1
      for (const d of diffs) {
        fieldHits.set(d.field, (fieldHits.get(d.field) ?? 0) + 1)
      }
      console.log(`\n【${course.course_name}】${row.title.slice(0, 40)}  (source_id=${row.source_id})`)
      for (const d of diffs) {
        console.log(`    ${d.field}: 库=${show(d.stored)}  Canvas=${show(d.incoming)}`)
      }
    }
    if (courseChanged === 0) {
      console.log(`· ${course.course_name}：${existing.length} 行全部判定「未变化」`)
    }
  }

  console.log('\n======================================================================')
  if (changedRows === 0) {
    console.log('✅ 判定为「需要写入」的行：0 —— 幂等')
  } else {
    console.log(`⚠️ 判定为「需要写入」的行：${changedRows}`)
    console.log('   命中字段统计：')
    for (const [field, n] of [...fieldHits.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${field}: ${n} 行`)
    }
  }
}

main().catch((err) => {
  console.error('✗ 探针异常：', err)
  process.exit(1)
})
