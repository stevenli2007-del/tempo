import { Suspense } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { PracticePaperView } from '@/components/courses/practice-paper'
import type { ExplanationView } from '@/components/courses/practice-paper'
import { AppShell } from '@/components/shell/app-shell'
import { UUID_PATTERN } from '@/lib/api/params'
import { formatFileSize } from '@/lib/course-files/grouping'
import { DEFAULT_SUMMARY_LOCALE } from '@/lib/course-files/summary/locale'
import { ensureExplanation } from '@/lib/practice-test/explanations'
import { loadPracticeExamContext, resolveKeyChoice } from '@/lib/practice-test/files'
import type { KeyChoice, PracticeExamContext } from '@/lib/practice-test/files'
import { ensurePracticeTest } from '@/lib/practice-test/generate'
import { PAIRING_RULE_LABELS, isExamLike } from '@/lib/practice-test/pairing'
import { paperHref, questionIndex } from '@/lib/practice-test/paper'
import { loadExplanations } from '@/lib/practice-test/store'
import { createClient } from '@/lib/supabase/server'

/**
 * 自测卷页（P0-3-23）。
 *
 * 地址：`/courses/:id/practice-tests/new?exam=<courseFileId>[&key=<courseFileId>][&explain=q3]`
 *
 * ### 为什么是"页面 + 查询参数"而不是一个客户端状态机
 * 这条链路要跑「取下载链 → 下载两份 → 抽文本 → 调模型切题」（实测十几秒），
 * 而 3-19b 的一键总结已经证明**服务端渲染 + `<Suspense>`** 是这条链最省事、
 * 最不容易出错的形态：**零客户端 JS**、没有"请求发到一半用户关页面"的半截状态、
 * 也不需要在浏览器里维护一套 loading/error/data 三态。
 *
 * ### 「讲解这道题的解法」= 同一个页面 + `?explain=q3`（**刻意不做客户端按钮**）
 * 讲解是**逐题懒生成**的（点哪题算哪题），用查询参数表达这件事有几个实在的好处：
 * ① 讲解跟着 URL 走 —— 刷新、分享、回退都不会丢，而客户端 state 一刷新就没了；
 * ② 生成完把锚点带到那一题（`#q3`），用户不会被丢回页面顶部；
 * ③ 少一个 API 端点 + 一套客户端状态机，少两类"按钮转圈但没反应"的失败。
 * 代价是每次点讲解整页重渲染（有缓存后只有一次模型调用的等待）—— 这个取舍是**有意的**。
 *
 * ### 🔴 越权在这里被挡两次（与 3-19b 同一套）
 * ① `loadPracticeExamContext` 走**会话 client + RLS**：别人的 `course_files.id` 根本查不到；
 * ② 再校验 `exam.courseId === id` —— URL 里的课程与文件真实归属不符时 404。
 * 少了 ②，`/courses/<自己的课>/practice-tests/new?exam=<别人的文件>` 这种拼出来的 URL
 * 会画出一份"看起来属于这门课"的卷子。
 *
 * ### 🔴 答案文件的 id 只从候选池里认（`resolveKeyChoice`）
 * `?key=` 来自客户端。不接受"任意 id"，只接受**这门课资料里确实存在的那一份** ——
 * 一次判定同时回答"是不是你的"与"有没有这一份"。
 */

export const metadata = {
  title: '自测卷 · Tempo',
}

// 依赖用户 session + 每次都可能触发一次生成，绝不能被静态预渲染。
export const dynamic = 'force-dynamic'

interface PageProps {
  // Next 15+ 起是 Promise，必须 await。
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** 取单个查询参数。数组（`?a=1&a=2`）与空串一律当"没给"—— 不猜用户想要哪个。 */
function readParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export default async function PracticeTestPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware）已拦过一道，这里再兜一次底。
  if (!user) {
    redirect('/login')
  }

  if (!UUID_PATTERN.test(id)) {
    notFound()
  }

  const examFileId = readParam(query.exam)
  const rawKeyFileId = readParam(query.key)
  const rawExplain = readParam(query.explain)

  // 参数坏了要说出来，不能静默降级 —— 静默的结果是"我选的答案没生效"或
  // "点了讲解没反应"，而用户无从知道是参数问题。
  const warnings: string[] = []
  let explicitKeyFileId: string | null = null
  if (rawKeyFileId !== null) {
    if (UUID_PATTERN.test(rawKeyFileId)) explicitKeyFileId = rawKeyFileId
    else warnings.push('答案文件参数（key）格式不对，已按自动配对处理。')
  }
  let explainKey: string | null = null
  if (rawExplain !== null) {
    if (questionIndex(rawExplain) !== null) explainKey = rawExplain
    else warnings.push('讲解参数（explain）格式不对，已忽略。')
  }

  if (examFileId === null || !UUID_PATTERN.test(examFileId)) {
    return (
      <AppShell title="自测卷">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">没有指定要出卷的试卷</p>
            <p className="mt-1 text-xs text-ink-muted">
              自测卷的入口在课程页的「资料」区：找到那份 past exam，点它那一行的「自测卷」。
            </p>
            <Link
              href={`/courses/${id}`}
              className="mt-3 inline-block text-sm text-ink-muted hover:text-ink"
            >
              ← 返回课程
            </Link>
          </div>
        </div>
      </AppShell>
    )
  }

  const { context, error } = await loadPracticeExamContext(supabase, examFileId)

  // 查询失败必须让用户看见，不能降级成「文件不存在」（CodingRules 7）。
  if (error) {
    return (
      <AppShell title="自测卷">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">读取文件信息失败</p>
            <p className="mt-1 text-xs text-ink-muted">{error}</p>
            <p className="mt-2 text-xs text-ink-faint">
              若提示「关系不存在」，多半是迁移还没跑（`20260924000000_practice_tests.sql`）。
            </p>
            <Link
              href={`/courses/${id}`}
              className="mt-3 inline-block text-sm text-ink-muted hover:text-ink"
            >
              ← 返回课程
            </Link>
          </div>
        </div>
      </AppShell>
    )
  }

  // 文件不存在 / 不属于 URL 里那门课 → 一律 404（不区分，避免泄漏"这个 id 存在"）。
  if (!context || context.exam.courseId !== id) {
    notFound()
  }

  const choice = resolveKeyChoice({
    exam: context.exam,
    siblings: context.siblings,
    explicitKeyFileId,
  })

  const explainHrefBase = paperHref({
    courseId: id,
    examFileId: context.exam.id,
    answerKeyFileId: choice.key?.id ?? null,
  })

  return (
    <AppShell title="自测卷">
      <div className="mx-auto max-w-3xl space-y-5">
        <Link href={`/courses/${id}`} className="inline-block text-sm text-ink-muted hover:text-ink">
          ← 返回课程
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight break-words">
              {context.exam.displayName}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              {[
                context.courseName,
                context.exam.folderPath === '' ? '课程文件' : context.exam.folderPath,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {formatFileSize(context.exam.sizeBytes) ?? '大小未知'}
            </p>
          </div>

          {/* 🔴 「原文 ↗」必须在 —— 卷子是 Tempo 造的，试卷本人在 Canvas 上。 */}
          <a
            href={context.exam.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            原文 ↗
          </a>
        </div>

        <KeyCard context={context} choice={choice} examFileId={context.exam.id} />

        {warnings.length > 0 && (
          <div role="alert" className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2">
            {warnings.map((warning, index) => (
              <p key={index} className="text-xs text-ink-muted">
                ⚠️ {warning}
              </p>
            ))}
          </div>
        )}

        <Suspense fallback={<GeneratingCard />}>
          <PaperBody
            supabase={supabase}
            userId={user.id}
            courseId={id}
            context={context}
            choice={choice}
            explainKey={explainKey}
            explainHrefBase={explainHrefBase}
          />
        </Suspense>
      </div>
    </AppShell>
  )
}

/**
 * 「答案来自哪一份」的卡片 —— **在任何生成之前就画出来**。
 *
 * 为什么要它：配对是启发式，可能配错。把"我认为答案是这一份"摊在明面上，
 * 用户一眼就能发现不对并换一份；藏起来的话他看到一张答案全错的卷子，
 * 却以为是 Tempo 算错了。**看得见的错误可以纠正，看不见的错误会变成不信任。**
 */
function KeyCard({
  context,
  choice,
  examFileId,
}: {
  context: PracticeExamContext
  choice: KeyChoice
  examFileId: string
}) {
  const others = choice.ranked.filter((entry) => entry.file.id !== choice.key?.id)

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm" data-practice-key>
      {choice.explicitNotFound && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          你指定的那份答案文件不在这门课的资料里（可能已被删除），下面用的是自动配对的结果。
        </p>
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="text-ink-faint">答案来自</span>
        {choice.key === null ? (
          <span className="text-ink-muted">
            没找到与这份试卷配对的答案文件 —— 这张卷子只有题目
          </span>
        ) : (
          <>
            <a
              href={choice.key.fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline decoration-dotted underline-offset-2 hover:text-ink-muted"
            >
              {choice.key.displayName}
            </a>
            <span className="text-xs text-ink-faint">
              {choice.key.folderPath === '' ? '课程文件' : choice.key.folderPath}
            </span>
          </>
        )}
      </div>

      {choice.key !== null && choice.rule !== null && (
        <p className="mt-1 text-xs text-ink-faint">
          配对依据：{PAIRING_RULE_LABELS[choice.rule]}（在这门课的 {choice.considered} 份文件里比的）
        </p>
      )}

      {/* 换一份：只在真有备选时出现。候选是按"去掉 KEY 后同名"筛出来的，不是全部文件 */}
      {others.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink">
            换一个答案文件（{others.length} 个候选）
          </summary>
          <ul className="mt-2 space-y-1">
            {/* 不带 `key` 参数 = 回到自动配对。用户点它是想说"我配错了，按你的来"。 */}
            <li>
              <Link
                href={paperHref({ courseId: context.exam.courseId, examFileId })}
                className="text-xs text-ink-muted hover:text-ink"
              >
                用自动配对的那一份（不指定）
              </Link>
            </li>
            {others.map((entry) => (
              <li key={entry.file.id} className="flex items-baseline gap-2">
                <Link
                  href={paperHref({
                    courseId: context.exam.courseId,
                    examFileId,
                    answerKeyFileId: entry.file.id,
                  })}
                  className="min-w-0 flex-1 truncate text-xs text-ink-muted hover:text-ink"
                >
                  {entry.file.displayName}
                </Link>
                <span className="shrink-0 text-[11px] text-ink-faint">
                  {entry.file.folderPath === '' ? '课程文件' : entry.file.folderPath}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {choice.key === null && choice.ranked.length === 0 && (
        <p className="mt-2 text-xs text-ink-faint">
          没找到候选的原因通常是老师把答案文件和试卷分开放在别的课/别的目录里，
          或者答案文件名与试卷名对不上。
        </p>
      )}
    </section>
  )
}

/**
 * 生成过程（十几秒）。骨架先占位，生成完由流式替换。
 * 写清"在干什么"与"要多久"，否则十几秒的空白会被读成卡住。
 */
function GeneratingCard() {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-practice-paper>
      <h2 className="text-sm font-medium text-foreground">正在出卷…</h2>
      <p className="mt-3 text-sm text-ink-muted">正在读试卷（和答案文件），把题目一道一道切出来。</p>
      <p className="mt-2 text-xs text-ink-faint">
        依次是：取 Canvas 下载链 → 抽取文字 → 切题并配答案。第一次大约十几秒，之后会走缓存。
      </p>
    </section>
  )
}

/** 真正干活的这一段放在 `<Suspense>` 里，等它的时候骨架卡片顶着版面。 */
async function PaperBody({
  supabase,
  userId,
  courseId,
  context,
  choice,
  explainKey,
  explainHrefBase,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  courseId: string
  context: PracticeExamContext
  choice: KeyChoice
  explainKey: string | null
  explainHrefBase: string
}) {
  const outcome = await ensurePracticeTest({
    supabase,
    userId,
    context,
    answerKeyFileId: choice.key?.id ?? null,
    pairingRule: choice.rule,
  })

  if (outcome.status === 'unsupported') {
    return (
      <Card>
        <p className="text-sm text-ink-muted">{outcome.message}</p>
        <p className="mt-2 text-xs text-ink-faint">
          这不是错误 —— 只是这个类型不在本卡的能力范围里。试卷本身照常可以在 Canvas 上打开。
        </p>
      </Card>
    )
  }

  if (outcome.status === 'failed') {
    return (
      <Card>
        <p role="alert" className="text-sm text-destructive">
          {outcome.message}
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          刷新本页会重新尝试；如果是「读不出文字」这类结论，则会被记住、不再重复尝试
          （要强制重来就先改一下答案文件的选择）。
        </p>
      </Card>
    )
  }

  const test = outcome.test

  // 已经算好的讲解（一次查完）。逐题查会让打开慢 N 倍，且任何一题查询失败都会闪一下。
  const { byKey, error: explanationsError } = await loadExplanations(
    supabase,
    test.id,
    DEFAULT_SUMMARY_LOCALE,
  )
  const explanations: Record<string, ExplanationView> = {}
  for (const [key, stored] of byKey) {
    explanations[key] =
      stored.status === 'failed'
        ? { status: 'failed', steps: [], concepts: [], message: stored.errorMessage }
        : {
            status: 'ok',
            steps: stored.explanation.steps,
            concepts: stored.explanation.concepts,
            message: null,
          }
  }

  // 用户点的那一题：现场生成（命中缓存就秒回，不花钱）。
  if (explainKey !== null) {
    const generated = await ensureExplanation({
      supabase,
      userId,
      practiceTestId: test.id,
      courseName: context.courseName,
      paper: test.paper,
      questionKey: explainKey,
    })
    explanations[explainKey] =
      generated.status === 'ready'
        ? {
            status: 'ok',
            steps: generated.explanation.steps,
            concepts: generated.explanation.concepts,
            message: null,
          }
        : { status: 'failed', steps: [], concepts: [], message: generated.message }
  }

  const notes: string[] = []
  if (explanationsError) {
    notes.push(`讲解缓存读不出来（${explanationsError}）—— 已有讲解这次不显示，但不影响卷子。`)
  }
  if (!isExamLike(context.exam)) {
    // 不拦：文件可能取了个怪名字。但**如实提示**，否则"切不出题目"会看起来像我们的 bug。
    notes.push(
      '这份文件的文件名与位置里没有 exam / quiz / midterm 这类词，可能不是一份试卷 —— 如果切不出题目，请换一份。',
    )
  }
  if (outcome.cached === false) {
    notes.push('这张卷子刚生成好 —— 结果也会出现在消息栏里。')
  }

  return (
    <div className="space-y-4">
      {notes.map((note, index) => (
        <p key={index} className="text-xs text-ink-faint">
          {note}
        </p>
      ))}

      <PracticePaperView
        paper={test.paper}
        explanations={explanations}
        explainHrefBase={explainHrefBase}
        truncatedNote={
          test.sourceTruncated
            ? '试卷或答案文件太长，本次只用了前面一部分文字 —— 下面的题目不覆盖全篇。'
            : null
        }
        provenance={{
          examLabel: context.exam.displayName,
          keyLabel: choice.key?.displayName ?? null,
        }}
      />

      <p className="text-xs text-ink-faint">
        {/* 留一条明确的回头路：用户在卷子上做完题，多半要回去看作业与考试。 */}
        <Link href={`/courses/${courseId}`} className="text-ink-muted hover:text-ink">
          返回这门课
        </Link>
        ，或到消息栏确认这张卷子。
      </p>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-practice-paper>
      {children}
    </section>
  )
}
