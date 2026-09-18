/**
 * 枚举 CHECK 约束**只读探针**：确认某个值到底被不被数据库接受，且**一行都不写**。
 *
 * 运行：`npm run probe:schema`
 *
 * ### 为什么需要它
 * 迁移是在 Supabase Dashboard 手工跑的，回执只有 `Success. No rows returned` ——
 * 那句话**不能证明约束真的换成了新的一组值**（DROP 了但 ADD 失败也会是 Success，
 * 只是……不会，但把约束 DROP 掉却没 ADD 上、或 ADD 上了却没包含新值，都是可能的）。
 * 而 `tsc` / `eslint` / `build` 更证明不了：数据库侧的事，只有问数据库才知道。
 *
 * ### 怎么做到"只读"（这是本脚本的核心技巧）
 * Postgres 里约束的**执行顺序**是固定的：
 *   1. `CHECK` / `NOT NULL` —— 在堆元组写入时（`ExecConstraints`）就求值；
 *   2. `FOREIGN KEY` —— 是 `AFTER ROW` 触发器，在**语句末尾**才跑。
 * 于是：**故意给一个一定不存在的外键**（全零 UUID），
 *   - 值被 CHECK 放行 → 语句走到末尾 → 报 **23503 外键冲突**；
 *   - 值被 CHECK 拦下 → 更早一步就报 **23514 CHECK 冲突**。
 * 两种都是**报错回滚**，所以一行都不会落地。用错误码反推枚举是否放行。
 *
 * ⚠️ 必须有**对照组**（喂一个肯定非法的值，期望它被拒）：
 * 否则"放行"这个结论毫无意义 —— 约束要是整条被人删掉了，任何值都会"放行"。
 *
 * ### 兜底
 * 万一某个用例**真的写进去了**（没有外键拦住的表），脚本立刻按 id 删除并大声报警，
 * 最后以非零码退出 —— 探针绝不留下垃圾行。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** tsx 不自动加载 .env.local（那是 Next 的特权），与 probe-course-parse.ts 同一手法。 */
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

/** 保证不存在的外键值（`gen_random_uuid()` 永远不会产出全零）。 */
const BOGUS_UUID = '00000000-0000-0000-0000-000000000000'

type Case = {
  /** 报告里显示的一行文字。 */
  label: string
  table: string
  /** 要写进去的整行（含那个**故意不存在的外键**）。 */
  row: Record<string, unknown>
  /** 期望结果。 */
  expect: 'accepted' | 'rejected'
  /** 这条在验什么。 */
  why: string
  /**
   * `true` = 侦察性质：结果**不作为失败判据**。
   * 用于那些"迁移还没跑"的表（后两张卡的枚举），报出来是给人看现状的。
   */
  advisory?: boolean
}

const CASES: Case[] = [
  // ---------- P0-3-24 本卡迁移：grade_components.source 加 'canvas' ----------
  {
    label: "grade_components.source = 'canvas'",
    table: 'grade_components',
    row: { course_id: BOGUS_UUID, name: 'probe', source: 'canvas' },
    expect: 'accepted',
    why: '本卡迁移的核心 —— 3-25/3-19 的 Canvas 侧成绩构成要靠它标来源',
  },
  {
    label: "grade_components.source = 'syllabus'（老值）",
    table: 'grade_components',
    row: { course_id: BOGUS_UUID, name: 'probe', source: 'syllabus' },
    expect: 'accepted',
    why: '重写约束时别把老值弄丢（syllabus 是现有全部行的值）',
  },
  {
    label: "grade_components.source = 'manual'（老值）",
    table: 'grade_components',
    row: { course_id: BOGUS_UUID, name: 'probe', source: 'manual' },
    expect: 'accepted',
    why: '同上；manual 是 P0-3-24 对话框写入用的来源',
  },
  {
    label: "grade_components.source = '__bogus__'（对照组）",
    table: 'grade_components',
    row: { course_id: BOGUS_UUID, name: 'probe', source: '__bogus__' },
    expect: 'rejected',
    why: '证明 CHECK **确实在拦** —— 没有对照组，"放行"可能只是约束被删了',
  },

  // ---------- P0-3-25 的枚举：messages.type 加 'announcement' ----------
  {
    label: "messages.type = 'announcement'",
    table: 'messages',
    row: { user_id: BOGUS_UUID, type: 'announcement', payload: {} },
    expect: 'accepted',
    why: 'P0-3-25 公告进站要用。**这是该卡的验收闸**：仍被拒 = 迁移没生效',
  },
  {
    label: "messages.type = 'material'（老值）",
    table: 'messages',
    row: { user_id: BOGUS_UUID, type: 'material', payload: {} },
    expect: 'accepted',
    why: '重写 CHECK 时别把老值弄丢',
  },

  // ---------- P0-3-26 的枚举（侦察，不作为判据） ----------
  {
    label: "messages.status = 'undone'",
    table: 'messages',
    row: { user_id: BOGUS_UUID, type: 'material', payload: {}, status: 'undone' },
    expect: 'rejected',
    why: 'P0-3-26 撤销回执要用；现在被拒 = 迁移还没跑（预期如此）',
    advisory: true,
  },
  {
    label: "messages.type = '__bogus__'（对照组）",
    table: 'messages',
    row: { user_id: BOGUS_UUID, type: '__bogus__', payload: {} },
    expect: 'rejected',
    why: '证明 messages 的 CHECK 在正常工作（探针本身可信）',
  },
]

type Verdict = 'accepted' | 'rejected' | 'unexpected'

/** 错误码 → 人话。 */
function explain(code: string | undefined, message: string): string {
  switch (code) {
    case '23503':
      return 'CHECK 放行（被外键拦住 —— 这是预期内的"没写进去"）'
    case '23514':
      return 'CHECK 拦下'
    case '23502':
      return 'NOT NULL 拦下（多半是列名写错了）'
    case '42501':
      return '权限不足 —— 检查是否误用了 anon key（本探针必须用 service role）'
    case '42P01':
      return '表不存在 —— 迁移没跑或跑的表名不对'
    default:
      return message
  }
}

async function main(): Promise<void> {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（见 .env.local）')
    process.exit(1)
  }

  const results: {
    c: Case
    verdict: Verdict
    detail: string
    wroteId: string | null
  }[] = []

  for (const c of CASES) {
    // 直接打 PostgREST，不用 supabase-js：本探针**故意**要发非法值，
    // 而 supabase-js 的类型正是拦这些值的那道墙 —— 绕开它才问得到数据库本身。
    const res = await fetch(`${url}/rest/v1/${c.table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // 要回传插入结果，才能拿到 id 好兜底删除（正常情况下永远拿不到）。
        Prefer: 'return=representation',
      },
      body: JSON.stringify(c.row),
    })

    const body = (await res.json().catch(() => null)) as
      | { id?: string; code?: string; message?: string }[]
      | { id?: string; code?: string; message?: string }
      | null

    if (res.ok) {
      // 真写进去了 —— 立刻删掉，且这是一条必须被看见的告警。
      const row = Array.isArray(body) ? body[0] : body
      const id = row?.id ?? null
      if (id) {
        await fetch(`${url}/rest/v1/${c.table}?id=eq.${id}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        })
      }
      results.push({
        c,
        verdict: 'unexpected',
        detail: '⚠️ 竟然写进去了（"只读"前提被打破）—— 已尝试按 id 删除',
        wroteId: id,
      })
      continue
    }

    const err = Array.isArray(body) ? body[0] : body
    const code = err?.code
    const verdict: Verdict =
      code === '23503' ? 'accepted' : code === '23514' ? 'rejected' : 'unexpected'
    results.push({
      c,
      verdict,
      detail: explain(code, err?.message ?? `HTTP ${res.status}`),
      wroteId: null,
    })
  }

  // ---------- 报告 ----------
  console.log('\n枚举 CHECK 只读探针 —— 一行都没写（每个用例都被外键/CHECK 拦回滚）\n')
  let failed = 0
  for (const r of results) {
    const ok = r.verdict === r.c.expect
    if (!ok && !r.c.advisory) failed += 1
    const mark = ok ? '✅' : r.c.advisory ? 'ℹ️ ' : '❌'
    console.log(`${mark} ${r.c.label}`)
    console.log(`     期望 ${r.c.expect} / 实测 ${r.verdict} —— ${r.detail}`)
    if (!ok) console.log(`     为什么有这条：${r.c.why}`)
    if (r.wroteId) console.log(`     ⚠️ 残留行 id = ${r.wroteId}（请人工核对是否已删）`)
  }

  // ---------- 零残留自检 ----------
  // 上面的推理成立的话，这些哨兵值一行都不该在库里。这里**查一遍**而不是"相信推理"：
  // 万一哪天有人给这些表去掉了外键，探针就会开始真的写数据 —— 那时这行会立刻报警。
  const RESIDUE: Record<string, string> = {
    grade_components: `name=eq.probe&course_id=eq.${BOGUS_UUID}`,
    messages: `user_id=eq.${BOGUS_UUID}`,
  }
  console.log('\n零残留自检（每个哨兵条件都应 0 行）：')
  for (const [table, qs] of Object.entries(RESIDUE)) {
    const res = await fetch(`${url}/rest/v1/${table}?select=id&${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    const rows = (await res.json().catch(() => [])) as { id?: string }[]
    const count = Array.isArray(rows) ? rows.length : 0
    console.log(`  ${count === 0 ? '✅' : '⚠️'} ${table}：${count} 行`)
    if (count > 0) {
      for (const row of rows) {
        if (!row?.id) continue
        await fetch(`${url}/rest/v1/${table}?id=eq.${row.id}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        })
      }
      console.log('     已按 id 删除；请人工确认这是探针留下的而不是你的真实数据')
      failed += 1
    }
  }

  // ---------- 结论 ----------
  const canvasCase = results.find((r) => r.c.label.includes("'canvas'"))
  const announcementCase = results.find((r) => r.c.label.includes("'announcement'"))
  const controlCase = results.find((r) => r.c.label.includes('__bogus__'))
  console.log('\n结论：')
  if (canvasCase?.verdict === 'accepted' && controlCase?.verdict === 'rejected') {
    console.log("  ✅ P0-3-24 迁移生效：grade_components.source 已接受 'canvas'，且 CHECK 仍在拦非法值。")
  } else if (canvasCase?.verdict !== 'accepted') {
    console.log("  ❌ P0-3-24 迁移**未生效**：'canvas' 仍被拒 —— 回到 SQL Editor 重跑那份迁移。")
  } else {
    console.log('  ❌ 对照组异常：CHECK 没有拦下非法值 —— 约束可能被整体删掉了，人工核对。')
  }

  if (announcementCase?.verdict === 'accepted') {
    console.log("  ✅ P0-3-25 迁移生效：messages.type 已接受 'announcement'。")
  } else {
    console.log(
      "  ⏳ P0-3-25 迁移**未跑**：'announcement' 仍被拒 —— 跑 `20260919000000_announcements.sql` 后再来。",
    )
  }

  const pending = results.filter((r) => r.c.advisory)
  for (const r of pending) {
    console.log(
      `  ℹ️  ${r.c.label} → ${r.verdict}（${r.verdict === 'rejected' ? '符合预期：该卡的迁移还没跑' : '迁移已跑过'}）`,
    )
  }

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条不符合预期`}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
