import type { SummaryOutcome } from '@/lib/course-files/summary/generate'

/**
 * 单文件「一键总结」的渲染（P0-3-19b）。
 *
 * ### 三种状态是**三种画面**，不是"有内容 / 没内容"
 * - `ready`：概述 + 要点 + 公式术语（+ 覆盖说明）
 * - `unsupported`：Tempo 读不了这个类型 —— **明确说是"我们不做"**，不许说得像"这份材料是空的"
 * - `failed`：真的失败了，把原因（人话）画出来，并给一条"再试一次"的路
 *
 * CodingRules 7：静默的空画面会被读成"这份材料没内容"。所以任何"没有要点"的情况
 * 都必须是**一句话解释**，不能是一片空白。
 *
 * ### 🔴 三条不能省的诚实标记（沿用 ADR-024 对公告要点的同一套纪律）
 * 1. 标题必须写「AI 总结」—— 这是模型说的，不是老师说的；
 * 2. 「原文 ↗」必须一直在（右上角，由页面负责）—— 别让用户把总结当成材料的全部；
 * 3. **汇总覆盖不全时必须标出来**（`sourceTruncated`）——
 *    只总结了前 24,000 字却假装概括了整份讲义，就是"计数撒谎"。
 */

export function FileSummary({ outcome }: { outcome: SummaryOutcome }) {
  if (outcome.status === 'unsupported') {
    return (
      <Card>
        <Labelled />
        <p className="mt-3 text-sm text-ink-muted">{outcome.message}</p>
        <p className="mt-2 text-xs text-ink-faint">
          这不是错误 —— 只是这个类型不在 Tempo 的能力范围里。文件本身照常可以在 Canvas 上打开。
        </p>
      </Card>
    )
  }

  if (outcome.status === 'failed') {
    return (
      <Card>
        <Labelled />
        <p role="alert" className="mt-3 text-sm text-destructive">
          {outcome.message}
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          刷新本页会重新尝试；如果是「材料读不出文字」这类结论，则会被记住、不再重复尝试。
        </p>
      </Card>
    )
  }

  const { payload, sourceChars, sourceTruncated, pageCount } = outcome.summary
  // `cached` 挂在 outcome 上（不是 summary 上）：它描述的是**这次是怎么来的**，
  // 不是总结本身的性质。
  const { cached } = outcome

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Labelled />
        <p className="text-xs text-ink-faint">
          {[pageCount === null ? null : `${pageCount} 页`, `${sourceChars.toLocaleString('zh-CN')} 字`]
            .filter(Boolean)
            .join(' · ')}
          {cached ? ' · 已缓存' : ''}
        </p>
      </div>

      {payload.overview !== '' && (
        <p className="mt-3 text-sm leading-relaxed text-foreground">{payload.overview}</p>
      )}

      {payload.points.length > 0 && (
        <ul className="mt-4 space-y-2">
          {payload.points.map((point, index) => (
            <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-ink-muted">
              <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-faint" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      )}

      {payload.formulas.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-medium tracking-wide text-ink-faint">公式 / 术语</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {payload.formulas.map((formula, index) => (
              <li
                key={index}
                className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground"
              >
                {formula}
              </li>
            ))}
          </ul>
        </div>
      )}

      {payload.overview === '' && payload.points.length === 0 && payload.formulas.length === 0 && (
        <p className="mt-3 text-sm text-ink-muted">
          模型没能从这份材料里读出可提炼的内容（不是失败，是这份材料确实没讲什么）。
        </p>
      )}

      {sourceTruncated && (
        <p className="mt-5 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-ink-muted">
          ⚠️ 这份材料太长，本次总结只用了前面一部分文字 —— 下面的要点不覆盖全篇。
        </p>
      )}

      <p className="mt-5 text-xs text-ink-faint">
        由 AI 依据材料文字生成，可能遗漏或出错。要点以「原文 ↗」为准。
      </p>
    </Card>
  )
}

/** 统一的卡片外壳（三种状态同一张卡，切换时布局不跳）。 */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-file-summary
    >
      {children}
    </section>
  )
}

/** 「AI 总结」标记 —— 必须一直在（见文件头第 1 条）。 */
function Labelled() {
  return (
    <h2 className="text-sm font-medium text-foreground">
      AI 总结
      <span className="ml-2 align-middle rounded-full border border-border px-1.5 py-0.5 text-[10px] font-normal text-ink-faint">
        机器生成
      </span>
    </h2>
  )
}
