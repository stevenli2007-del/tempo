/**
 * 自测卷的生成（P0-3-23）—— 按需 + 落库缓存。
 *
 * ### 触发时机：用户在资料区主动点，不是同步
 * 3-19 的红线是「**索引/同步路径**一个字节都不下载」——本模块走的是另一条路
 * （ADR-026 开的按需路径，本卡由 ADR-027 扩到"试卷 + 答案"两份）：
 * 用户点了某份试卷的「自测卷」，才为**那两份**文件取内容。
 * 索引路径**依然**零下载，271 个文件一个都没动。
 *
 * ### 全链路（六步，每步都可能失败，每步都分开报）
 * ① 读文件行与所属课程（`files.ts`，会话 client + RLS）
 * ② 取新鲜下载链（单文件端点返的 `url` 字段，**带短时 verifier，不落库**）
 * ③ 下载字节（**不落盘、不入库**，只在内存里过一遍）
 * ④ `lib/extract.ts` 抽文本（pdf / docx；**pptx 不走这条路**，见下）
 * ⑤ 调模型切题 + 配答案 → 校验 → 落 `practice_tests`
 * ⑥ 投一条 `practice_test` 消息（3-18 是唯一的提案/结果出口）
 *
 * ### 🔴 只处理 PDF / docx，不碰 PPTX（卡片明确的边界）
 * `lib/course-files/extractable.ts` 把 pptx 也判成"能抽"（3-19b 的一键总结可以读它），
 * 但**本卡刻意只收 pdf/docx**：试卷的可读性要求比讲义高得多
 * （切题错一行的代价是用户做错一道题），而 PPTX 的 `<a:t>` 抽出来没有版面信息，
 * 一道题常被拆成"每张幻灯片一段"。宁可如实说"幻灯片这条路本卡不做"。
 *
 * ### 🔴 失败分成两类，处理**必须不同**（3-19b 踩过，这里沿用）
 * - **确定性失败**（扫描件没有文字层、格式不支持、模型稳定地给不出符合 schema 的结果）
 *   → 落 `failed` 行。那行的意义是「**别再重试**」：否则每次打开都为同一份文件重打一次模型。
 * - **暂时性失败**（Canvas 5xx / 网络断 / 超时 / 凭据失效）→ **不落行**。
 *   那是"我这次没做到"，不是"这份材料做不了"。
 *
 * ### 🔴 答案文件读不出来时：整张卷子失败，而不是"悄悄变成没有答案"
 * 用户点的是「隐藏答案做成自测卷」。答案读不出来还假装成功，会给他一张
 * **每道题都没有答案**的卷子，而他却以为答案藏在后面 —— 那是静默降级。
 * 所以这条路**明确失败**并让他换一份答案文件。
 * ⚠️ 唯一的例外是"压根没配到答案文件"：那是**已知的、看得见的**状态（页面会写出来），
 * 不是失败。
 */

import { loadDecryptedCredential } from '@/lib/canvas/credentials'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import { formatFileSize } from '@/lib/course-files/grouping'
import {
  MAX_DOWNLOAD_BYTES,
  downloadFile,
  resolveDownloadUrl,
} from '@/lib/course-files/fetch-content'
import { extractSyllabusText } from '@/lib/extract'
import { runStructured } from '@/lib/llm/run'
import { sameInstant } from '@/lib/time'

import { paperHref, paperStats } from './paper'
import {
  PRACTICE_TEST_PROMPT_VERSION,
  buildPracticeInput,
  buildPracticeMessages,
  fallbackTitleFromFileName,
  practiceSchema,
  validatePracticeOutput,
} from './prompt'
import {
  createPracticeTestMessage,
  findPracticeTestMessageId,
  loadPracticeTestByExam,
  savePracticeTest,
} from './store'
import { findSibling } from './files'

import type { ExtractableExtension } from '@/lib/course-files/extractable'
import type { StoredPracticeTest } from './store'
import type { PracticeExamContext, PracticeFile } from './files'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 写进 `llm_runs.purpose`（那列没有 CHECK 约束，新用途直接加字面量）。 */
const PURPOSE = 'practice_test'

/** `error_message` 上限（同 `llm_runs` 的纪律：精简、不含用户内容）。 */
const ERROR_MESSAGE_MAX = 200

/**
 * 本卡只收这两种格式（见文件头）。**刻意不是** `detectExtractableExtension()` 的全集。
 */
const PAPER_EXTENSIONS: readonly ExtractableExtension[] = ['pdf', 'docx']

export type PracticeTestOutcome =
  | { status: 'ready'; test: StoredPracticeTest; cached: boolean }
  /** 这个类型 Tempo 读不了（ppt/图片/音视频）。**不是失败**，是能力边界。 */
  | { status: 'unsupported'; message: string }
  | { status: 'failed'; message: string }

// ---------------------------------------------------------------
// 单个文件的「取链 → 下载 → 抽文本」
// ---------------------------------------------------------------

type FetchedText =
  | { ok: true; text: string; pageCount: number | null; method: string | null }
  | { ok: false; message: string; permanent: boolean }

/**
 * 取一份文件在 Canvas 上的**新鲜**下载链。
 *
 * 🔴 **必须先打一次单文件端点**，不能直接用库里存的 `file_url`：
 * 那个是 `/courses/:cid/files/:fid`（给人点的预览页），而真正要的是 `url` 字段里那条
 * **带短时 verifier 的**下载链 —— 它会过期，所以每次生成都现场换一条（一个请求，很便宜）。
 *
 * ⚠️ 与 `lib/course-files/summary/generate.ts` **刻意不共用**：
 * 那个是"总结一份课件"的语义。共用之后，将来任何一边想改判据
 * （比如"总结允许 pptx、自测卷不允"）都会牵动另一边。
 * ⚠️ 但**真正搬字节的那两个函数是共用的**（`downloadFile` / `resolveDownloadUrl`）——
 * 它们的行为必须全站一致（能力凭据不发 Bearer、403/404 判永久失败），不能有两份实现。
 */
async function fetchFileText(params: {
  domain: string
  token: string
  canvasCourseId: string
  file: PracticeFile
  /** 出错时怎么称呼这份文件（"试卷" / "答案文件"），让用户知道是哪一份出的问题。 */
  roleLabel: string
}): Promise<FetchedText> {
  const { file, roleLabel } = params

  const ext = detectExtractableExtension(file.displayName, file.contentType)
  if (!ext) {
    return {
      ok: false,
      message: `${roleLabel}「${file.displayName}」：${unsupportedReason(file.displayName, file.contentType)}`,
      permanent: true,
    }
  }
  if (!PAPER_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      message:
        `${roleLabel}「${file.displayName}」是幻灯片（.${ext}）。` +
        '自测卷只处理 PDF 与 Word —— 幻灯片要视觉模型，排在后面的卡里。',
      permanent: true,
    }
  }

  if (!file.canvasFileId) {
    return { ok: false, message: `${roleLabel}缺少 Canvas 标识，无法定位。`, permanent: true }
  }

  // 大小闸门（库里已知的大小，超限连请求都不发）。
  if (file.sizeBytes !== null && file.sizeBytes > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      message: `${roleLabel}太大（${formatFileSize(file.sizeBytes) ?? '未知大小'}），超过上限。`,
      permanent: true,
    }
  }

  const resolved = await resolveDownloadUrl({
    domain: params.domain,
    token: params.token,
    canvasCourseId: params.canvasCourseId,
    canvasFileId: file.canvasFileId,
  })
  if (!resolved.url) {
    return {
      ok: false,
      message: `${roleLabel}取下载链接失败：${resolved.message ?? '未知原因'}`,
      permanent: resolved.permanent,
    }
  }

  const download = await downloadFile(resolved.url, MAX_DOWNLOAD_BYTES)
  if (!download.ok) {
    return { ok: false, message: `${roleLabel}下载失败：${download.message}`, permanent: download.permanent }
  }

  const extracted = await extractSyllabusText(ext, download.bytes)
  if (extracted.status !== 'extracted' || extracted.text === null) {
    // 「扫描件 / 图片型 PDF」是**确定性**的：同一个文件再抽一次还是空的。
    return {
      ok: false,
      message: `${roleLabel}抽不出文字：${extracted.error ?? '这份文件里没有文字层'}`,
      permanent: true,
    }
  }

  return {
    ok: true,
    text: extracted.text,
    pageCount: extracted.pageCount,
    method: extracted.method,
  }
}

// ---------------------------------------------------------------
// 生成
// ---------------------------------------------------------------

export type EnsurePracticeTestParams = {
  supabase: ServerSupabase
  userId: string
  /** 页面已经查过一次时直接传进来，省掉重复查同一行。 */
  context: PracticeExamContext
  /** 最终要用的答案文件 id（`null` = 这张卷子只有题目）。 */
  answerKeyFileId: string | null
  /** 自动配对命中的规则；用户自己换过就是 `null`（那一份不是任何规则选的）。 */
  pairingRule: string | null
}

/**
 * 生成（或命中缓存）一张自测卷。**不抛异常**，所有失败都收敛成 `PracticeTestOutcome`。
 *
 * 幂等：同一份试卷 + 同样两份文件重复调用时，缓存命中直接返回（`cached: true`），不花钱。
 */
export async function ensurePracticeTest(
  params: EnsurePracticeTestParams,
): Promise<PracticeTestOutcome> {
  const { supabase, userId, context } = params
  const { exam, courseName, canvasCourseId } = context

  // ---------- 0) 答案文件必须属于这门课（不接受任意 id） ----------
  const keyFile =
    params.answerKeyFileId === null ? null : findSibling(context.siblings, params.answerKeyFileId)
  if (params.answerKeyFileId !== null && keyFile === null) {
    return {
      status: 'failed',
      message: '选中的答案文件不在这个课程的资料里（可能已被删除），请重新从资料区选一份。',
    }
  }

  // ---------- 1) 能力边界（在发任何请求之前判，省一次下载） ----------
  const examExt = detectExtractableExtension(exam.displayName, exam.contentType)
  if (!examExt || !PAPER_EXTENSIONS.includes(examExt)) {
    return {
      status: 'unsupported',
      message: examExt
        ? `这份试卷是幻灯片（.${examExt}）—— 自测卷只处理 PDF 与 Word。`
        : `这份试卷${unsupportedReason(exam.displayName, exam.contentType)}`,
    }
  }

  // ---------- 2) 缓存 ----------
  const { test: cached, error: cacheError } = await loadPracticeTestByExam(supabase, exam.id)
  if (cacheError) {
    // 迁移没跑（42P01）会走到这里。**不降级成"没缓存"直接开算** ——
    // 那会让用户看到一个结果、但每次打开都重新花钱。如实报出来。
    return { status: 'failed', message: `读取自测卷缓存失败：${cacheError}` }
  }

  const keySignature = keyFile?.id ?? null
  const sourceUnchanged =
    cached !== null &&
    sameInstant(cached.examModifiedAt, exam.modifiedAt) &&
    sameInstant(cached.keyModifiedAt, keyFile?.modifiedAt ?? null) &&
    cached.answerKeyFileId === keySignature

  if (cached && sourceUnchanged) {
    if (cached.status === 'ok') {
      return { status: 'ready', test: cached, cached: true }
    }
    // 上一次是确定性失败，且两份文件都没变 → 直接复用那个结论，**不再打模型**。
    return { status: 'failed', message: cached.errorMessage ?? '这张自测卷上次生成失败。' }
  }

  // ---------- 3) 凭据 ----------
  const credential = await loadDecryptedCredential(supabase, userId)
  if (!credential) {
    return { status: 'failed', message: '还没有连接 Canvas，无法取到试卷内容。' }
  }
  if (credential.status !== 'active') {
    return { status: 'failed', message: 'Canvas 连接已失效，请重新生成 token 后再试。' }
  }
  if (!canvasCourseId) {
    return { status: 'failed', message: '这门课还没有关联 Canvas 课程，无法定位文件。' }
  }

  // ---------- 4) 试卷：取链 → 下载 → 抽文本 ----------
  const examFetched = await fetchFileText({
    domain: credential.canvasDomain,
    token: credential.token,
    canvasCourseId,
    file: exam,
    roleLabel: '试卷',
  })
  if (!examFetched.ok) {
    if (examFetched.permanent) {
      await persistFailure({
        params,
        courseName,
        exam,
        keyFile,
        message: examFetched.message,
      })
    }
    return { status: 'failed', message: examFetched.message }
  }

  // ---------- 5) 答案文件（可选，但"选了却读不出来"必须失败） ----------
  let keyText: string | null = null
  let keyPageCount: number | null = null
  if (keyFile) {
    const keyFetched = await fetchFileText({
      domain: credential.canvasDomain,
      token: credential.token,
      canvasCourseId,
      file: keyFile,
      roleLabel: '答案文件',
    })
    if (!keyFetched.ok) {
      if (keyFetched.permanent) {
        await persistFailure({
          params,
          courseName,
          exam,
          keyFile,
          message: keyFetched.message,
        })
      }
      // 🔴 不降级成"没有答案的卷子"（见文件头）。把话说明白，并给出下一步。
      return {
        status: 'failed',
        message: `${keyFetched.message} —— 换一份答案文件再试，或先把它从资料区排除。`,
      }
    }
    keyText = keyFetched.text
    keyPageCount = keyFetched.pageCount
  }

  // ---------- 6) 调模型切题 + 配答案 ----------
  const input = buildPracticeInput({
    courseName,
    examFileName: exam.displayName,
    keyFileName: keyFile?.displayName ?? null,
    examText: examFetched.text,
    keyText,
  })

  const result = await runStructured<unknown>({
    userId,
    purpose: PURPOSE,
    promptVersion: PRACTICE_TEST_PROMPT_VERSION,
    capability: 'text',
    schema: practiceSchema(),
    schemaName: 'PracticePaper',
    messages: buildPracticeMessages(input),
    // 要的是**忠实切题**不是创作：温度一高模型就会"顺手整理"题干、甚至补出答案。
    temperature: 0,
    maxOutputTokens: 4_000,
  })

  if (!result.ok) {
    const message = `${result.error.code}: ${result.error.message}`.slice(0, ERROR_MESSAGE_MAX)
    // ⚠️ 429 / 超时 / 5xx **不落 failed 行**：下次可能就好了。
    // 只有"模型稳定地给不出符合 schema 的结果"才值得拉黑。
    console.error('[practice-test] 调用模型失败:', exam.id, message)
    if (result.error.code === 'schema_mismatch' || result.error.code === 'refused') {
      await persistFailure({ params, courseName, exam, keyFile, message })
    }
    return { status: 'failed', message: `自测卷生成失败：${result.error.message}` }
  }

  const validated = validatePracticeOutput(
    result.data,
    fallbackTitleFromFileName(exam.displayName),
  )
  if (!validated.ok) {
    await persistFailure({
      params,
      courseName,
      exam,
      keyFile,
      message: validated.message,
      examPageCount: examFetched.pageCount,
      extractMethod: examFetched.method,
    })
    return { status: 'failed', message: `这份材料里没找到成题的题目（${validated.message}）。` }
  }

  if (validated.dropped > 0) {
    // 不拦（切出来的照常展示），但留痕："模型开始乱来"是 prompt 该修的早期信号。
    console.warn(`[practice-test] 模型多给/给坏了 ${validated.dropped} 条题目，已丢弃:`, exam.id)
  }

  // ---------- 7) 落库 ----------
  const saved = await savePracticeTest({
    supabase,
    courseId: exam.courseId,
    examFileId: exam.id,
    answerKeyFileId: keyFile?.id ?? null,
    pairingRule: keyFile ? params.pairingRule : null,
    title: validated.value.title,
    status: 'ok',
    paper: validated.value,
    examSourceChars: input.examSourceChars,
    keySourceChars: input.keySourceChars,
    sourceTruncated: input.truncated,
    examPageCount: examFetched.pageCount,
    keyPageCount,
    extractMethod: examFetched.method,
    examModifiedAt: exam.modifiedAt,
    keyModifiedAt: keyFile?.modifiedAt ?? null,
    model: result.usage.model,
    errorMessage: null,
  })
  if (saved.error) {
    // 写不进去 = 这次白算（下次还要重算）。降级继续：本次结果照样给用户看，但日志要响。
    console.error('[practice-test] 写入缓存失败（本次结果仍会显示，但下次会重算）:', saved.error)
  }

  const stored: StoredPracticeTest = {
    id: cached?.id ?? '',
    courseId: exam.courseId,
    examFileId: exam.id,
    answerKeyFileId: keyFile?.id ?? null,
    pairingRule: keyFile ? params.pairingRule : null,
    title: validated.value.title,
    status: 'ok',
    paper: validated.value,
    examSourceChars: input.examSourceChars,
    keySourceChars: input.keySourceChars,
    sourceTruncated: input.truncated,
    examPageCount: examFetched.pageCount,
    keyPageCount,
    extractMethod: examFetched.method,
    examModifiedAt: exam.modifiedAt,
    keyModifiedAt: keyFile?.modifiedAt ?? null,
    model: result.usage.model,
    errorMessage: null,
    createdAt: cached?.createdAt ?? new Date().toISOString(),
  }

  // 落库成功后**重新读一次**：`id` 是数据库生成的（upsert 没回传行），
  // 而投消息与后续的讲解请求都要用它。读一次比"猜 id"可靠得多，
  // 而且这一读走 RLS，顺带证明这一行**真的写进去了**（写失败时这里会读到 null）。
  const { test: persisted } = await loadPracticeTestByExam(supabase, exam.id)
  if (persisted) {
    await announcePracticeTest({ supabase, userId, test: persisted, context, keyFile, courseName })
    return { status: 'ready', test: persisted, cached: false }
  }

  // 读不回来（写入失败）：**照常把结果给用户看**，但没有 id 就没法投消息、
  // 也没法生成讲解。如实说出来，别让他以为一切正常。
  console.error('[practice-test] 落库后读不回来，本次结果不会有消息与讲解:', exam.id)
  return { status: 'ready', test: stored, cached: false }
}

/**
 * 投一条 `practice_test` 消息（页面上第一次生成这张卷子时）。
 *
 * **一张卷子只投一条**（判定在 `findPracticeTestMessageId` 的注释里）。
 * 投不进去**不算失败**：卷子已经生成好、页面也能打开，消息只是通知 ——
 * 为了通知失败而把整个生成判失败是本末倒置。但要留日志。
 */
async function announcePracticeTest(params: {
  supabase: ServerSupabase
  userId: string
  test: StoredPracticeTest
  context: PracticeExamContext
  keyFile: PracticeFile | null
  courseName: string
}): Promise<void> {
  const { supabase, userId, test, context, keyFile, courseName } = params

  const existing = await findPracticeTestMessageId(supabase, test.id)
  if (existing.error) {
    console.error('[practice-test] 查重消息失败（跳过投递）:', existing.error)
    return
  }
  if (existing.messageId !== null) return

  const stats = paperStats(test.paper)
  const details = [
    stats.missing > 0
      ? `${stats.total} 题 · 其中 ${stats.missing} 题没找到答案`
      : `${stats.total} 题 · 答案已隐藏`,
    `试卷：${context.exam.displayName}`,
    keyFile
      ? `答案来自：${keyFile.displayName}`
      : '没找到答案文件 —— 这张卷子只有题目',
  ]

  const created = await createPracticeTestMessage({
    supabase,
    userId,
    practiceTestId: test.id,
    title: `自测卷：${test.title}`,
    details,
    courseId: context.exam.courseId,
    courseName,
    examFileUrl: context.exam.fileUrl,
    paperPath: paperHref({
      courseId: context.exam.courseId,
      examFileId: context.exam.id,
      answerKeyFileId: keyFile?.id ?? null,
    }),
  })
  if (created.error || created.messageId === null) {
    console.error('[practice-test] 投递消息失败（卷子照常可用）:', created.error)
  }
}

/** 落一行确定性失败（= 别再重试）。 */
async function persistFailure(params: {
  params: EnsurePracticeTestParams
  courseName: string
  exam: PracticeFile
  keyFile: PracticeFile | null
  message: string
  examPageCount?: number | null
  extractMethod?: string | null
}): Promise<void> {
  const { supabase } = params.params

  const { error } = await savePracticeTest({
    supabase,
    courseId: params.exam.courseId,
    examFileId: params.exam.id,
    answerKeyFileId: params.keyFile?.id ?? null,
    pairingRule: params.keyFile ? params.params.pairingRule : null,
    title: fallbackTitleFromFileName(params.exam.displayName),
    status: 'failed',
    paper: { title: '', questions: [] },
    examSourceChars: 0,
    keySourceChars: 0,
    sourceTruncated: false,
    examPageCount: params.examPageCount ?? null,
    keyPageCount: null,
    extractMethod: params.extractMethod ?? null,
    // 记下**当时的**文件版本：文件一换就该重试，而不是永远记着旧结论。
    examModifiedAt: params.exam.modifiedAt,
    keyModifiedAt: params.keyFile?.modifiedAt ?? null,
    model: null,
    errorMessage: params.message.slice(0, ERROR_MESSAGE_MAX),
  })

  if (error) {
    console.error('[practice-test] 写入失败标记失败（会导致下次重试）:', error)
  }
}
