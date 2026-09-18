import { Suspense } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { FileSummary } from '@/components/courses/file-summary'
import { AppShell } from '@/components/shell/app-shell'
import { UUID_PATTERN } from '@/lib/api/params'
import { formatFileSize } from '@/lib/course-files/grouping'
import { DEFAULT_SUMMARY_LOCALE } from '@/lib/course-files/summary/locale'
import { ensureFileSummary, loadSummaryTarget } from '@/lib/course-files/summary/generate'
import { createClient } from '@/lib/supabase/server'

import type { SummaryTarget } from '@/lib/course-files/summary/generate'

/**
 * 单份资料的「一键总结」页（P0-3-19b）。
 *
 * ### 它是**新开一个 tab** 打开的，不是原地弹窗
 * Steven 2026-09-18 的原话是「一点这个按钮该文件就会被总结，生成一个新的 HTML 跳转到新页面」。
 * 新开 tab 的好处很实在：课程页的资料列表还在原来那一屏，用户可以连着点好几份材料，
 * 而不必每看一份就退回去一次。
 *
 * ### 生成发生在**渲染时**，用 `<Suspense>` 把等待藏起来
 * 这条链路要跑「取下载链 → 下载 → 抽文本 → 调模型」，实测 3-15 秒。
 * 若整页等它，用户会盯着白屏；所以：
 * 先把标题、文件信息、原文链接**立刻**画出来（在 Suspense 外，只查一行主键），
 * 再把生成过程放进 `<Suspense>`，由一个骨架卡片占位。
 * 这样"点开就有反应"，而总结像流式一样补上来 —— 且**零客户端 JS**。
 *
 * ### 🔴 为什么不做成客户端触发的 API（像公告要点那样）
 * 公告要点是"打开消息栏时顺手补 3 条"，触发者是一个已经在页面上的人，
 * 需要一个**能被放弃**的后台请求。这里是"用户为这一份材料专程点进来"，
 * 页面本身就是等待语义 —— 用 Suspense 更直接，也少一套 route + client 组件。
 * 代价是 Vercel 函数要撑住这十几秒（与 `POST /api/v1/syllabi/:id/extract` 同级）。
 *
 * ### 🔴 越权在这里被挡两次
 * ① `loadSummaryTarget` 走**会话 client + RLS**：别人的 `course_files.id` 根本查不到；
 * ② 再校验 `target.courseId === id` —— URL 里的课程与文件真实归属不符时 404。
 * 少了 ②，`/courses/<自己的课>/files/<别人的文件>` 这种拼出来的 URL 会画出一份
 * "看起来属于这门课"的总结（`course_files` 的 RLS 只保证文件是自己的，
 * 不保证它属于 URL 里那门课）。
 */

export const metadata = {
  title: '资料总结 · Tempo',
}

// 依赖用户 session + 每次都可能触发一次生成，绝不能被静态预渲染。
export const dynamic = 'force-dynamic'

interface PageProps {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string; fileId: string }>
}

export default async function FileSummaryPage({ params }: PageProps) {
  const { id, fileId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware）已拦过一道，这里再兜一次底。
  if (!user) {
    redirect('/login')
  }

  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(fileId)) {
    notFound()
  }

  const { target, error } = await loadSummaryTarget(supabase, fileId)

  // 查询失败必须让用户看见，不能降级成「文件不存在」（CodingRules 7）。
  if (error) {
    return (
      <AppShell title="资料总结">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">读取文件信息失败</p>
            <p className="mt-1 text-xs text-ink-muted">{error}</p>
            <p className="mt-2 text-xs text-ink-faint">
              若提示「关系不存在」，多半是迁移还没跑（`20260922000000_file_summaries.sql`）。
            </p>
          </div>
        </div>
      </AppShell>
    )
  }

  // 文件不存在 / 不属于 URL 里那门课 → 一律 404（不区分，避免泄漏"这个 id 存在"）。
  if (!target || target.courseId !== id) {
    notFound()
  }

  return (
    <AppShell title="资料总结">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link href={`/courses/${id}`} className="inline-block text-sm text-ink-muted hover:text-ink">
          ← 返回课程
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight break-words">{target.displayName}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {[target.courseName, target.folderPath === '' ? '课程文件' : target.folderPath]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {formatFileSize(target.sizeBytes) ?? '大小未知'}
            </p>
          </div>

          {/* 🔴 「原文 ↗」必须在 —— 总结是模型说的，材料本身在 Canvas 上（ADR-024 同一条纪律）。 */}
          <a
            href={target.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            原文 ↗
          </a>
        </div>

        <Suspense fallback={<GeneratingCard />}>
          <SummaryBody supabase={supabase} userId={user.id} target={target} />
        </Suspense>
      </div>
    </AppShell>
  )
}

/** 生成过程（可能十几秒）。骨架卡片先占位，生成完由流式替换。 */
async function SummaryBody({
  supabase,
  userId,
  target,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  target: SummaryTarget
}) {
  const outcome = await ensureFileSummary({
    supabase,
    userId,
    courseFileId: target.id,
    locale: DEFAULT_SUMMARY_LOCALE,
    // 页面刚查过一次，直接复用，省一次主键查询。
    target,
  })

  return <FileSummary outcome={outcome} />
}

/** 等待占位。写清"在干什么"，否则十几秒的空白会被读成卡住。 */
function GeneratingCard() {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-file-summary>
      <h2 className="text-sm font-medium text-foreground">AI 总结</h2>
      <p className="mt-3 text-sm text-ink-muted">正在读这份材料…</p>
      <p className="mt-2 text-xs text-ink-faint">
        依次是：取 Canvas 下载链 → 抽取文字 → 生成要点。第一次大约需要十几秒，之后会走缓存。
      </p>
    </section>
  )
}
