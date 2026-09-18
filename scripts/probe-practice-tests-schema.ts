/**
 * P0-3-23 **迁移生效复核探针**（一次性工具）。
 *
 * 运行：`npx -y tsx scripts/probe-practice-tests-schema.ts`
 * （`probe:practice-tests-schema` 这条 npm script 由收尾 commit 补上 —— 本卡与 P0-3-20
 * 并行进行、共用 package.json，按窗口纪律先不改它。）
 *
 * ### 为什么不能拿 Dashboard 的 `Success. No rows returned` 当证据
 * 一次 Run 里若某条语句报错，**前面的可能已提交、后面的没跑**，而面板只显示最后一条
 * 的结果。`tsc` / `eslint` / `build` 更证明不了 —— 数据库侧的事只能问数据库。
 * （这条纪律的完整来龙去脉见 `docs/CodingRules.md` §10 与 `.workbuddy/memory/`。）
 *
 * ### 五查
 * ① **两张表在不在** —— `select=*&limit=0`，表不存在会回 `42P01`。
 * ② **列名逐一点名** —— `select=<每列>&limit=0`，缺列回 `42703` 并指名道姓。
 *    比 `select=*` 强：`*` 永远不会报"少了一列"，而"迁移跑了一半"正是最危险的形态。
 * ③ **枚举 CHECK 真的换值了** —— 用「故意不存在的外键」反推：CHECK/NOT NULL 在写入时
 *    求值，FOREIGN KEY 是 `AFTER ROW` 触发器、语句末尾才跑。于是喂一个全零 UUID：
 *      - 枚举被 CHECK **放行** → 走到末尾 → `23503`（外键冲突）；
 *      - 枚举被 CHECK **拦下** → `23514`（CHECK 冲突）。
 *    两种都报错回滚 → **一行都不落地**。必须有对照组（喂一个肯定非法的值），
 *    否则"放行"毫无意义 —— 约束要是整条被人删了，任何值都会"放行"。
 * ④ **RLS 两半** —— `anon` 读 vs **真实用户会话**读。
 *    ⚠️ 表空时「`anon` 读 → `[]`」**证明不了任何事**：RLS 在正常拦 / 表本来就空，
 *    两条路都返回 `[]`。所以本脚本**自己插一行真行再读**（插 → 两半各读一次 → 删）。
 * ⑤ **唯一键 `unique (exam_file_id)` 真的在工作** —— 拿同一份试卷插第二行 → `23505`。
 *    这一条只能靠真行验，FK 探针法做不到（唯一冲突需要两行）。
 *    顺带把 `locale` 的**反向断言**做了：`locale='fr'` 必须**放行**（走到外键才被拦）
 *    —— ADR-026 刻意不给 locale 加 CHECK，将来有人补上它，这里会变红。
 *
 * ### 副作用（必须知情）
 * 会**短暂**写入 2 行（`practice_tests` 1 行 + `practice_test_explanations` 1 行，
 * 都带 `__probe__` 标记、`status='failed'`），跑完立刻按 id 删除并做**零残留自检**。
 * 删 `practice_tests` 那行会 cascade 掉配套的 explanations 行（FK `on delete cascade`）。
 * 按 id 精确判定，**不受"库里已有用户真卷子"的影响**。
 *
 * 🔴 全程不打印任何密钥，也不打印试卷内容（本脚本本来就不碰文件内容）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** tsx 不自动加载 .env.local（那是 Next 的特权），与其它探针同一手法。 */
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
/** 探针行的标记（零残留自检按它查，绝不误伤用户真数据）。 */
const PROBE_TITLE = '__probe_schema_check__'

/** 逐列点名用：与迁移里的列**一一对应**（多写一个不存在的列会被 42703 抓住）。 */
const PRACTICE_TEST_COLUMNS = [
  'id',
  'course_id',
  'exam_file_id',
  'answer_key_file_id',
  'pairing_rule',
  'title',
  'status',
  'paper',
  'exam_source_chars',
  'key_source_chars',
  'source_truncated',
  'exam_page_count',
  'key_page_count',
  'extract_method',
  'exam_modified_at',
  'key_modified_at',
  'model',
  'error_message',
  'created_at',
  'updated_at',
].join(',')

const EXPLANATION_COLUMNS = [
  'practice_test_id',
  'question_key',
  'locale',
  'status',
  'explanation',
  'model',
  'error_message',
  'created_at',
  'updated_at',
].join(',')

let failures = 0

function pass(label: string, detail = ''): void {
  console.log(`  ✅ ${label}${detail ? ` —— ${detail}` : ''}`)
}

function fail(label: string, detail = ''): void {
  failures += 1
  console.log(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`)
}

/** 把 PostgREST 的错误对象压成一行可读文本。 */
function describe(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const e = error as { code?: string; message?: string; details?: string; hint?: string }
  return [e.code, e.message, e.details].filter(Boolean).join(' | ')
}

type RestError = { code?: string; message?: string; details?: string; hint?: string } | null

/**
 * ③ 的通用实现：插一行、只看错误码、**不留行**。
 *
 * @param expect `23503` = 枚举被 CHECK 放行（好）；`23514` = 枚举被 CHECK 拦下。
 */
async function checkEnum(params: {
  label: string
  table: string
  row: Record<string, unknown>
  expect: '23503' | '23514'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
}): Promise<void> {
  const { error } = await params.client.from(params.table).insert(params.row)
  const got = (error as RestError)?.code ?? 'no-error'
  if (got === params.expect) {
    pass(params.label, got)
    return
  }
  if (got === 'no-error') {
    // 真写进去了 —— 说明外键也没了。立刻按 title 兜底删掉并大声报警。
    fail(params.label, '本应报错却被写入（约束可能整条缺失）')
    await params.client.from(params.table).delete().eq('title', PROBE_TITLE)
    return
  }
  fail(params.label, `期望 ${params.expect}，实际 ${got}（${describe(error)}）`)
}

async function main(): Promise<void> {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !serviceKey || !anonKey) {
    console.error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY')
    process.exitCode = 1
    return
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false } })
  /**
   * 🔴 两个 anon client，**不能合并成一个**。
   *
   * `verifyOtp()` 会把 session 写进**那个 client 自己的**内存 auth store，此后它的请求
   * 会带上 `Authorization: Bearer <用户 token>` —— **它已经不是匿名了**。
   * 本探针第一版就栽在这里：在同一个 client 上 verifyOtp 之后再"匿名读"，报出
   * 「anon 读到 1 行 —— RLS 没在拦」，而真相是**探针自己在冒充登录用户**，
   * 数据库那边完全无辜（差点据此去改好好的 RLS 策略）。
   * 所以：`authClient` 专职换 token，`anonBare` 从头到尾不碰 auth。
   */
  const anonBare = createClient(url, anonKey, { auth: { persistSession: false } })
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } })

  /** 第二条腿：raw fetch，**只带 apikey、绝不带 Authorization**。 */
  async function anonFetchRaw(table: string, filter: string): Promise<{ rows: number; note: string }> {
    const r = await fetch(`${url}/rest/v1/${table}?select=*&${filter}`, {
      headers: { apikey: anonKey as string },
    })
    const body: unknown = await r.json().catch(() => null)
    if (!r.ok) return { rows: -1, note: `HTTP ${r.status} ${JSON.stringify(body).slice(0, 120)}` }
    if (!Array.isArray(body)) {
      return { rows: -1, note: `非数组响应（查询失败，不能当 0 行）：${JSON.stringify(body).slice(0, 120)}` }
    }
    return { rows: body.length, note: `HTTP ${r.status}` }
  }

  // ---------------------------------------------------------------- ① 表在不在
  console.log('\n① 两张表存在吗')
  for (const t of ['practice_tests', 'practice_test_explanations']) {
    const { error } = await service.from(t).select('*').limit(0)
    if (error) fail(t, describe(error))
    else pass(t, 'select=*&limit=0 → 200')
  }

  // ---------------------------------------------------------------- ② 列名点名
  console.log('\n② 列名逐一点名（`*` 永远不会报「少了一列」）')
  {
    const { error } = await service.from('practice_tests').select(PRACTICE_TEST_COLUMNS).limit(0)
    if (error) fail(`practice_tests 的 20 列`, describe(error))
    else pass('practice_tests 的 20 列全部存在')
  }
  {
    const { error } = await service
      .from('practice_test_explanations')
      .select(EXPLANATION_COLUMNS)
      .limit(0)
    if (error) fail(`practice_test_explanations 的 9 列`, describe(error))
    else pass('practice_test_explanations 的 9 列全部存在')
  }

  // ---------------------------------------------------------------- ③ 枚举 CHECK
  console.log('\n③ 枚举 CHECK 真的换值了（外键探针法 · 零写入）')
  await checkEnum({
    label: 'practice_tests.status 放行 ok',
    table: 'practice_tests',
    client: service,
    expect: '23503',
    row: { course_id: BOGUS_UUID, exam_file_id: BOGUS_UUID, title: PROBE_TITLE, status: 'ok' },
  })
  await checkEnum({
    label: 'practice_tests.status 放行 failed',
    table: 'practice_tests',
    client: service,
    expect: '23503',
    row: { course_id: BOGUS_UUID, exam_file_id: BOGUS_UUID, title: PROBE_TITLE, status: 'failed' },
  })
  await checkEnum({
    label: 'practice_tests.status 拦下非法值（对照组）',
    table: 'practice_tests',
    client: service,
    expect: '23514',
    row: { course_id: BOGUS_UUID, exam_file_id: BOGUS_UUID, title: PROBE_TITLE, status: '__bogus__' },
  })
  await checkEnum({
    label: 'practice_test_explanations.status 放行 ok',
    table: 'practice_test_explanations',
    client: service,
    expect: '23503',
    row: { practice_test_id: BOGUS_UUID, question_key: 'q1', locale: 'zh-CN', status: 'ok' },
  })
  await checkEnum({
    label: 'practice_test_explanations.status 拦下非法值（对照组）',
    table: 'practice_test_explanations',
    client: service,
    expect: '23514',
    row: { practice_test_id: BOGUS_UUID, question_key: 'q1', locale: 'zh-CN', status: '__bogus__' },
  })
  await checkEnum({
    label: 'locale 未加 CHECK（反向下注：将来有人补上它会变红）',
    table: 'practice_test_explanations',
    client: service,
    expect: '23503',
    row: { practice_test_id: BOGUS_UUID, question_key: 'q1', locale: 'fr', status: 'ok' },
  })

  // ---------------------------------------------------------------- 取一份真实试卷
  console.log('\n④/⑤ 需要一个真实归属 —— 取一份已索引的 past exam')
  const { data: fileRow, error: fileError } = await service
    .from('course_files')
    .select('id,course_id,display_name')
    .limit(1)
    .maybeSingle()
  if (fileError || !fileRow) {
    fail('取 course_files 样本', fileError ? describe(fileError) : '表里一行都没有（3-19 同步没跑过？）')
    console.log('\n（拿不到真实归属，④⑤ 两查跳过。）')
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
    process.exitCode = failures === 0 ? 0 : 1
    return
  }
  const exam = fileRow as { id: string; course_id: string }
  pass('样本', `${exam.id.slice(0, 8)}…（课程 ${exam.course_id.slice(0, 8)}…）`)

  // 发一封 magiclink（不会真发邮件）换真实用户会话 —— 线上页面走的就是这条路。
  const { data: userList, error: listError } = await service.auth.admin.listUsers()
  const email = listError ? undefined : userList?.users?.find((u) => u.email)?.email
  if (!email) {
    fail('取用户邮箱', listError ? describe(listError) : '没有带 email 的用户')
    console.log(`\n结果：${failures} 项失败`)
    process.exitCode = 1
    return
  }
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (linkError || !tokenHash) {
    fail('生成 magiclink', linkError ? describe(linkError) : '没有 hashed_token')
    console.log(`\n结果：${failures} 项失败`)
    process.exitCode = 1
    return
  }
  const { data: otp, error: otpError } = await authClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  })
  const accessToken = otp?.session?.access_token
  if (otpError || !accessToken) {
    fail('换取用户会话', otpError ? describe(otpError) : '没有 access_token')
    console.log(`\n结果：${failures} 项失败`)
    process.exitCode = 1
    return
  }
  pass('真实用户会话', `${email}（未发任何邮件）`)

  const asUser = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  // ---------------------------------------------------------------- 落两行真行
  console.log('\n④ RLS 两半（必须先有真行 —— 空表时 anon 的 [] 什么都不证明）')
  const nowIso = new Date().toISOString()
  const { data: testRow, error: insertError } = await service
    .from('practice_tests')
    .insert({
      course_id: exam.course_id,
      exam_file_id: exam.id,
      answer_key_file_id: null,
      pairing_rule: null,
      title: PROBE_TITLE,
      status: 'failed',
      error_message: 'schema probe',
      exam_modified_at: nowIso,
    })
    .select('id')
    .single()
  if (insertError || !testRow) {
    fail('插入探针行（service role）', insertError ? describe(insertError) : '没有返回 id')
    console.log(`\n结果：${failures} 项失败`)
    process.exitCode = 1
    return
  }
  const testId = (testRow as { id: string }).id
  pass('插入探针行', `practice_tests ${testId.slice(0, 8)}…`)

  const { error: expInsertError } = await service.from('practice_test_explanations').insert({
    practice_test_id: testId,
    question_key: 'q1',
    locale: 'zh-CN',
    status: 'failed',
    explanation: {},
    error_message: 'schema probe',
  })
  if (expInsertError) fail('插入探针行（explanations）', describe(expInsertError))
  else pass('插入探针行', 'practice_test_explanations (q1, zh-CN)')

  // ④-a anon 读：别人读不到（两条腿：干净 client + raw fetch）
  {
    const { data, error } = await anonBare.from('practice_tests').select('id').eq('id', testId)
    if (error) fail('anon 读 practice_tests', describe(error))
    else if ((data ?? []).length === 0) pass('anon 读 practice_tests（干净 client）→ 0 行')
    else fail('anon 读 practice_tests', `读到 ${(data ?? []).length} 行 —— RLS 没在拦`)
  }
  {
    const raw = await anonFetchRaw('practice_tests', `id=eq.${testId}`)
    if (raw.rows === 0) pass('anon 读 practice_tests（raw · 仅 apikey）→ 0 行', raw.note)
    else if (raw.rows < 0) fail('anon 读 practice_tests（raw · 仅 apikey）', raw.note)
    else fail('anon 读 practice_tests（raw · 仅 apikey）', `读到 ${raw.rows} 行 —— RLS 没在拦`)
  }
  {
    const { data, error } = await anonBare
      .from('practice_test_explanations')
      .select('question_key')
      .eq('practice_test_id', testId)
    if (error) fail('anon 读 practice_test_explanations', describe(error))
    else if ((data ?? []).length === 0) pass('anon 读 explanations（两跳 RLS）→ 0 行')
    else fail('anon 读 explanations', `读到 ${(data ?? []).length} 行 —— 两跳 RLS 没在拦`)
  }
  {
    const raw = await anonFetchRaw('practice_test_explanations', `practice_test_id=eq.${testId}`)
    if (raw.rows === 0) pass('anon 读 explanations（raw · 仅 apikey）→ 0 行', raw.note)
    else if (raw.rows < 0) fail('anon 读 explanations（raw · 仅 apikey）', raw.note)
    else fail('anon 读 explanations（raw · 仅 apikey）', `读到 ${raw.rows} 行 —— 两跳 RLS 没在拦`)
  }

  // ④-b 真实用户会话读：本人读得到（这一半才是"线上页面读得到"的证明）
  {
    const { data, error } = await asUser.from('practice_tests').select('id').eq('id', testId)
    if (error) fail('用户会话读 practice_tests', describe(error))
    else if ((data ?? []).length === 1) pass('用户会话读 practice_tests → 1 行（本人读得到）')
    else fail('用户会话读 practice_tests', `读到 ${(data ?? []).length} 行，期望 1`)
  }
  {
    const { data, error } = await asUser
      .from('practice_test_explanations')
      .select('question_key')
      .eq('practice_test_id', testId)
    if (error) fail('用户会话读 explanations', describe(error))
    else if ((data ?? []).length === 1) pass('用户会话读 explanations → 1 行（两跳 RLS 生效）')
    else fail('用户会话读 explanations', `读到 ${(data ?? []).length} 行，期望 1`)
  }

  // ---------------------------------------------------------------- ⑤ 唯一键
  console.log('\n⑤ 唯一键 unique (exam_file_id) 真的在工作')
  {
    const { error } = await service
      .from('practice_tests')
      .insert({ course_id: exam.course_id, exam_file_id: exam.id, title: PROBE_TITLE })
    const code = (error as RestError)?.code ?? 'no-error'
    if (code === '23505') pass('同一份试卷插第二行被拦', code)
    else if (code === 'no-error') {
      fail('唯一键', '第二行被写进去了 —— unique 约束可能缺失')
      await service.from('practice_tests').delete().eq('exam_file_id', exam.id).eq('title', PROBE_TITLE)
    } else fail('唯一键', `期望 23505，实际 ${code}（${describe(error)}）`)
  }

  // ---------------------------------------------------------------- 清理 + 零残留自检
  console.log('\n清理（删 practice_tests 那行会 cascade 掉配套的 explanations 行）')
  {
    const { error } = await service.from('practice_tests').delete().eq('id', testId)
    if (error) fail('删除探针行', describe(error))
    else pass('删除探针行', testId.slice(0, 8) + '…')
  }
  {
    const { data, error } = await service.from('practice_tests').select('id').eq('id', testId)
    if (error) fail('零残留自检（practice_tests）', describe(error))
    else if ((data ?? []).length === 0) pass('零残留自检', 'practice_tests 0 行')
    else fail('零残留自检', `还留着 ${(data ?? []).length} 行`)
  }
  {
    // ⚠️ 这张表**没有 id 列**（PK 是复合键）—— 点 `select=id` 会拿到错误对象、
    //    被 `Array.isArray` 判假 → 假绿成 0 行。所以这里用 `select=*`。
    const { data, error } = await service
      .from('practice_test_explanations')
      .select('*')
      .eq('practice_test_id', testId)
    if (error) fail('零残留自检（explanations）', describe(error))
    else if ((data ?? []).length === 0) pass('零残留自检', 'practice_test_explanations 0 行')
    else fail('零残留自检', `还留着 ${(data ?? []).length} 行`)
  }
  {
    const { data, error } = await service.from('practice_tests').select('id').eq('title', PROBE_TITLE)
    if (error) fail('零残留自检（按标记）', describe(error))
    else if ((data ?? []).length === 0) pass('零残留自检', '按 __probe__ 标记查 → 0 行')
    else fail('零残留自检（按标记）', `还留着 ${(data ?? []).length} 行`)
  }

  console.log(`\n结果：${failures === 0 ? '五查全过 ✅' : `${failures} 项失败 ❌`}`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('探针异常退出：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
