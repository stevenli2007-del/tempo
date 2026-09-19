import { formatFileSize } from '@/lib/course-files/grouping'
import type { ReviewFile } from '@/lib/review/load'
import type { Recommendation } from '@/lib/review/recommend'
import type { ReviewExtraFile } from '@/lib/review/store'

import { ExtraFilesSection } from './extra-files-section'

/**
 * 复习页的「选资料」表单（P0-3-31）—— **服务端组件，零客户端 JS 提交**。
 *
 * ### 为什么用原生 `<form method="get">` 而不是客户端状态机
 * 勾选 → 生成 这件事的产物是"服务端跑一次模型"，用查询参数表达有几个实在的好处：
 * ① 勾选跟着 URL 走 —— 刷新、分享、回退都不丢，而客户端 state 一刷新就没了；
 * ② 少一个 API 端点 + 一套 loading 状态机，少两类"按钮转圈但没反应"的失败
 *    （与自测卷页 `?explain=` 同一条思路）。
 * 代价是每次提交整页重渲染 —— 这个取舍是**有意的**。
 *
 * ### 提交后 URL 长这样
 * `/courses/:id/exams/:examId/review?gen=1&files=<id>&files=<id>&extra=<id>`
 * 页面据此在 `<Suspense>` 里跑生成；勾选集合与缓存清单一致时会直接命中缓存（不花钱）。
 */

export function ReviewSourceForm({
  courseId,
  examId,
  recommended,
  extras,
  selectedFileIds,
  selectedExtraIds,
}: {
  courseId: string
  examId: string
  recommended: Recommendation<ReviewFile>[]
  extras: ReviewExtraFile[]
  selectedFileIds: readonly string[]
  selectedExtraIds: readonly string[]
}) {
  const selected = new Set(selectedFileIds)

  return (
    <form
      method="get"
      action={`/courses/${courseId}/exams/${examId}/review`}
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-review-source-form
    >
      {/* 有它才触发"生成"；没有它 → 只读展示已有总结。 */}
      <input type="hidden" name="gen" value="1" />

      <h2 className="text-sm font-medium text-foreground">选要复习的资料</h2>
      <p className="mt-1 text-xs text-ink-faint">
        勾选要一起总结的文件（按这场考试的名字推荐），点「生成复习总结」。
        勾选不变时再点一次会直接读到上次的结果，不会重新花钱。
      </p>

      {recommended.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          这门课的资料里没找到与这场考试相关的文件。
          可以先用下面的「上传额外文件」把自己找到的材料传进来。
        </p>
      ) : (
        <ul className="mt-3 space-y-1" data-review-recommended>
          {recommended.map(({ file, reason }) => (
            <li key={file.id} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                id={`file-${file.id}`}
                name="files"
                value={file.id}
                defaultChecked={selected.has(file.id)}
                className="mt-1"
              />
              <label htmlFor={`file-${file.id}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm break-words text-foreground">{file.displayName}</span>
                  {reason === 'name' ? (
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-ink-faint">
                      名字含「这场考试」
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-ink-faint">
                      像试卷
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-ink-faint">
                  {[
                    file.folderPath === '' ? '课程文件' : file.folderPath,
                    formatFileSize(file.sizeBytes),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </label>
              <a
                href={file.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 shrink-0 text-xs text-ink-muted hover:text-ink"
              >
                原文 ↗
              </a>
            </li>
          ))}
        </ul>
      )}

      <ExtraFilesSection
        courseId={courseId}
        examId={examId}
        extras={extras}
        selectedExtraIds={selectedExtraIds}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button
          type="submit"
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          生成复习总结
        </button>
        <span className="text-xs text-ink-faint">
          只会提炼你勾选的资料，不会替你去 Canvas 下载没勾的文件。
        </span>
      </div>
    </form>
  )
}
