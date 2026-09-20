/**
 * P0-3-34 回归：手记分数的**纯逻辑**两处。
 *
 * 运行：`npx -y tsx scripts/regress-task-scores.ts`（纯断言：不联网、不写库）
 *
 * ### 它守住什么
 * ① `normalizeScoreInput()` —— `PATCH /api/v1/tasks/:id` 的 `score` 字段组的**唯一**校验器，
 *    对话框（`use-course-update-flow.ts` 的 `acceptParseResult`）过滤时用的是同一份。
 *    重点在 **`null` ≠ `0`**：缺分子 / 缺满分必须**整条拒收**，绝不用 0 兜底 ——
 *    用 0 兜底会写进「0 / 100」这种我们编出来的结论（`lib/numbers.ts` 文件头那条铁律）。
 * ② `toTask()` 对 `score_source` 的收窄 —— 约束外的取值必须**抛错**而不是给个默认值：
 *    给默认值会让"这分数是谁的"静默变成 `'canvas'`，于是下一轮同步理直气壮地把它覆盖掉。
 *
 * 同步侧那条闸（手工分数不进差量、也不进写入 patch）在 `regress-sync-idempotent.ts` 里 ——
 * 那里已经有 `canvasTaskColumns` 的 fixture，本文件不重复。
 */

import { toTask, type TaskRow } from '@/lib/tasks'
import { normalizeScoreInput } from '@/lib/tasks/score'

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('normalizeScoreInput：真值 / null 与 0 / 边界')
{
  const ok = normalizeScoreInput({ score: 9.5, possible: 10 })
  check('9.5 / 10 通过', ok.ok && ok.value.score === 9.5 && ok.value.possible === 10, JSON.stringify(ok))

  // 0 分是**真实取值**（考了 0 分），不是"没有分数"。
  const zero = normalizeScoreInput({ score: 0, possible: 20 })
  check('0 / 20 通过（0 分 ≠ 没分）', zero.ok && zero.value.score === 0, JSON.stringify(zero))

  // 加分项：比例由 ScoreBar 夹在 [0,1]，满分档照样画得出来 —— 这里拒收等于替老师改规则。
  const extra = normalizeScoreInput({ score: 5, possible: 4 })
  check('5 / 4 通过（加分项）', extra.ok, JSON.stringify(extra))

  // 数字串：PostgREST / 表单都可能给字符串，收窄而不是靠 `Number(x) || 0`。
  const str = normalizeScoreInput({ score: '9.5', possible: '10' })
  check('数字串 9.5 / 10 通过', str.ok && str.value.score === 9.5, JSON.stringify(str))

  // 🔴 定标：写入与比较共用同一个已定标值（P0-3-28 的纪律），否则同步永不收敛。
  const scaled = normalizeScoreInput({ score: 9.923076923076923, possible: 10 })
  check('定标到列标度（9.923… → 9.92）', scaled.ok && scaled.value.score === 9.92, JSON.stringify(scaled))

  check('score 为 null → 拒（不是 0 分）', !normalizeScoreInput({ score: null, possible: 10 }).ok)
  check('possible 缺失 → 拒', !normalizeScoreInput({ score: 9.5 }).ok)
  check('possible = 0 → 拒（0 分制画不出比例）', !normalizeScoreInput({ score: 1, possible: 0 }).ok)
  check('possible 为负数 → 拒', !normalizeScoreInput({ score: 1, possible: -5 }).ok)
  check('score 为负数 → 拒', !normalizeScoreInput({ score: -1, possible: 10 }).ok)
  check('score 非数字 → 拒', !normalizeScoreInput({ score: 'abc', possible: 10 }).ok)
  check('整个 score 为 null → 拒（清除要走另一条分支）', !normalizeScoreInput(null).ok)
  check('数组 → 拒', !normalizeScoreInput([]).ok)
  check('字符串 → 拒', !normalizeScoreInput('9.5/10').ok)

  // 拒收时必须给人话（会被 PATCH 直接回给用户）。
  const bad = normalizeScoreInput({ score: null, possible: 10 })
  check('拒收带人话说明', !bad.ok && bad.message.length > 0, bad.ok ? '' : bad.message)
}

console.log('\ntoTask：score_source 三态与约束外取值')
{
  function row(scoreSource: string | null): TaskRow {
    return {
      id: 't1',
      course_id: 'c1',
      title: 'Discussion quiz',
      due_date: null,
      task_type: 'assignment',
      source: 'canvas',
      status: 'pending',
      is_derived: false,
      submission_state: null,
      submitted_at: null,
      canvas_url: null,
      points_possible: 10,
      submission_score: 9.5,
      score_source: scoreSource,
    }
  }

  check("null → scoreSource null（从未手工覆盖）", toTask(row(null), 'C').scoreSource === null)
  check("'manual' → 'manual'", toTask(row('manual'), 'C').scoreSource === 'manual')
  check("'canvas' → 'canvas'", toTask(row('canvas'), 'C').scoreSource === 'canvas')

  // 约束外取值：**抛错**，不给默认值。给了默认值就等于把"这分数是谁的"静默判成 Canvas 的。
  let threw = false
  try {
    toTask(row('bogus'), 'C')
  } catch {
    threw = true
  }
  check('约束外取值 → 抛错（不静默兜底）', threw)
}

console.log('')
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
