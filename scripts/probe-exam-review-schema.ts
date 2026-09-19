/**
 * P0-3-31 **复习模式迁移 + 存储配置复核探针**（一次性工具，兼长期配置哨兵）。
 *
 * 运行：`npm run probe:exam-review`
 *
 * ### 为什么不能拿 Dashboard 的 `Success. No rows returned` 当证据
 * 一次 Run 里若某条语句报错，**前面的可能已提交、后面的没跑**，而面板只显示最后一条的结果。
 * `tsc` / `eslint` / `build` 更证明不了 —— 数据库侧的事只能问数据库。
 *
 * ### 🔴 为什么本卡还多一层：桶与策略**不在版本控制里**
 * `syllabi` 桶的教训（20260902220000_storage_syllabi.sql 文件头）：`CREATE POLICY on
 * storage.objects` 会报 `42501: must be owner of table objects`（owner 是平台角色
 * `supabase_storage_admin`，SQL Editor 的 postgres 不是）。于是**桶 + 4 条策略只能在
 * Dashboard UI 手点**。这意味着它们是**手工配置、git 看不见、可以静默丢失**的东西 ——
 * 唯一可靠的复核方式是**行为验证**：真的以真实用户上传一次，看该放行的放行、该拒绝的拒绝。
 *
 * ### 六查
 * ① **桶存在且是私有的** —— `getBucket()`：`public=false`、`file_size_limit` 与代码常量一致。
 *    桶没建 / 建成了公开桶，这里必须红。
 * ② **两张表在不在** —— `select=*&limit=0`，表不存在回 `42P01`。
 * ③ **列名逐一点名** —— `select=<每列>&limit=0`，缺列回 `42703` 并指名道姓。
 *    比 `select=*` 强：`*` 永远不会报「少了一列」，而「迁移跑了一半」正是最危险的形态。
 * ④ **枚举 CHECK 真的换值了** —— 外键探针法：CHECK/NOT NULL 在写入时求值，FOREIGN KEY 是
 *    `AFTER ROW` 触发器、语句末尾才跑。喂一个全零 UUID：
 *      - 枚举被 CHECK **放行** → 走到末尾 → `23503`（外键冲突）；
 *      - 枚举被 CHECK **拦下** → `23514`（CHECK 冲突）。
 *    两种都报错回滚 → **一行都不落地**。必须有对照组（喂肯定非法的值），否则「放行」无意义。
 *    顺带做 `locale` 的**反向断言**：`locale='fr'` 必须**放行**（ADR-026 刻意不给 locale 加
 *    CHECK —— 语言是数据维度，加一种语言不该被一次迁移卡住）。将来有人补上它，这里会变红。
 * ⑤ **RLS 两半（表）** —— `anon` 读 vs **真实用户会话**读。
 *    ⚠️ 表空时「`anon` 读 → `[]`」**证明不了任何事**：RLS 在正常拦 / 表本来就空，两条路都返回
 *    `[]`。所以本脚本**自己插真行再读**（插 → 两半各读一次 → 删）。
 *    另做 `unique (course_id, exam_key, locale)`：同键插第二行必须 `23505`（并发重入靠它收敛）。
 * ⑥ **RLS 两半（Storage）** —— 这一条只能行为验证，且**同一个用户就能验两半**：
 *      - 传到自己 uid 段（`{uid}/…`）→ **允许**（线上正常路径）；
 *      - 传到别人的 uid 段（全零 UUID）→ **必须被拒**（策略 `(storage.foldername(name))[1]
 *        = auth.uid()::text` 在拦 —— 这是"把对象挪进别人目录"的唯一防线）。
 *    再加：`anon` 不该能签出签名 URL（桶是私有的）。
 *
 * ### 副作用（必须知情）
 * - 会**短暂**写入 2 行（`exam_review_files` / `exam_review_summaries` 各 1 行，都带
 *   `__probe_exam_key__` 标记、`status='failed'`），跑完立刻按 id / 主键删除并做**零残留自检**。
 * - 会**短暂**上传 1 个 13 字节的 Storage 对象到自己的目录，跑完立刻删并复核已不存在。
 * - 删 `courses` 那行会 cascade 掉表里的探针行 —— 本探针**不删任何课程**，只删自己插的行。
 *   按 id / 标记精确判定，**不受"库里已有用户真数据"的影响**。
 *
 * 🔴 全程不打印任何密钥，也不打印任何文件内容（本脚本本来就不碰内容）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import {
  EXAM_REVIEW_BUCKET,
  REVIEW_MAX_FILE_SIZE_BYTES,
  buildReviewStoragePath,
} from '@/lib/review/storage'

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
/** 探针行标记（零残留自检按它查，绝不误伤用户真数据）。 */
const PROBE_EXAM_KEY = '__probe_exam_key__'

/** 逐列点名用：与迁移里的列**一一对应**（多写一个不存在的列会被 42703 抓住）。 */
const FILES_COLUMNS = [
  'id',
  'course_id',
  'user_id',
  'exam_key',
  'exam_label',
  'display_name',
  'storage_path',
  'content_type',
  'size_bytes',
  'is_deleted',
  'created_at',
  'updated_at',
].join(',')

const SUMMARIES_COLUMNS = [
  'course_id',
  'exam_key',
  'locale',
  'status',
  'source_manifest',
  'summary',
  'source_chars',
  'source_truncated',
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

/** 把 PostgREST / Storage 的错误对象压成一行可读文本。 */
function describe(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const e = error as {
    code?: string
    message?: string
    details?: string
    hint?: string
    statusCode?: string | number
  }
  return [e.statusCode, e.code, e.message, e.details].filter(Boolean).join(' | ')
}

type RestError = { code?: string; message?: string; details?: string; hint?: string } | null

/**
 * ④ 的通用实现：插一行、只看错误码、**不留行**。
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
    // 真写进去了 —— 说明外键也没了。立刻按标记兜底删掉并大声报警。
    fail(params.label, '本应报错却被写入（约束可能整条缺失）')
    await params.client.from(params.table).delete().eq('exam_key', PROBE_EXAM_KEY)
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
    console.error(
      '缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY',
    )
    process.exitCode = 1
    return
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false } })
  /**
   * 🔴 两个 anon client，**不能合并成一个**（P0-3-23 探针踩过这个坑）：
   * `verifyOtp()` 会把 session 写进**那个 client 自己的**内存 auth store，此后它的请求会带上
   * `Authorization: Bearer <用户 token>` —— **它已经不是匿名了**。若拿它去"匿名读"，会报出
   * 「anon 读到 1 行 —— RLS 没在拦」，而真相是**探针自己在冒充登录用户**，数据库完全无辜。
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
      return {
        rows: -1,
        note: `非数组响应（查询失败，不能当 0 行）：${JSON.stringify(body).slice(0, 120)}`,
      }
    }
    return { rows: body.length, note: `HTTP ${r.status}` }
  }

  // ---------------------------------------------------------------- ① 桶
  console.log('\n① Storage 桶（**手工配置、git 看不见**，所以只能行为验证）')
  /**
   * 🔴 桶不在时，⑥ 的三条**全部是假绿**：上传会因 `NoSuchBucket` 失败，
   * 而"传别人目录被拒""anon 签不出 URL"也会"看起来通过"—— 真相是没有桶，不是策略在拦。
   * 所以 ⑥ 整体以它为闸门，桶不在就**明说跳过**，绝不让 404 伪装成 RLS 生效。
   */
  let bucketReady = false
  {
    const { data: bucket, error } = await service.storage.getBucket(EXAM_REVIEW_BUCKET)
    if (error || !bucket) {
      fail(
        `桶 ${EXAM_REVIEW_BUCKET} 存在`,
        `${
          error ? describe(error) : '未返回'
        } —— 照迁移文件头在 Dashboard → Storage → New bucket 建（public=off, 20MB），并建 4 条策略。上传/读取会全挂。`,
      )
    } else {
      bucketReady = true
      pass(`桶 ${EXAM_REVIEW_BUCKET} 存在`)
      if (bucket.public === false) pass('桶是私有的（public=false）')
      else fail('桶是私有的', `public=${String(bucket.public)} —— 公开桶 = 任何人拿到 URL 就能下载，等于绕过 RLS`)

      const limit = (bucket as { file_size_limit?: number | null }).file_size_limit ?? null
      if (limit === REVIEW_MAX_FILE_SIZE_BYTES) {
        pass('桶上限与代码常量一致', `${limit} bytes`)
      } else if (limit === null) {
        fail('桶上限与代码常量一致', `桶没设上限（null），代码期望 ${REVIEW_MAX_FILE_SIZE_BYTES}`)
      } else {
        fail(
          '桶上限与代码常量一致',
          `桶=${limit} / 代码=${REVIEW_MAX_FILE_SIZE_BYTES} —— 三者（桶、迁移注释、常量）必须一致`,
        )
      }
    }
  }

  // ---------------------------------------------------------------- ② 表在不在
  console.log('\n② 两张表存在吗')
  for (const t of ['exam_review_files', 'exam_review_summaries']) {
    const { error } = await service.from(t).select('*').limit(0)
    if (error) fail(t, describe(error))
    else pass(t, 'select=*&limit=0 → 200')
  }

  // ---------------------------------------------------------------- ③ 列名点名
  console.log('\n③ 列名逐一点名（`*` 永远不会报「少了一列」）')
  {
    const { error } = await service.from('exam_review_files').select(FILES_COLUMNS).limit(0)
    if (error) fail('exam_review_files 的 12 列', describe(error))
    else pass('exam_review_files 的 12 列全部存在')
  }
  {
    const { error } = await service.from('exam_review_summaries').select(SUMMARIES_COLUMNS).limit(0)
    if (error) fail('exam_review_summaries 的 12 列', describe(error))
    else pass('exam_review_summaries 的 12 列全部存在')
  }

  // ---------------------------------------------------------------- ④ 枚举 CHECK
  console.log('\n④ 枚举 CHECK 真的换值了（外键探针法 · 零写入）')
  await checkEnum({
    label: 'exam_review_summaries.status 放行 ok',
    table: 'exam_review_summaries',
    client: service,
    expect: '23503',
    row: { course_id: BOGUS_UUID, exam_key: PROBE_EXAM_KEY, locale: 'zh-CN', status: 'ok' },
  })
  await checkEnum({
    label: 'exam_review_summaries.status 放行 failed（落这行 = 别再重试）',
    table: 'exam_review_summaries',
    client: service,
    expect: '23503',
    row: { course_id: BOGUS_UUID, exam_key: PROBE_EXAM_KEY, locale: 'zh-CN', status: 'failed' },
  })
  await checkEnum({
    label: 'exam_review_summaries.status 拦下非法值（对照组）',
    table: 'exam_review_summaries',
    client: service,
    expect: '23514',
    row: { course_id: BOGUS_UUID, exam_key: PROBE_EXAM_KEY, locale: 'zh-CN', status: '__bogus__' },
  })
  await checkEnum({
    label: 'exam_review_summaries.locale 未加 CHECK（反向下注：将来有人补上它会变红）',
    table: 'exam_review_summaries',
    client: service,
    expect: '23503',
    row: { course_id: BOGUS_UUID, exam_key: PROBE_EXAM_KEY, locale: 'fr', status: 'ok' },
  })
  await checkEnum({
    label: 'exam_review_files 表结构可直接插入（只被外键拦）',
    table: 'exam_review_files',
    client: service,
    expect: '23503',
    row: {
      course_id: BOGUS_UUID,
      user_id: BOGUS_UUID,
      exam_key: PROBE_EXAM_KEY,
      display_name: 'probe.pdf',
      storage_path: `${BOGUS_UUID}/${BOGUS_UUID}/probe.pdf`,
    },
  })

  // ---------------------------------------------------------------- 取真实归属
  console.log('\n⑤/⑥ 需要一个真实归属 —— 取一门真实课程 + 它的主人')
  const { data: courseRow, error: courseError } = await service
    .from('courses')
    .select('id,user_id')
    .not('user_id', 'is', null)
    .limit(1)
    .maybeSingle()
  if (courseError || !courseRow) {
    fail('取 courses 样本', courseError ? describe(courseError) : '表里一行都没有（Canvas 同步没跑过？）')
    console.log('\n（拿不到真实归属，⑤⑥ 两查跳过 —— 但 ①~④ 的结论仍然有效。）')
    console.log(`\n结果：${failures === 0 ? '已跑部分全部通过' : `${failures} 项失败`}`)
    process.exitCode = failures === 0 ? 0 : 1
    return
  }
  const course = courseRow as { id: string; user_id: string }
  pass('课程样本', `${course.id.slice(0, 8)}…`)

  // 发一封 magiclink（**不会真发邮件**）换真实用户会话 —— 线上页面走的就是这条路。
  const { data: userList, error: listError } = await service.auth.admin.listUsers()
  const owner = listError ? undefined : userList?.users?.find((u) => u.id === course.user_id)
  if (!owner?.email) {
    fail(
      '取课程主人的邮箱',
      listError ? describe(listError) : '课程 owner 没有 email（或已不在 auth.users 里）',
    )
    console.log(`\n结果：${failures} 项失败`)
    process.exitCode = 1
    return
  }
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: owner.email,
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
  pass('真实用户会话', `${owner.email}（未发任何邮件）`)

  const asUser = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  // ---------------------------------------------------------------- 落两行真行
  console.log('\n⑤ RLS 两半 · 表（必须先有真行 —— 空表时 anon 的 [] 什么都不证明）')
  const probeFileId = crypto.randomUUID()
  const probeStoragePath = buildReviewStoragePath(
    course.user_id,
    course.id,
    probeFileId,
    'pdf',
  )
  const { data: fileInsert, error: fileInsertError } = await service
    .from('exam_review_files')
    .insert({
      id: probeFileId,
      course_id: course.id,
      user_id: course.user_id,
      exam_key: PROBE_EXAM_KEY,
      exam_label: PROBE_EXAM_KEY,
      display_name: '__probe__.pdf',
      storage_path: probeStoragePath,
      content_type: 'application/pdf',
      size_bytes: 13,
    })
    .select('id')
    .single()
  if (fileInsertError || !fileInsert) {
    fail('插入探针行（exam_review_files）', fileInsertError ? describe(fileInsertError) : '没有返回 id')
    console.log(`\n结果：${failures} 项失败`)
    process.exitCode = 1
    return
  }
  pass('插入探针行', `exam_review_files ${probeFileId.slice(0, 8)}…`)

  const { error: sumInsertError } = await service.from('exam_review_summaries').insert({
    course_id: course.id,
    exam_key: PROBE_EXAM_KEY,
    locale: 'zh-CN',
    status: 'failed',
    source_manifest: [],
    summary: {},
    error_message: 'schema probe',
  })
  if (sumInsertError) fail('插入探针行（exam_review_summaries）', describe(sumInsertError))
  else pass('插入探针行', 'exam_review_summaries (zh-CN, failed)')

  // ⑤-a anon 读：别人读不到（两条腿：干净 client + raw fetch）
  {
    const { data, error } = await anonBare.from('exam_review_files').select('id').eq('id', probeFileId)
    if (error) fail('anon 读 exam_review_files', describe(error))
    else if ((data ?? []).length === 0) pass('anon 读 exam_review_files（干净 client）→ 0 行')
    else fail('anon 读 exam_review_files', `读到 ${(data ?? []).length} 行 —— RLS 没在拦`)
  }
  {
    const raw = await anonFetchRaw('exam_review_files', `id=eq.${probeFileId}`)
    if (raw.rows === 0) pass('anon 读 exam_review_files（raw · 仅 apikey）→ 0 行', raw.note)
    else if (raw.rows < 0) fail('anon 读 exam_review_files（raw · 仅 apikey）', raw.note)
    else fail('anon 读 exam_review_files（raw · 仅 apikey）', `读到 ${raw.rows} 行 —— RLS 没在拦`)
  }
  {
    const { data, error } = await anonBare
      .from('exam_review_summaries')
      .select('exam_key')
      .eq('exam_key', PROBE_EXAM_KEY)
    if (error) fail('anon 读 exam_review_summaries', describe(error))
    else if ((data ?? []).length === 0) pass('anon 读 exam_review_summaries（两跳 RLS）→ 0 行')
    else fail('anon 读 exam_review_summaries', `读到 ${(data ?? []).length} 行 —— 两跳 RLS 没在拦`)
  }

  // ⑤-b 真实用户会话读：本人读得到（这一半才是"线上页面读得到"的证明）
  {
    const { data, error } = await asUser.from('exam_review_files').select('id').eq('id', probeFileId)
    if (error) fail('用户会话读 exam_review_files', describe(error))
    else if ((data ?? []).length === 1) pass('用户会话读 exam_review_files → 1 行（本人读得到）')
    else fail('用户会话读 exam_review_files', `读到 ${(data ?? []).length} 行，期望 1`)
  }
  {
    const { data, error } = await asUser
      .from('exam_review_summaries')
      .select('exam_key')
      .eq('course_id', course.id)
      .eq('exam_key', PROBE_EXAM_KEY)
    if (error) fail('用户会话读 exam_review_summaries', describe(error))
    else if ((data ?? []).length === 1) pass('用户会话读 exam_review_summaries → 1 行（两跳 RLS 生效）')
    else fail('用户会话读 exam_review_summaries', `读到 ${(data ?? []).length} 行，期望 1`)
  }

  // ⑤-c 唯一键 (course_id, exam_key, locale)
  {
    const { error } = await service.from('exam_review_summaries').insert({
      course_id: course.id,
      exam_key: PROBE_EXAM_KEY,
      locale: 'zh-CN',
      status: 'failed',
    })
    const code = (error as RestError)?.code ?? 'no-error'
    if (code === '23505') pass('同一 (课程, 考试, 语言) 插第二行被拦', code)
    else if (code === 'no-error') {
      fail('唯一键', '第二行被写进去了 —— 复合主键可能缺失')
      await service
        .from('exam_review_summaries')
        .delete()
        .eq('course_id', course.id)
        .eq('exam_key', PROBE_EXAM_KEY)
    } else fail('唯一键', `期望 23505，实际 ${code}（${describe(error)}）`)
  }

  // ---------------------------------------------------------------- ⑥ Storage 两半
  console.log('\n⑥ RLS 两半 · Storage（同一用户就能验两半：自己目录放行 / 别人目录必须拒）')
  const body = Buffer.from('%PDF-1.4 probe\n', 'utf8')

  if (!bucketReady) {
    // 桶不在 ⇒ 这三条一律**不许报结论**。硬跑一遍只会得到三个 `NoSuchBucket`，
    // 而其中"被拒""签不出"会长得像 RLS 生效 —— 那是本探针最容易骗自己的地方。
    console.log('  ℹ️  桶不存在，⑥ 三条**跳过**（现在跑只会拿 NoSuchBucket 冒充"策略在拦"）。')
    console.log('      建好桶与 4 条策略后重跑本探针，⑥ 才算真的验过。')
  } else {
    {
      const { error } = await asUser.storage.from(EXAM_REVIEW_BUCKET).upload(probeStoragePath, body, {
        contentType: 'application/pdf',
        upsert: true,
      })
      if (error) {
        fail(
          '传到自己 uid 段 → 应当允许',
          `${describe(error)} —— 线上"上传额外文件"会直接失败；多半是 4 条 storage 策略没建，或建错了表达式`,
        )
      } else {
        pass('传到自己 uid 段 → 允许', `…/${probeFileId.slice(0, 8)}…`)
      }
    }
    {
      // 换一个 uid 段：策略 `(storage.foldername(name))[1] = auth.uid()::text` 必须拦下。
      // 这是"往别人目录写 / 把对象挪进别人目录"的唯一防线 —— 两层隔离里最容易漏的一层。
      const foreignPath = buildReviewStoragePath(BOGUS_UUID, course.id, probeFileId, 'pdf')
      const { error } = await asUser.storage.from(EXAM_REVIEW_BUCKET).upload(foreignPath, body, {
        contentType: 'application/pdf',
        upsert: true,
      })
      if (error) pass('传到别人的 uid 段 → 被拒（这正是要的）', describe(error))
      else {
        fail(
          '传到别人的 uid 段 → 被拒',
          '居然写成功了 —— storage.objects 的策略没在拦（跨用户隔离第二层失效），**必须立刻补策略**',
        )
        await service.storage.from(EXAM_REVIEW_BUCKET).remove([foreignPath])
      }
    }
    {
      const { data, error } = await anonBare.storage
        .from(EXAM_REVIEW_BUCKET)
        .createSignedUrl(probeStoragePath, 60)
      if (error || !data?.signedUrl) pass('anon 签不出签名 URL（私有桶）', error ? describe(error) : '')
      else fail('anon 签不出签名 URL（私有桶）', '匿名居然签出来了 —— 桶可能是公开的')
    }
  }

  // ---------------------------------------------------------------- 清理 + 零残留自检
  console.log('\n清理')
  {
    const { error } = await service.storage.from(EXAM_REVIEW_BUCKET).remove([probeStoragePath])
    if (error) fail('删除探针对象', describe(error))
    else pass('删除探针对象', probeStoragePath)
  }
  {
    const { data, error } = await service
      .storage.from(EXAM_REVIEW_BUCKET)
      .list(`${course.user_id}/${course.id}`)
    if (error) fail('零残留自检（Storage）', describe(error))
    else {
      const left = (data ?? []).filter((o) => o.name.startsWith(probeFileId))
      if (left.length === 0) pass('零残留自检', 'Storage 目录里没有探针对象')
      else fail('零残留自检（Storage）', `还留着 ${left.length} 个`)
    }
  }
  {
    const { error } = await service.from('exam_review_files').delete().eq('id', probeFileId)
    if (error) fail('删除探针行（files）', describe(error))
    else pass('删除探针行', `exam_review_files ${probeFileId.slice(0, 8)}…`)
  }
  {
    const { error } = await service
      .from('exam_review_summaries')
      .delete()
      .eq('course_id', course.id)
      .eq('exam_key', PROBE_EXAM_KEY)
    if (error) fail('删除探针行（summaries）', describe(error))
    else pass('删除探针行', 'exam_review_summaries')
  }
  {
    const { data, error } = await service.from('exam_review_files').select('id').eq('id', probeFileId)
    if (error) fail('零残留自检（files）', describe(error))
    else if ((data ?? []).length === 0) pass('零残留自检', 'exam_review_files 0 行')
    else fail('零残留自检（files）', `还留着 ${(data ?? []).length} 行`)
  }
  {
    // ⚠️ 这张表**没有 id 列**（PK 是复合键）—— 点 `select=id` 会拿到错误对象、
    //    被 `Array.isArray` 判假 → 假绿成 0 行。所以这里用 `select=*`。
    const { data, error } = await service
      .from('exam_review_summaries')
      .select('*')
      .eq('exam_key', PROBE_EXAM_KEY)
    if (error) fail('零残留自检（summaries）', describe(error))
    else if ((data ?? []).length === 0) pass('零残留自检', 'exam_review_summaries 0 行')
    else fail('零残留自检（summaries）', `还留着 ${(data ?? []).length} 行`)
  }

  console.log(`\n结果：${failures === 0 ? '六查全过 ✅' : `${failures} 项失败 ❌`}`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('探针异常退出：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
