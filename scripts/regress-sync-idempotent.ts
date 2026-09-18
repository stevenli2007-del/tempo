/**
 * B1 **回归**：同步层「没有变化就不写库」这条铁律，必须**连跑两轮都为零**。
 *
 * 运行：
 * - `npx -y tsx scripts/regress-sync-idempotent.ts` —— 纯断言（不联网、不写库）
 * - `npx -y tsx scripts/regress-sync-idempotent.ts --live` —— 真账号连跑两轮（**会写库**）
 *
 * ### 它守住什么
 * 症状（2026-09-18 实测）：每轮同步都报 `updated 2`，而数据其实没变。
 * 根因是 `numeric(10,2)` 的列与 Canvas 未定标浮点（实测 `score = 9.923076923076923`）
 * 被直接比相等：库里读回 `9.92`、本次算出 `9.923076923076923` → 判定永远为"变了"。
 * 后果不只是多两次写：`updated_at` 被无意义刷新，失去"这条数据什么时候真变过"的意义。
 *
 * 修法：**写入与比较共用同一个按标度定标后的值**（`lib/numbers.ts` 的 `roundToScale`）。
 *
 * ### `--live` 的副作用与护栏
 * 会对每门已关联课程调 `applyCanvasTasks()` **两次**，第二次必须全零。
 * 护栏：**翻页不完整的课程一律跳过**（`nextPath` 非空 = 只拿到第一页），
 * 否则删除步骤会把"没拿到的行"误判成"外部已删除" —— 那是同步里最伤用户的一类事故。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { assignmentsPath, toCanvasAssignments } from '@/lib/canvas/assignments'
import { canvasGet } from '@/lib/canvas/client'
import { roundToScale } from '@/lib/numbers'
import {
  applyCanvasTasks,
  hasChanged,
  toCanvasTaskFields,
  type ExistingRow as TaskRow,
} from '@/lib/sync/canvas-tasks'
import type { CanvasAssignment } from '@/types/canvas'

const here = path.dirname(fileURLToPath(import.meta.url))

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

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

/** 真值（2026-09-18 在线探针实测）：库里存的值 / Canvas 给的未定标值。 */
const REAL_CASES: { stored: number; canvas: number }[] = [
  { stored: 9.92, canvas: 9.923076923076923 },
  { stored: 9.89, canvas: 9.892857142857142 },
]

function stubAssignment(score: number | null, points: number | null): CanvasAssignment {
  return {
    externalId: '1',
    title: 'T',
    htmlUrl: null,
    pointsPossible: points,
    dueAt: null,
    externalUpdatedAt: '2026-09-01T00:00:00Z',
    submissionTypes: ['online_quiz'],
    submission: score === null ? null : {
      workflowState: 'graded',
      submittedAt: '2026-09-01T00:00:00Z',
      score,
      late: false,
      missing: false,
    },
  }
}

function stubRow(score: number | string | null, points: number | string | null): TaskRow {
  return {
    id: 'row',
    source_id: '1',
    title: 'T',
    due_date: null,
    external_updated_at: '2026-09-01T00:00:00Z',
    is_deleted: false,
    submission_state: 'graded',
    submitted_at: '2026-09-01T00:00:00Z',
    canvas_url: null,
    points_possible: points,
    submission_score: score,
  }
}

// ---------- ① 定标：真值 + null/0 语义 + 幂等 ----------

function testRoundToScale(): void {
  console.log('\n① roundToScale：真值 / null 与 0 的语义 / 幂等性')
  for (const { stored, canvas } of REAL_CASES) {
    const got = roundToScale(canvas)
    check(
      `Canvas ${canvas} → ${stored}（= 库里读回的值）`,
      got === stored,
      `实得 ${got}`,
    )
  }
  check('null 原样是 null（不是 0）', roundToScale(null) === null)
  check('空串 → null', roundToScale('') === null)
  check('0 原样保留（考了 0 分 ≠ 没分）', roundToScale(0) === 0)
  // 半值远离零：与 Postgres numeric 一致（JS 的 Math.round 对 -2.5 给 -2）。
  check('负数半值远离零（-2.5 → -3）', roundToScale(-2.5, 0) === -3, `实得 ${roundToScale(-2.5, 0)}`)

  // 幂等（= 收敛的定义）：定标一次与定标两次必须完全相等，
  // 否则"库里读回的值 vs 本次算出的值"就还会判成变了。
  const samples = [9.923076923076923, 9.892857142857142, 12.345, -2.555, 0.005, 1e-7, 0]
  const notIdempotent = samples.filter((x) => roundToScale(roundToScale(x)) !== roundToScale(x))
  check('定标幂等（定一次 = 定两次）', notIdempotent.length === 0, `反例 ${notIdempotent}`)
}

// ---------- ② 差量判定：真值不再判"变了"，真变化仍然要判"变了" ----------

function testHasChanged(): void {
  console.log('\n② hasChanged：数值噪音不写库，真变化照写')
  const now = new Date('2026-09-18T00:00:00Z')
  for (const { stored, canvas } of REAL_CASES) {
    const row = stubRow(stored, 10)
    const assignment = stubAssignment(canvas, 10)
    check(
      `库 ${stored} vs Canvas ${canvas} → 判「未变化」`,
      hasChanged(row, assignment, toCanvasTaskFields(assignment, now)) === false,
    )
  }
  // 反向：分数真的改了必须写（不能因为做了定标就吞掉真变化）。
  const row = stubRow(9.92, 10)
  const changed = stubAssignment(8.5, 10)
  check(
    '库 9.92 vs Canvas 8.5 → 判「变了」',
    hasChanged(row, changed, toCanvasTaskFields(changed, now)) === true,
  )
  // 满分列同样处理（Canvas 也可能给未定标值）。
  // ⚠️ 这条作业没有内联提交 → 派生态是 null，行的 submission_state 必须也是 null，
  //    否则测的是"提交态变了"而不是"满分列的噪音"（fixture 自己先别骗人）。
  const row2 = { ...stubRow(null, 12.34), submission_state: null, submitted_at: null }
  const same = stubAssignment(null, 12.3449)
  check(
    '库 12.34 vs Canvas 12.3449 → 判「未变化」',
    hasChanged(row2, same, toCanvasTaskFields(same, now)) === false,
  )
}

// ---------- ③ --live：真账号连跑两轮 ----------

async function testLive(): Promise<void> {
  console.log('\n③ 真账号连跑两轮（--live，会写库）')
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
    check('环境变量齐备', false, '缺 ' + missing.join(' / '))
    return
  }

  const supabase = createClient(url!, serviceKey!, { auth: { persistSession: false } })
  const { data: courses, error } = await supabase
    .from('courses')
    .select('id, course_name, canvas_course_id')
    .not('canvas_course_id', 'is', null)
  if (error) {
    check('读 courses', false, error.message)
    return
  }
  type CourseRow = { id: string; course_name: string; canvas_course_id: string | null }
  const list = (courses ?? []) as CourseRow[]

  for (const course of list) {
    const result = await canvasGet<unknown>(domain!, token!, assignmentsPath(course.canvas_course_id!))
    if (!result.ok) {
      console.log(`  · ${course.course_name}：Canvas 拉取失败（${result.kind}），跳过`)
      continue
    }
    if (result.nextPath !== null) {
      // 只拿到第一页 → 删除步骤会误判，宁可不跑。
      console.log(`  · ${course.course_name}：翻页不完整（还有下一页），跳过（护栏）`)
      continue
    }
    const assignments = toCanvasAssignments(result.data)
    const now = new Date().toISOString()

    const first = await applyCanvasTasks({
      supabase,
      courseId: course.id,
      assignments,
      now,
      complete: true,
    })
    const second = await applyCanvasTasks({
      supabase,
      courseId: course.id,
      assignments,
      now: new Date().toISOString(),
      complete: true,
    })
    if (!first.ok || !second.ok) {
      check(`${course.course_name} 两轮都成功`, false, first.ok ? second.error : first.error)
      continue
    }
    const c1 = first.counts
    const c2 = second.counts
    const zero = c2.created === 0 && c2.updated === 0 && c2.deleted === 0
    check(
      `${course.course_name}（${assignments.length} 条）第二轮全零`,
      zero,
      `第一轮 ${c1.created}/${c1.updated}/${c1.deleted} → 第二轮 ${c2.created}/${c2.updated}/${c2.deleted}`,
    )
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live')
  testRoundToScale()
  testHasChanged()
  if (live) await testLive()

  console.log('\n======================================================================')
  if (failures === 0) {
    console.log('✅ 同步幂等回归全过' + (live ? '（含真账号连跑两轮）' : '（纯断言；加 --live 跑真账号）'))
  } else {
    console.log(`✗ ${failures} 项未通过`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('✗ 回归异常：', err)
  process.exit(1)
})
