/**
 * P0-5-4 回归：音符的**纯逻辑** + **R5 文案闸门**。
 *
 * 运行：`npx -y tsx scripts/regress-notes.ts`（纯断言：不联网、不写库）
 *
 * ### 它守住什么
 * ① `earnsNote()` ——「值不值一枚音符」的唯一判据，必须**就是** `isEffectivelyDone()`。
 *    重点：**Canvas 代判完成也给**（Steven 2026-09-24 拍板）。若哪天有人改成
 *    `status === 'done'`，越 hands-off 音符越不涨，与 ADR-016 反向 —— 这里钉死。
 * ② `planAwards()` —— 幂等的核心：已记过的**绝不**再进 `toAward`，
 *    同一批里的重复 id 也只算一次（否则 `delta` 与库里对不上）。
 * ③ **不倒扣**：音符表里没有任何删除路径。取消勾选扣回一枚 = 惩罚性机制，ADR-016 R5 禁止。
 * ④ **R5 文案闸门**：字典里不许出现庆祝性 / 激励性文案。这条不是"顺手加的"——
 *    它是验收 ③ 的可执行形式，靠人眼看一遍字典，下次加文案时一定会漏。
 *
 * 落库那一半（主键兜底的幂等 / RLS）在数据库侧，靠 `probe:schema` + 真账号验，本文件不重复。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { messages } from '@/lib/i18n/messages'
import { earnsNote, NOTE_UNIT, planAwards, type NoteCandidate } from '@/lib/notes/awards'
import type { TaskStatus, TaskSubmissionState } from '@/types/task'

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

function task(
  id: string,
  status: TaskStatus,
  submissionState: TaskSubmissionState | null,
): NoteCandidate {
  return { id, status, submissionState }
}

console.log('earnsNote：判定必须就是 isEffectivelyDone（含 Canvas 代判）')
{
  check('手勾完成 → 给', earnsNote(task('t1', 'done', null)))
  check('未完成（pending + 无提交态）→ 不给', !earnsNote(task('t2', 'pending', null)))
  check('Canvas 判 submitted → 给（Steven 拍板：代判也给）', earnsNote(task('t3', 'pending', 'submitted')))
  check('Canvas 判 pending_review → 给', earnsNote(task('t4', 'pending', 'pending_review')))
  check('Canvas 判 graded → 给', earnsNote(task('t5', 'pending', 'graded')))
  check('Canvas 明说未交 unsubmitted → 不给', !earnsNote(task('t6', 'pending', 'unsubmitted')))
  check('缺交 missing → 不给', !earnsNote(task('t7', 'pending', 'missing')))
  // external_unconfirmed = 我们**不知道**交没交（ADR-013）。给 = 猜，不给 = 诬告，只能是第三态。
  check('外部平台无记录 external_unconfirmed → 不给（不知道 ≠ 完成）', !earnsNote(task('t8', 'pending', 'external_unconfirmed')))
}

console.log('\nplanAwards：幂等（重复确认不重复计分）')
{
  const batch = [
    task('a', 'done', null),
    task('b', 'pending', 'graded'),
    task('c', 'pending', null), // 未完成，不该进来
  ]

  const first = planAwards(batch, [])
  check('首次：两条已完成进 toAward', first.toAward.length === 2 && first.toAward.includes('a') && first.toAward.includes('b'), JSON.stringify(first.toAward))
  check('未完成的不进 toAward', !first.toAward.includes('c'))
  check('delta = 条数 × NOTE_UNIT', first.delta === 2 * NOTE_UNIT, String(first.delta))

  // 🔴 验收 ②：同一条任务重复确认不重复计分。
  const second = planAwards(batch, ['a', 'b'])
  check('已记过 → toAward 为空（幂等）', second.toAward.length === 0, JSON.stringify(second.toAward))
  check('已记过 → delta 为 0', second.delta === 0)
  check('已记过 → alreadyHeld 如实计数', second.alreadyHeld === 2, String(second.alreadyHeld))

  const partial = planAwards(batch, ['a'])
  check('只记过一半 → 只补缺的那条', partial.toAward.length === 1 && partial.toAward[0] === 'b', JSON.stringify(partial.toAward))

  // 同一批里出现两次同一个 id：不去重的话 delta 算 2、库里只写进 1 条，数字就漂了。
  const dup = planAwards([task('a', 'done', null), task('a', 'done', null)], [])
  check('同一批内重复 id 只算一次', dup.toAward.length === 1 && dup.delta === NOTE_UNIT, JSON.stringify(dup))

  const empty = planAwards([], [])
  check('空批次 → 全零', empty.toAward.length === 0 && empty.delta === 0 && empty.alreadyHeld === 0)

  check('NOTE_UNIT 恒为 1（不做加权：加权等于鼓励挑软柿子）', NOTE_UNIT === 1)
}

console.log('\n不倒扣：音符表没有任何删除路径')
{
  const store = readFileSync(resolve(process.cwd(), 'lib/notes/store.ts'), 'utf8')
  // ⚠️ 只匹配**调用**（`.xxx(`），不匹配注释里的字样 ——
  //    否则"我写了 upsert 会怎样"这句注释就会把闸门顶红（注释不是行为）。
  check('store.ts 没有 .delete()（取消勾选不倒扣）', !/\.delete\(/.test(store))
  check('store.ts 没有 .upsert()（它会把首次记入时刻刷新成现在）', !/\.upsert\(/.test(store))
  // 取消勾选不扣回 —— 这条只由"没有删除路径"实现，没有第二个开关可以打开它。
  const patchRoute = readFileSync(resolve(process.cwd(), 'app/api/v1/tasks/[id]/route.ts'), 'utf8')
  check('PATCH 里记入是**单向**的（没有 else 分支去删）', /if \(isEffectivelyDone\(updated\)\)/.test(patchRoute) && !/note_awards[\s\S]{0,200}\.delete\(/.test(patchRoute))
}

console.log('\nR5 文案闸门：庆祝性 / 激励性文案')
{
  // 第一档：全字典扫描 —— 这些词在任何文案里都不该出现。
  const hardBanned = ['你真棒', '真棒', '太棒了', '太棒', '继续保持', '冲刺', '加油', '好样的', '厉害', '棒极了', 'streak', '打卡', '签到']
  // 第二档：只针对音符文案 —— 这些词本身中性，但出现在"音符"旁边就变成激励机制。
  const notesBanned = ['目标', '等级', '升级', '连续', '解锁', '成就', '徽章', '奖励', '兑换', '积分']

  const allValues: { key: string; value: string; lang: string }[] = []
  for (const lang of ['zh', 'en'] as const) {
    for (const [key, value] of Object.entries(messages[lang])) {
      allValues.push({ key, value, lang })
    }
  }

  check('zh / en 键集一致', Object.keys(messages.zh).length === Object.keys(messages.en).length, `${Object.keys(messages.zh).length} vs ${Object.keys(messages.en).length}`)
  check('notes.* 三个键都在', ['notes.label', 'notes.total', 'notes.awardedSr'].every((k) => k in messages.zh && k in messages.en))

  for (const word of hardBanned) {
    const hits = allValues.filter((entry) => entry.value.includes(word))
    check(`全字典无「${word}」`, hits.length === 0, hits.map((h) => `${h.lang}.${h.key}`).join(', '))
  }

  const noteValues = allValues.filter((entry) => entry.key.startsWith('notes.'))
  check('音符文案至少有一条（否则闸门在空集上假绿）', noteValues.length >= 3, String(noteValues.length))
  for (const word of notesBanned) {
    const hits = noteValues.filter((entry) => entry.value.includes(word))
    check(`音符文案无「${word}」`, hits.length === 0, hits.map((h) => `${h.lang}.${h.key}`).join(', '))
  }

  // 彩带本身不带文字（卡面：不带文字，或只带中性的「+1」；我们选了不带）。
  const confetti = readFileSync(resolve(process.cwd(), 'components/notes/confetti.tsx'), 'utf8')
  // 卡面允许「不带文字」或「只带中性的 +1」；我们选了不带 ——
  // 判据 = 整个组件只用到**一处** `t()`，而那一处就挂在 sr-only 上。
  const tCalls = confetti.match(/\bt\('/g) ?? []
  check('彩带只有一处文案，且它挂在 sr-only 上', tCalls.length === 1 && /role="status"[\s\S]{0,120}t\('notes\./.test(confetti), `${tCalls.length} 处 t()`)
  check('视觉层整体 aria-hidden（读屏不读碎片）', /aria-hidden[\s\S]{0,200}note-confetti/.test(confetti) || /note-confetti[\s\S]{0,200}aria-hidden/.test(confetti))
  check('彩带整层不拦点击（pointer-events-none）', confetti.includes('pointer-events-none'))
  check('彩带尊重 prefers-reduced-motion', confetti.includes('prefers-reduced-motion'))
}

console.log('')
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
