import { Suspense } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { examScheduleLabel } from '@/lib/course-update/exam-match'
import { ExamReviewSummary } from '@/components/courses/exam-review/exam-review-summary'
import type { ReviewSourceLink } from '@/components/courses/exam-review/exam-review-summary'
import { PaperEntry } from '@/components/courses/exam-review/paper-entry'
import { ReviewSourceForm } from '@/components/courses/exam-review/review-source-form'
import { AppShell } from '@/components/shell/app-shell'
import { UUID_PATTERN } from '@/lib/api/params'
import { ensureExamReviewSummary } from '@/lib/review/generate'
import { loadExamReviewContext } from '@/lib/review/load'
import type { ExamReviewContext, ReviewFile } from '@/lib/review/load'
import { DEFAULT_REVIEW_LOCALE } from '@/lib/review/locale'
import type { ReviewManifestItem } from '@/lib/review/manifest'
import { paperCandidates, recommendExamFiles } from '@/lib/review/recommend'
import { EXAM_REVIEW_BUCKET } from '@/lib/review/storage'
import { loadExamReviewSummary } from '@/lib/review/store'
import { createClient } from '@/lib/supabase/server'
import { dayKeyToUtcDate, schoolDayKey } from '@/lib/time'

/**
 * 考试复习页（P0-3-31）。
 *
 * 地址：`/courses/:id/exams/:examId/review[?gen=1&files=<id>&files=<id>&extra=<id>]`
 * （`:examId` = `exam_dates.id`）
 *
 * ### 四个要素（本卡的验收①）
 * ① 考试信息（日期 / 倒计时 / syllabus 摘录）
 * ② 按考试名推荐的已索引文件（可勾选）
 * ③ 上传额外文件
 * ④ 生成本次考试总结（合并多份材料，标「AI 总结」+ 每份材料的「原文 ↗」）
 * 外加：挑中 past exam → 走 P0-3-23 出卷（没挑时按钮**不可用**并说明原因，ADR-027 红线）。
 *
 * ### 为什么是"页面 + 查询参数"而不是客户端状态机
 * 同自测卷页（P0-3-23）：这条链要跑「取下载链 → 下载多份 → 抽文本 → 调模型」（实测十几秒），
 * **服务端渲染 + `<Suspense>`** 零客户端 JS、没有"请求发到一半关页面"的半截状态。
 * 勾选也用原生 `<form method="get">` 表达（`?gen=1&files=…`）。
 *
 * ### 🔴 越权在这里被挡两次（与 3-19b / 3-23 同一套）
 * ① `loadExamReviewContext` 走**会话 client + RLS**：别人的 `exam_dates.id` 根本查不到；
 * ② 再校验 `context.exam.courseId === id` —— URL 里的课程与考试真实归属不符时 404。
 * 少了 ②，`/courses/<自己的课>/exams/<别人的考试 id>/review` 会画出"看起来属于这门课"的页面。
 *
 * ### 🔴 归属锚点是考试**身份**（`course_id` + `exam_key`），不是 `exam_dates.id`
 * syllabus 重解析会整体替换 `exam_dates` 行（uuid 全变），按 id 存会让复习数据**静默消失**。
 * 详见迁移 `20260926000000_exam_review.sql` 的文件头。
 */

export const metadata = {
  title: '考试复习 · Tempo',
}

// 依赖用户 session + 每次都可能触发一次生成，绝不能被静态预渲染。
export const dynamic = 'force-dynamic'

interface PageProps {
  // Next 15+ 起是 Promise，必须 await。
  params: Promise<{ id: string; examId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** 取单个查询参数。数组（`?a=1&a=2`）与空串一律当"没给"。 */
function readParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 取**多值**查询参数（勾选框会提交重复的 `files=` / `extra=`）。
 * 去重并丢掉空串 —— 同一个 id 出现两次只当一次。
 */
function readParamList(value: string | string[] | undefined): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export default async function ExamReviewPage({ params, searchParams }: PageProps) {
  const { id, examId } = await params
  const query = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware）已拦过一道，这里再兜一次底。
  if (!user) {
    redirect('/login')
  }

  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(examId)) {
    notFound()
  }

  const { context, error } = await loadExamReviewContext(supabase, examId)

  // 查询失败必须让用户看见，不能降级成「考试不存在」（CodingRules 7）。
  if (error) {
    return (
      <AppShell title="考试复习">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">读取复习数据失败</p>
            <p className="mt-1 text-xs text-ink-muted">{error}</p>
            <p className="mt-2 text-xs text-ink-faint">
              若提示「关系不存在」，多半是迁移还没跑（`20260926000000_exam_review.sql`）。
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

  // 不存在 / 不属于 URL 里那门课 → 一律 404（不区分，避免泄漏"这个 id 存在"）。
  if (!context || context.exam.courseId !== id) {
    notFound()
  }

  const recommended = recommendExamFiles({
    examName: context.exam.examName,
    files: context.files,
  })

  const generating = readParam(query.gen) === '1'
  const selectedFileIds = readParamList(query.files)
  const selectedExtraIds = readParamList(query.extra)

  // 已缓存的那份（只读，不触发生成）—— 没有 `gen=1` 时画它。
  const cache = await loadExamReviewSummary(
    supabase,
    context.exam.courseId,
    context.exam.examKey,
    DEFAULT_REVIEW_LOCALE,
  )

  // 已勾选的文件（只认这门课里确实存在的那一份）。
  const selectedFiles: ReviewFile[] = selectedFileIds
    .map((fileId) => context.files.find((file) => file.id === fileId) ?? null)
    .filter((file): file is ReviewFile => file !== null)

  const hasSelection = selectedFileIds.length > 0 || selectedExtraIds.length > 0
  const candidates = paperCandidates(selectedFiles)

  return (
    <AppShell title="考试复习">
      <div className="mx-auto max-w-3xl space-y-5">
        <Link href={`/courses/${id}`} className="inline-block text-sm text-ink-muted hover:text-ink">
          ← 返回课程
        </Link>

        <ExamInfoCard context={context} />

        {context.exam.examKey === '' ? (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-card p-4">
            <p className="text-sm text-destructive">
              这场考试的名字识别不出来（只有符号或空白），复习内容没法保存。
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              请到课程页「五个板块 → 考试日期」把它改成一个能认出的名字，再回来。
            </p>
          </div>
        ) : (
          <>
            <ReviewSourceForm
              courseId={id}
              examId={context.exam.id}
              recommended={recommended}
              extras={context.extras}
              selectedFileIds={selectedFileIds}
              selectedExtraIds={selectedExtraIds}
            />

            <PaperEntry courseId={id} candidates={candidates} hasSelection={hasSelection} />

            {generating ? (
              <Suspense fallback={<GeneratingCard />}>
                <SummaryBody
                  supabase={supabase}
                  userId={user.id}
                  context={context}
                  selectedFileIds={selectedFileIds}
                  selectedExtraIds={selectedExtraIds}
                />
              </Suspense>
            ) : (
              <CachedSummary
                supabase={supabase}
                context={context}
                cache={cache.summary}
                cacheError={cache.error}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

/**
 * 考试信息卡（要素①）：名称 / 日期时间地点 / 倒计时 / syllabus 原文摘录。
 *
 * 倒计时按**学校本地日历日**算（`lib/time.ts`），不在客户端各算一遍 —— 否则
 * 服务端（UTC）与浏览器（用户时区）会不一致，跨零点时"还有 1 天"会闪成"就是今天"。
 */
function ExamInfoCard({ context }: { context: ExamReviewContext }) {
  const { exam, courseName } = context
  const days = countdownDays(exam.examDate)

  const countdown =
    days === null
      ? '日期待定'
      : days === 0
        ? '就是今天'
        : days > 0
          ? `还有 ${days} 天`
          : `已过去 ${-days} 天`

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-exam-review-info>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight break-words">{exam.examName}</h1>
          <p className="mt-1 text-sm text-ink-muted">{courseName}</p>
          <p className="mt-0.5 text-xs text-ink-faint">
            {examScheduleLabel({
              examDate: exam.examDate,
              examTime: exam.examTime,
              location: exam.location,
            })}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-medium text-foreground">{countdown}</p>
          {exam.status === 'tbd' ? (
            <p className="mt-0.5 text-[11px] text-ink-faint">日期还没定</p>
          ) : null}
        </div>
      </div>

      {exam.sourceExcerpt ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink">
            查看 syllabus 原文摘录
          </summary>
          <p className="mt-2 rounded-md border border-border bg-muted/40 p-2 text-xs leading-relaxed whitespace-pre-wrap text-ink-muted">
            {exam.sourceExcerpt}
          </p>
        </details>
      ) : null}
    </section>
  )
}

/** 距考试还有几天（按学校本地日历日）。`examDate` 为空返回 null。 */
function countdownDays(examDate: string | null): number | null {
  if (examDate === null) return null
  const today = dayKeyToUtcDate(schoolDayKey(new Date()))
  const target = dayKeyToUtcDate(examDate)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

/**
 * 生成过程（十几秒）。骨架先占位，生成完由流式替换。
 * 写清"在干什么"与"要多久"，否则十几秒的空白会被读成卡住。
 */
function GeneratingCard() {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-exam-review-summary>
      <h2 className="text-sm font-medium text-foreground">正在生成复习总结…</h2>
      <p className="mt-3 text-sm text-ink-muted">
        正在依次读你勾选的材料，把每份的要点提炼出来、再合成这场考试的复习提要。
      </p>
      <p className="mt-2 text-xs text-ink-faint">
        依次是：取 Canvas 下载链 → 抽取文字 → 合并总结。第一次大约十几秒，之后会走缓存。
      </p>
    </section>
  )
}

/** 给「上传件」现签短时下载链接（`manifest.url` 对 extra 恒为 null，见 `lib/review/manifest.ts`）。 */
async function signExtraUrls(
  supabase: Awaited<ReturnType<typeof createClient>>,
  context: ExamReviewContext,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const extra of context.extras) {
    const { data } = await supabase.storage
      .from(EXAM_REVIEW_BUCKET)
      .createSignedUrl(extra.storagePath, 3600)
    if (data?.signedUrl) map.set(extra.id, data.signedUrl)
  }
  return map
}

/** 清单 → 展示用链接列表（每份材料一个「原文 ↗」目标）。 */
function toSourceLinks(
  manifest: readonly ReviewManifestItem[],
  signed: Map<string, string>,
): ReviewSourceLink[] {
  return manifest.map((item) => ({
    ref: item.ref,
    label: item.label,
    kind: item.kind,
    href: item.kind === 'file' ? item.url : (signed.get(item.id) ?? null),
  }))
}

/** 没有 `gen=1` 时：画已缓存的那份（如果有）。 */
async function CachedSummary({
  supabase,
  context,
  cache,
  cacheError,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>
  context: ExamReviewContext
  cache: Awaited<ReturnType<typeof loadExamReviewSummary>>['summary']
  cacheError: string | null
}) {
  if (cacheError) {
    return (
      <Card>
        <p role="alert" className="text-sm text-destructive">
          读取复习缓存失败：{cacheError}
        </p>
      </Card>
    )
  }

  if (!cache) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          还没有生成这场考试的复习总结。勾选上面要复习的资料，点「生成复习总结」。
        </p>
      </Card>
    )
  }

  if (cache.status === 'failed') {
    return (
      <Card>
        <p role="alert" className="text-sm text-destructive">
          上次生成没成功：{cache.errorMessage ?? '原因未知'}
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          这份结论会被记住、不再重复尝试。改一下勾选（多勾/少勾一份）再点生成即可重来。
        </p>
      </Card>
    )
  }

  const signed = await signExtraUrls(supabase, context)
  return (
    <ExamReviewSummary
      payload={cache.payload}
      sources={toSourceLinks(cache.manifest, signed)}
      model={cache.model}
      note="（已缓存 —— 勾选不变时不会重新生成）"
    />
  )
}

/** 有 `gen=1` 时：真跑一次（命中缓存就秒回）。 */
async function SummaryBody({
  supabase,
  userId,
  context,
  selectedFileIds,
  selectedExtraIds,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  context: ExamReviewContext
  selectedFileIds: readonly string[]
  selectedExtraIds: readonly string[]
}) {
  const outcome = await ensureExamReviewSummary({
    supabase,
    userId,
    context,
    fileIds: selectedFileIds,
    extraIds: selectedExtraIds,
    locale: DEFAULT_REVIEW_LOCALE,
  })

  if (outcome.status === 'empty') {
    return (
      <Card>
        <p className="text-sm text-ink-muted">{outcome.message}</p>
      </Card>
    )
  }

  if (outcome.status === 'unsupported') {
    return (
      <Card>
        <p className="text-sm text-ink-muted">{outcome.message}</p>
        <Notes notes={outcome.notes} />
        <p className="mt-2 text-xs text-ink-faint">
          这不是错误 —— 只是这些类型不在 Tempo 的能力范围里。文件本身照常可以在 Canvas 上打开。
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
          刷新本页会重新尝试；如果是「材料读不出内容」这类结论，则会被记住、不再重复尝试
          （要强制重来就改一下勾选）。
        </p>
      </Card>
    )
  }

  const signed = await signExtraUrls(supabase, context)
  return (
    <div className="space-y-4">
      <Notes notes={outcome.notes} />
      <ExamReviewSummary
        payload={outcome.review.payload}
        sources={toSourceLinks(outcome.review.manifest, signed)}
        model={outcome.review.model}
        note={outcome.cached ? '（本次直接读了上次的结果，没有重新生成）' : '（刚生成）'}
      />
      {outcome.review.sourceTruncated ? (
        <p className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-ink-muted">
          ⚠️ 这些材料合计太长，本次总结只用了前面一部分文字 —— 上面的要点不覆盖全部内容。
        </p>
      ) : null}
    </div>
  )
}

/** 这次没纳入的材料（确定性读不了的那些）—— 必须说出来，不能让它们静默消失。 */
function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null
  return (
    <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2">
      {notes.map((note, index) => (
        <p key={index} className="text-xs text-ink-muted">
          ⚠️ {note}
        </p>
      ))}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-exam-review-summary>
      {children}
    </section>
  )
}
