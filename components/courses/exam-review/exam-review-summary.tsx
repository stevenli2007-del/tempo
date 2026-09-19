import type { ExamReviewPayload } from '@/lib/review/prompt'

/**
 * 考试复习总结的渲染（P0-3-31）。
 *
 * ### 🔴 这个组件是**纯展示**：无 `'use client'`、无服务端 import
 * 所有数据（含每份材料的链接）由服务端页面解析好传进来 —— 与 `PracticePaperView` 同一形态。
 *
 * ### 三条不能省的诚实标记（沿用 ADR-024 / 3-19b 的同一套纪律）
 * 1. 标题必须写「AI 总结」—— 这是模型说的，不是老师说的；
 * 2. **每一份材料都带「原文 ↗」** —— 要点挂在哪份材料上，就要能点回去核对
 *    （挂错材料时用户才能发现，见 `lib/review/prompt.ts` 规则 3）；
 * 3. **覆盖不全时必须标出来**（`sourceTruncated`）—— 按额度截断后假装概括了全部，
 *    就是"计数撒谎"。
 *
 * ### 没提炼出要点的材料也**照样列出来**
 * 那是一条真信息（"这份材料没讲什么"），藏起来会让用户以为漏读了它。
 */

/** 一份材料的链接解析结果（服务端算好：Canvas 预览页 / Storage 现签 URL）。 */
export type ReviewSourceLink = {
  ref: string
  label: string
  kind: 'file' | 'extra'
  /** 「原文 ↗」的目标。`null` = 没有可点的链接（上传件被删 / 是直传文件）。 */
  href: string | null
}

export function ExamReviewSummary({
  payload,
  sources,
  model,
  note,
}: {
  payload: ExamReviewPayload
  sources: ReviewSourceLink[]
  model: string | null
  /** 页面追加的一句提示（如"刚生成"）。 */
  note?: string | null
}) {
  const byRef = new Map(payload.files.map((entry) => [entry.ref, entry]))
  const withPoints = sources.filter((source) => (byRef.get(source.ref)?.points.length ?? 0) > 0).length

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-exam-review-summary>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">
          AI 总结
          <span className="ml-2 align-middle rounded-full border border-border px-1.5 py-0.5 text-[10px] font-normal text-ink-faint">
            机器生成
          </span>
        </h2>
        <p className="text-xs text-ink-faint">
          {`${sources.length} 份材料`}
          {withPoints < sources.length ? ` · 其中 ${sources.length - withPoints} 份没提炼出要点` : ''}
          {model ? ` · ${model}` : ''}
        </p>
      </div>

      {payload.overview !== '' && (
        <p className="mt-3 text-sm leading-relaxed text-foreground">{payload.overview}</p>
      )}

      {payload.keyTopics.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium tracking-wide text-ink-faint">这次考试的重点</h3>
          <ul className="mt-2 space-y-1.5">
            {payload.keyTopics.map((topic, index) => (
              <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink" />
                <span>{topic}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sources.length > 0 && (
        <div className="mt-5 space-y-4">
          {sources.map((source) => {
            const points = byRef.get(source.ref)?.points ?? []
            return (
              <div key={source.ref} data-review-source={source.ref}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-xs text-ink-faint">{source.kind === 'extra' ? '上传' : '资料'}</span>
                  <span className="text-sm font-medium break-words text-foreground">{source.label}</span>
                  {source.href ? (
                    <a
                      href={source.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-xs text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      原文 ↗
                    </a>
                  ) : null}
                </div>

                {points.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {points.map((point, index) => (
                      <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-ink-muted">
                        <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-faint" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-faint">
                    这份材料没有可提炼的要点（不是失败，是它确实没讲什么）。
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {payload.overview === '' && payload.keyTopics.length === 0 && withPoints === 0 && (
        <p className="mt-3 text-sm text-ink-muted">
          模型没能从这些材料里读出可提炼的内容。
        </p>
      )}

      {note ? <p className="mt-4 text-xs text-ink-faint">{note}</p> : null}

      <p className="mt-5 text-xs text-ink-faint">
        由 AI 依据材料文字提炼，可能遗漏或出错。要点以各份材料的「原文 ↗」为准。
      </p>
    </section>
  )
}
