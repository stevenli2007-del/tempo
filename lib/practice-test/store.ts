/**
 * `practice_tests` 与 `practice_test_explanations` 的读写（P0-3-23）。
 *
 * ### 与 `lib/messages/summary/store.ts` / `lib/course-files/summary/store.ts` 同一套纪律
 * 1. **调用方必须传会话 client**（不是 service role）：归属全靠 RLS
 *    （`practice_tests → courses.user_id`）。这里的 id 来自**客户端 URL**，
 *    用 service role 就是"能读别人的自测卷"——把越权写在明面上。
 * 2. **不抛异常**：一律返回 `{ ..., error }`，由界面决定怎么画。
 * 3. **失败也落一行**（`status = 'failed'`）：那行的意义是"别再重试"。
 *
 * ### 只在这里知道数据库列名
 * 与 `lib/tasks.ts` / `lib/messages.ts` 同一条约定：snake_case ↔ camelCase 的映射只有这一处。
 */

import type { SummaryLocale } from '@/lib/course-files/summary/locale'

import { readExplanation, readPaper } from './paper'
import type { PracticeExplanation, PracticePaper } from './paper'
import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 库里的一行自测卷（读取侧形状）。 */
export type StoredPracticeTest = {
  id: string
  courseId: string
  examFileId: string
  answerKeyFileId: string | null
  pairingRule: string | null
  title: string
  status: 'ok' | 'failed'
  paper: PracticePaper
  examSourceChars: number
  keySourceChars: number
  sourceTruncated: boolean
  examPageCount: number | null
  keyPageCount: number | null
  extractMethod: string | null
  /** 生成时两份文件在 Canvas 的 `modified_at` —— 与当前值不同 = 老师换过 = 重算。 */
  examModifiedAt: string | null
  keyModifiedAt: string | null
  model: string | null
  errorMessage: string | null
  createdAt: string
}

type TestRow = {
  id: string
  course_id: string
  exam_file_id: string
  answer_key_file_id: string | null
  pairing_rule: string | null
  title: string
  status: string
  paper: unknown
  exam_source_chars: number
  key_source_chars: number
  source_truncated: boolean
  exam_page_count: number | null
  key_page_count: number | null
  extract_method: string | null
  exam_modified_at: string | null
  key_modified_at: string | null
  model: string | null
  error_message: string | null
  created_at: string
}

/**
 * 查询列。
 *
 * ⚠️ **必须是一个单字符串字面量，不能用 `+` 拼**：supabase-js 是从**字面量类型**里解析列名的，
 * 拼出来的 `string` 会让它退回"解析不了"的分支，返回类型变成 `GenericStringError`
 * —— 表现是 `data as Row` 处报一个看不懂的 TS2352，跟运行时毫无关系。
 */
const TEST_COLUMNS =
  'id, course_id, exam_file_id, answer_key_file_id, pairing_rule, title, status, paper, exam_source_chars, key_source_chars, source_truncated, exam_page_count, key_page_count, extract_method, exam_modified_at, key_modified_at, model, error_message, created_at'

function toStoredTest(row: TestRow): StoredPracticeTest {
  return {
    id: row.id,
    courseId: row.course_id,
    examFileId: row.exam_file_id,
    answerKeyFileId: row.answer_key_file_id ?? null,
    pairingRule: row.pairing_rule ?? null,
    title: row.title ?? '',
    status: row.status === 'failed' ? 'failed' : 'ok',
    paper: readPaper(row.paper),
    examSourceChars: row.exam_source_chars ?? 0,
    keySourceChars: row.key_source_chars ?? 0,
    sourceTruncated: row.source_truncated === true,
    examPageCount: row.exam_page_count ?? null,
    keyPageCount: row.key_page_count ?? null,
    extractMethod: row.extract_method ?? null,
    examModifiedAt: row.exam_modified_at ?? null,
    keyModifiedAt: row.key_modified_at ?? null,
    model: row.model ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
  }
}

/** 按试卷取自测卷（唯一键就在它上面）。 */
export async function loadPracticeTestByExam(
  supabase: ServerSupabase,
  examFileId: string,
): Promise<{ test: StoredPracticeTest | null; error: string | null }> {
  const { data, error } = await supabase
    .from('practice_tests')
    .select(TEST_COLUMNS)
    .eq('exam_file_id', examFileId)
    .maybeSingle()

  if (error) return { test: null, error: error.message }
  if (!data) return { test: null, error: null }
  return { test: toStoredTest(data as TestRow), error: null }
}

/** 按主键取（讲解那条路用：只知道卷子 id，不知道试卷文件 id）。 */
export async function loadPracticeTestById(
  supabase: ServerSupabase,
  id: string,
): Promise<{ test: StoredPracticeTest | null; error: string | null }> {
  const { data, error } = await supabase
    .from('practice_tests')
    .select(TEST_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) return { test: null, error: error.message }
  if (!data) return { test: null, error: null }
  return { test: toStoredTest(data as TestRow), error: null }
}

/** 写一行自测卷（成功或失败都写，upsert 到 `exam_file_id`）。 */
export async function savePracticeTest(params: {
  supabase: ServerSupabase
  courseId: string
  examFileId: string
  answerKeyFileId: string | null
  pairingRule: string | null
  title: string
  status: 'ok' | 'failed'
  paper: PracticePaper
  examSourceChars: number
  keySourceChars: number
  sourceTruncated: boolean
  examPageCount: number | null
  keyPageCount: number | null
  extractMethod: string | null
  examModifiedAt: string | null
  keyModifiedAt: string | null
  model: string | null
  errorMessage: string | null
}): Promise<{ error: string | null }> {
  const { supabase, ...fields } = params

  const { error } = await supabase.from('practice_tests').upsert(
    {
      course_id: fields.courseId,
      exam_file_id: fields.examFileId,
      answer_key_file_id: fields.answerKeyFileId,
      pairing_rule: fields.pairingRule,
      title: fields.title,
      status: fields.status,
      paper: fields.paper,
      exam_source_chars: fields.examSourceChars,
      key_source_chars: fields.keySourceChars,
      source_truncated: fields.sourceTruncated,
      exam_page_count: fields.examPageCount,
      key_page_count: fields.keyPageCount,
      extract_method: fields.extractMethod,
      exam_modified_at: fields.examModifiedAt,
      key_modified_at: fields.keyModifiedAt,
      model: fields.model,
      error_message: fields.errorMessage,
    },
    { onConflict: 'exam_file_id' },
  )

  if (error) return { error: error.message }
  return { error: null }
}

// ---------------------------------------------------------------
// 逐题讲解
// ---------------------------------------------------------------

export type StoredExplanation = {
  questionKey: string
  status: 'ok' | 'failed'
  explanation: PracticeExplanation
  model: string | null
  errorMessage: string | null
}

type ExplanationRow = {
  question_key: string
  status: string
  explanation: unknown
  model: string | null
  error_message: string | null
}

function toStoredExplanation(row: ExplanationRow): StoredExplanation {
  return {
    questionKey: row.question_key,
    status: row.status === 'failed' ? 'failed' : 'ok',
    explanation: readExplanation(row.explanation),
    model: row.model ?? null,
    errorMessage: row.error_message ?? null,
  }
}

/**
 * 取一张卷子的全部讲解缓存。
 *
 * 一次查完（不是"每画一题查一次"）：卷面是一屏画出来的，逐题查会让打开慢 N 倍，
 * 而且 N 个查询里任何一个失败都会让那一题的位置闪一下。
 */
export async function loadExplanations(
  supabase: ServerSupabase,
  practiceTestId: string,
  locale: SummaryLocale,
): Promise<{ byKey: Map<string, StoredExplanation>; error: string | null }> {
  const { data, error } = await supabase
    .from('practice_test_explanations')
    .select('question_key, status, explanation, model, error_message')
    .eq('practice_test_id', practiceTestId)
    .eq('locale', locale)

  if (error) return { byKey: new Map(), error: error.message }

  const byKey = new Map<string, StoredExplanation>()
  for (const row of (data ?? []) as ExplanationRow[]) {
    byKey.set(row.question_key, toStoredExplanation(row))
  }
  return { byKey, error: null }
}

/** 取一题的讲解缓存。 */
export async function loadExplanation(
  supabase: ServerSupabase,
  practiceTestId: string,
  questionKey: string,
  locale: SummaryLocale,
): Promise<{ explanation: StoredExplanation | null; error: string | null }> {
  const { data, error } = await supabase
    .from('practice_test_explanations')
    .select('question_key, status, explanation, model, error_message')
    .eq('practice_test_id', practiceTestId)
    .eq('question_key', questionKey)
    .eq('locale', locale)
    .maybeSingle()

  if (error) return { explanation: null, error: error.message }
  if (!data) return { explanation: null, error: null }
  return { explanation: toStoredExplanation(data as ExplanationRow), error: null }
}

/** 写一行讲解（成功或失败都写）。 */
export async function saveExplanation(params: {
  supabase: ServerSupabase
  practiceTestId: string
  questionKey: string
  locale: SummaryLocale
  status: 'ok' | 'failed'
  explanation: PracticeExplanation
  model: string | null
  errorMessage: string | null
}): Promise<{ error: string | null }> {
  const { supabase, ...fields } = params

  const { error } = await supabase.from('practice_test_explanations').upsert(
    {
      practice_test_id: fields.practiceTestId,
      question_key: fields.questionKey,
      locale: fields.locale,
      status: fields.status,
      explanation: fields.explanation,
      model: fields.model,
      error_message: fields.errorMessage,
    },
    { onConflict: 'practice_test_id,question_key,locale' },
  )

  if (error) return { error: error.message }
  return { error: null }
}

// ---------------------------------------------------------------
// 消息（3-18 是全站唯一的提案/结果出口）
// ---------------------------------------------------------------

/**
 * 这张自测卷是不是已经投过消息了。
 *
 * 🔴 **一张自测卷只投一条消息**（不管那条现在是什么状态）：
 * 自测卷的唯一键是试卷，行 id 因此是稳定的 —— 若改成"每次生成都投一条"，
 * 用户每次打开页面都会收到一条新消息（而页面本来就会重渲染、甚至会被预取），
 * 消息栏会被自己刷屏。这是**刻意**的取舍，写在这里免得后人当成 bug 修掉。
 */
export async function findPracticeTestMessageId(
  supabase: ServerSupabase,
  practiceTestId: string,
): Promise<{ messageId: string | null; error: string | null }> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('type', 'practice_test')
    .contains('payload', { practiceTestId })
    .limit(1)
    .maybeSingle()

  if (error) return { messageId: null, error: error.message }
  if (!data) return { messageId: null, error: null }
  return { messageId: (data as { id: string }).id, error: null }
}

/**
 * 投一条 `practice_test` 消息。
 *
 * 载荷里**不放卷面**（题可能几十道，塞进 payload 会把消息列表整页拖大）：
 * 只放"是哪张卷、多少题、几题没答案"与一个指回卷子的 id。
 * `sourceUrl` 放的是**试卷在 Canvas 上的页面** —— 真正的「原文 ↗」，
 * 用户要核对题干时该看的是它。
 */
export async function createPracticeTestMessage(params: {
  supabase: ServerSupabase
  userId: string
  practiceTestId: string
  title: string
  details: string[]
  courseId: string
  courseName: string
  examFileUrl: string
  /** 指回自测卷页的**站内路径**（如 `/courses/<id>/practice-tests/new?exam=…`）。 */
  paperPath: string
}): Promise<{ messageId: string | null; error: string | null }> {
  const payload = {
    title: params.title,
    details: params.details,
    courseId: params.courseId,
    courseName: params.courseName,
    confidence: 'high' as const,
    // 真正的原文 = Canvas 上的试卷页（不是 Tempo 的卷子页）。
    sourceUrl: params.examFileUrl,
    practiceTestId: params.practiceTestId,
    paperPath: params.paperPath,
  }

  const { data, error } = await params.supabase
    .from('messages')
    .insert({ user_id: params.userId, type: 'practice_test', payload, status: 'pending' })
    .select('id')
    .single()

  if (error) return { messageId: null, error: error.message }
  return { messageId: (data as { id: string }).id, error: null }
}
