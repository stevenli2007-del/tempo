import { formatFileSize, groupByFolder } from '@/lib/course-files/grouping'
import type { CourseFileView } from '@/lib/course-files/grouping'

/**
 * 课程详情页的「资料」区（P0-3-19）。
 *
 * ### 每行只回答一件事：这个文件叫什么，点开去 Canvas
 * 本区是**目录**，不是阅读器 —— Tempo 不存课件内容，也不在这里复述内容。
 * 所以每行就是「名字 + 外链」，再补一个大小和类型帮用户判断要不要点。
 *
 * ### 🔴 只存目录、不下载内容（本卡红线，界面上也必须说清楚）
 * 空态与标题旁都写明了「只存文件名与外链，不下载内容」——
 * 这不是免责声明，而是**用户建立正确预期的关键**：
 * 一个"课件库"如果让人以为能离线看，点开发现要跳 Canvas 就是一次失望。
 *
 * ### 为什么按文件夹**扁平**分组而不是多级树
 * Canvas 的 `full_name` 本来就是扁平的（`Practice Exams/Unit 1 Exam/Answer Keys`），
 * 做树要自己切段拼父子；而实测一门课只有 13 个文件夹，
 * 直接把完整路径当分组标题反而更好扫。分组逻辑在 `lib/course-files/grouping.ts`。
 *
 * ### 🔴 查询失败必须画出来，不能画成"没有资料"
 * CodingRules 7：静默的空列表会被读成"这门课没资料"。
 * 所以 `error` 非空时画 `role="alert"`，与空态是两种完全不同的画面。
 */

export function CourseFiles({ files, error }: { files: CourseFileView[]; error: string | null }) {
  if (error) {
    return (
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-course-files>
        <h2 className="text-sm font-medium text-foreground">资料</h2>
        <p role="alert" className="mt-2 text-sm text-destructive">
          资料加载失败：{error}
        </p>
      </section>
    )
  }

  const groups = groupByFolder(files)

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-course-files>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">资料</h2>
        <p className="text-xs text-ink-faint">
          {files.length === 0
            ? '只存文件名与外链，不下载内容'
            : `${files.length} 个文件 · ${groups.length} 个文件夹 · 只存目录，内容点开回 Canvas 看`}
        </p>
      </div>

      {files.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          还没有资料。关联 Canvas 并同步一次后，老师放在 Files 里的课件、复习卷、答案会按文件夹结构列在这里。
          <span className="mt-1 block text-xs text-ink-faint">
            有些课没有开放 Files 区（实测 14 门里 8 门如此）—— 那种课这里会一直是空的。
          </span>
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((group) => (
            <div key={group.path}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                {group.label}
                <span className="ml-2 font-normal normal-case tracking-normal">
                  {group.files.length} 个
                </span>
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {group.files.map((file) => (
                  <li key={file.id}>
                    <a
                      href={file.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 truncate">{file.displayName}</span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {[formatFileSize(file.sizeBytes), fileExtension(file)]
                          .filter(Boolean)
                          .join(' · ')}
                        <span aria-hidden className="ml-1.5">
                          ↗
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * 从展示名里取扩展名（大写）。
 *
 * ⚠️ 取不到就返回 `null`（**不是"未知"占位**）—— 没有扩展名是常见且正常的
 * （Canvas 上不少文件名不带后缀），画一堆「未知」只会制造噪音。
 * 也**不**用 `content_type` 反推后缀：那是另一套命名（`pptx` vs `presentation`），
 * 混着显示会让同一个文件在不同批次看起来不一样。
 */
function fileExtension(file: CourseFileView): string | null {
  const dot = file.displayName.lastIndexOf('.')
  if (dot <= 0 || dot === file.displayName.length - 1) return null
  const ext = file.displayName.slice(dot + 1)
  if (ext.length > 5) return null
  return ext.toUpperCase()
}
