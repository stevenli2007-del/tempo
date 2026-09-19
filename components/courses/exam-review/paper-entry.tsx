import Link from 'next/link'

import { paperHref } from '@/lib/practice-test/paper'
import type { ReviewFile } from '@/lib/review/load'

/**
 * 「出卷」入口（P0-3-31）—— 复习页的最后一个要素。
 *
 * ### 🔴 本卡验收③的落点：没挑中 past exam ⇒ 按钮**不可用**并说明原因
 * 试卷**只会**从用户选中的那份 past exam 里**切**出来（连它的答案 key 一起），
 * 走 P0-3-23 的忠实自测卷（ADR-027）。**绝不**降级成"让 LLM 按这场考试的风格出新题" ——
 * 那样出来的题面是编的，用户做完没有任何办法知道对不对。
 *
 * 所以在没有候选时，这里渲染一个 **`disabled` 的按钮 + 一句解释**，
 * 而不是一个能点、点进去才发现不行的链接（点了只会被拒的按钮比没有按钮更糟）。
 *
 * ### 为什么候选只在**已勾选**的资料里挑
 * 用户勾了哪几份 = "我这次要复习这些"。出卷也在这些里挑 —— 与"总结用哪些材料"同一批，
 * 不会出现"总结基于 A，出卷却用了我没勾的 B"。
 */
export function PaperEntry({
  courseId,
  candidates,
  hasSelection,
}: {
  courseId: string
  /** 已勾选资料里 `isExamLike` 的那些（见 `lib/review/recommend.ts#paperCandidates`）。 */
  candidates: ReviewFile[]
  /** 用户是否勾了任何资料（用来分辨"没勾"与"勾了但没有卷子"两种空）。 */
  hasSelection: boolean
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-exam-review-paper>
      <h2 className="text-sm font-medium text-foreground">做一份自测卷</h2>

      {candidates.length > 0 ? (
        <>
          <p className="mt-1 text-xs text-ink-faint">
            从你勾选的 past exam 里切出题目、答案先收起 —— 题目与答案都来自那份文件，
            你能随时点「原文」核对。Tempo 不会自己出新题。
          </p>
          <ul className="mt-3 space-y-2">
            {candidates.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={file.displayName}>
                  {file.displayName}
                </span>
                {/* prefetch={false}：这个链接点开就是**真实下载两份文件 + 一次模型调用**。 */}
                <Link
                  href={paperHref({ courseId, examFileId: file.id })}
                  prefetch={false}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/50"
                >
                  出卷 →
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="h-9 cursor-not-allowed rounded-md border border-border bg-muted/40 px-4 text-sm text-ink-faint"
            >
              出卷
            </button>
            <span className="text-xs text-ink-muted">
              {hasSelection
                ? '你勾选的资料里没有 past exam。'
                : '还没有勾选任何资料。'}
            </span>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            {hasSelection
              ? '试卷只会从你勾选的 past exam（文件名/目录带 exam、quiz、midterm 的那种）里切题。'
              : '先在上面勾一份 past exam 再回来。'}
            {' '}
            没有 past exam 时 Tempo 不会替你编一套新题 —— 编出来的题面对不对没人知道，
            练习卷的价值全在「答案可信」上。
          </p>
        </>
      )}
    </section>
  )
}
