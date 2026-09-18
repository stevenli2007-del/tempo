import { withExplain } from '@/lib/practice-test/paper'
import type { PracticePaper as Paper } from '@/lib/practice-test/paper'

/**
 * 自测卷的卷面渲染（P0-3-23）。
 *
 * ### 三种"没有答案"必须长得**不一样**（本卡最容易做错的地方）
 * | 情况 | 画法 |
 * |---|---|
 * | 有答案 | 「看答案」折叠块，默认收起 |
 * | 这一题在答案文件里没找到 | 明说「这一题没找到答案」—— 不许画成空白让人以为答案在后面 |
 * | 整张卷子没配到答案文件 | 顶部一行说清（由页面传 `provenance`），逐题再标一次 |
 *
 * CodingRules 7：静默的空画面会被读成"答案就是空的"。所以**任何一个空位都必须有一句话**。
 *
 * ### 答案默认收起是**自测纪律**，不是权限
 * 答案本来就在 `paper` 里（同一份数据），`<details>` 只是不主动摊开。
 * 诚实说明：用户想要一份"服务端不给我答案"的卷子是做不到的 —— 因为答案就来自
 * **他自己选的那份 answer key**。所以界面上不写"答案已加密"之类的话。
 *
 * ### 🔴 这是个**纯展示**组件（不许加 `"use client"`、不许 import 服务端模块）
 * 它有两个调用方，而且第二个还没写：
 * ① 自测卷页（服务端，T23 本卡）；
 * ② 消息栏里就地展开的那张卷（P23 收尾 commit 接上，那是一条客户端组件链）。
 * 第二条路正是 3-25 栽过的坑（`next/headers` 被拖进客户端图 → `next build` 直接红），
 * 所以这里的 props **全是纯数据与字符串**：不接函数（函数跨不过 RSC 边界）、
 * 不接 `Map`（不可序列化），也不接 supabase client。
 */
export type ExplanationView = {
  status: 'ok' | 'failed'
  steps: string[]
  concepts: string[]
  /** 失败原因（`status='failed'` 时画出来，不静默）。 */
  message: string | null
}

export function PracticePaperView({
  paper,
  explanations,
  explainHrefBase,
  truncatedNote = null,
  provenance = null,
}: {
  paper: Paper
  /** 每题的讲解，键 = `questionKey`（`q1` / `q2` …）。 */
  explanations: Record<string, ExplanationView>
  /**
   * 「讲解这道题的解法」要跳去的地址（`paperHref(...)` 的结果，已带 `exam` / `key`）。
   * `null` = 不画讲解入口（消息栏里那份只读卷面就是这么用的 —— 讲解需要一次模型调用，
   * 而消息栏不该因为展开一张卷子就花钱）。
   */
  explainHrefBase: string | null
  /** 覆盖不全时的提示（试卷/答案文字被截断）。 */
  truncatedNote?: string | null
  /** 来源说明（试卷是谁、答案来自哪一份）。 */
  provenance?: { examLabel: string; keyLabel: string | null } | null
}) {
  const total = paper.questions.length
  const missing = paper.questions.filter((question) => question.answer === null).length

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-practice-paper>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">
          {paper.title === '' ? '自测卷' : paper.title}
        </h2>
        <p className="text-xs text-ink-faint">
          {total} 题
          {missing > 0 ? ` · ${missing} 题没找到答案` : ' · 答案已收起'}
        </p>
      </div>

      {provenance && (
        <p className="mt-1 text-xs text-ink-faint">
          试卷：{provenance.examLabel}
          {provenance.keyLabel === null
            ? ' · 没找到答案文件，这张卷子只有题目'
            : ` · 答案来自：${provenance.keyLabel}`}
        </p>
      )}

      {truncatedNote && (
        <p className="mt-3 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-ink-muted">
          ⚠️ {truncatedNote}
        </p>
      )}

      <ol className="mt-4 space-y-4">
        {paper.questions.map((question) => (
          <QuestionItem
            key={question.key}
            question={question}
            explanation={explanations[question.key]}
            explainHrefBase={explainHrefBase}
          />
        ))}
      </ol>

      <p className="mt-5 border-t border-border pt-3 text-xs text-ink-faint">
        题目与答案都来自你自己选的那两份文件（题干照抄、答案只从答案文件里取）。
        联系不到答案的题会明确标出来，<strong className="font-medium">不会替你算一个</strong>。
      </p>
    </section>
  )
}

function QuestionItem({
  question,
  explanation,
  explainHrefBase,
}: {
  question: Paper['questions'][number]
  explanation: ExplanationView | undefined
  explainHrefBase: string | null
}) {
  return (
    // `id` 是锚点：生成讲解要整页重渲染，没有它用户点完「讲解」会被丢回页面顶部。
    <li id={question.key} className="scroll-mt-20 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex gap-2.5">
        <span className="mt-0.5 shrink-0 rounded-md bg-muted/40 px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink-muted">
          {question.number}
        </span>
        <div className="min-w-0 flex-1">
          {/* 题干照原文（含换行），用 `whitespace-pre-wrap` 保留它自己的排版。 */}
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
            {question.text}
          </p>

          <div className="mt-2">
            {question.answer !== null ? (
              // 默认收起 = 自测纪律（见文件头）。原生 `<details>`：零客户端 JS。
              <details className="rounded-lg border border-border bg-muted/20">
                <summary className="cursor-pointer px-3 py-1.5 text-xs text-ink-muted hover:text-ink">
                  看答案
                </summary>
                <p className="border-t border-border px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                  {question.answer}
                </p>
              </details>
            ) : (
              <p className="text-xs text-ink-faint">
                这一题没找到答案（答案文件里没有这一题）—— 不要把它当成「答案是空的」。
              </p>
            )}
          </div>

          <ExplanationBlock
            explanation={explanation}
            explainHrefBase={explainHrefBase}
            questionKey={question.key}
          />
        </div>
      </div>
    </li>
  )
}

/**
 * 讲解块。
 *
 * 🔴 **必须标「AI 讲解」**（沿用 ADR-024 对公告要点、3-19b 对课件的同一套纪律）：
 * 讲解是模型讲的，不是老师的解法。不标的话用户会把一份 AI 的推理当成官方解答。
 * 答案本身（上面的「看答案」）是**官方原文**，两者不能长得一样。
 *
 * ⚠️ 这里**没有"生成中"这一态**：讲解是整页生成后才渲染的（见页面的文件头），
 * 等待由页面的 `<Suspense>` 顶着。硬加一个永远走不到的 loading 分支，
 * 下次读代码的人会以为它有用。
 */
function ExplanationBlock({
  explanation,
  explainHrefBase,
  questionKey,
}: {
  explanation: ExplanationView | undefined
  explainHrefBase: string | null
  questionKey: string
}) {
  if (explanation?.status === 'failed') {
    return (
      <p role="alert" className="mt-2 text-xs text-destructive">
        {explanation.message ?? '这一题没能讲出来。'}
      </p>
    )
  }

  if (explanation && explanation.status === 'ok') {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-ink-faint">AI 讲解 · 由模型依据题干与答案推导，可能出错</p>
        {explanation.steps.length > 0 && (
          <ol className="mt-1.5 space-y-1">
            {explanation.steps.map((step, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
                <span className="shrink-0 tabular-nums text-ink-faint">{index + 1}.</span>
                <span className="min-w-0 flex-1">{step}</span>
              </li>
            ))}
          </ol>
        )}
        {explanation.concepts.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {explanation.concepts.map((concept, index) => (
              <li
                key={index}
                className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-ink-muted"
              >
                {concept}
              </li>
            ))}
          </ul>
        )}
        {explanation.steps.length === 0 && explanation.concepts.length === 0 && (
          <p className="mt-1 text-xs text-ink-muted">模型认为这一题没有可讲的步骤。</p>
        )}
      </div>
    )
  }

  if (explainHrefBase === null) return null

  return (
    <a
      href={withExplain(explainHrefBase, questionKey)}
      className="mt-2 inline-block rounded-md border border-border px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      讲解这道题的解法
    </a>
  )
}
