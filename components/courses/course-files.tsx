import Link from 'next/link'

import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import { detectExtractableExtension, unsupportedReason } from '@/lib/course-files/extractable'
import { buildFileTree, formatFileSize } from '@/lib/course-files/grouping'
import { isKeyLikeName, isKeyLikePath, isExamLike } from '@/lib/practice-test/pairing'
import { paperHref } from '@/lib/practice-test/paper'

import type { CourseFileNode, CourseFileView } from '@/lib/course-files/grouping'

/**
 * 课程详情页的「资料」区（P0-3-19）。
 *
 * ### 每个文件夹是一层，不是一个路径字符串（2026-09-18 Steven 验收修正）
 * 上一版把 `Practice Exams/Unit 1 Exam/Answer Keys` 当成**一个**分组标题，
 * 于是三层结构被摊成三个并列小节。Steven 的原话是「文件一股脑全列出来了」，
 * 要的是「按照老师的分类放进文件夹里」。所以现在画的是**真文件夹树**：
 * `Practice Exams` ▸ `Unit 1 Exam` ▸ `Answer Keys`，层层可展开。
 *
 * ### 为什么用原生 `<details>` 而不是客户端折叠组件
 * 折叠状态是**纯粹的展示状态**，不需要进 React state —— 原生 `<details>` 自带键盘、
 * 屏幕阅读器与"页内搜索能展开"的行为，且整个资料区因此**零客户端 JS**。
 * 本项目已有先例（`messages-view.tsx` 的"展开全部原文"、课程页的「作业详情」）。
 *
 * ### 默认**收起**（而根目录的文件直接铺开）
 * 收起的理由就是这次反馈：一门课十几个文件夹全铺开 = 一屏看不下、也看不出层次。
 * 文件夹标题上带**子树总数**（`共 12 个`），收起状态下也能判断要不要点。
 * 根目录的文件不套文件夹（老师确实把它们放在最外层）—— 但超过 20 个月也收一段。
 *
 * ### 「一键总结」只出现在**能读的类型**上
 * 判定统一走 `detectExtractableExtension()`（与总结页、回归脚本同一份），
 * 读不了的类型画一个短横线 + 悬浮说明（`unsupportedReason`），**不画按钮** ——
 * 一个点了只会被拒绝的按钮比没有按钮更糟。
 * 点击**新开标签页**（`target="_blank"`）：课程页原样留着，用户可以连着点几份材料。
 *
 * ### 🔴 关于「下载内容」的说法必须准确（3-19 的红线在这里的准确表述）
 * 索引路径**依然**一个字节都不下载：落库的只有文件名、文件夹、外链。
 * 但「一键总结」会**为那一份文件临时读取内容**（生成要点用的，不留副本、不入库）。
 * 所以标题旁那句说明写的是「只有文件名与外链存在 Tempo；点总结时才会临时读那一份」
 * —— 继续写"不下载内容"就成了假话，而假话比不写更坏。
 *
 * ### 🔴 查询失败必须画出来，不能画成"没有资料"
 * CodingRules 7：静默的空列表会被读成"这门课没资料"。
 * 所以 `error` 非空时画 `role="alert"`，与空态是两种完全不同的画面。
 */

/**
 * 一个文件列表超过多少条就折叠。
 * 实测 R4A 有 **101 个文件就直接躺在根目录**（老师没分类）—— 那是全站最长的一屏，
 * 不折叠就是那条"一股脑"的老路。
 */
const COLLAPSE_THRESHOLD = 20

export function CourseFiles({
  courseId,
  lang,
  files,
  error,
}: {
  courseId: string
  lang: Lang
  files: CourseFileView[]
  error: string | null
}) {
  if (error) {
    return (
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-course-files>
        <h2 className="text-sm font-medium text-foreground">{t(lang, 'files.title')}</h2>
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t(lang, 'files.loadFailed', { error })}
        </p>
      </section>
    )
  }

  const tree = buildFileTree(files)
  const folderCount = countFolders(tree)

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm" data-course-files>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{t(lang, 'files.title')}</h2>
        <p className="text-xs text-ink-faint">
          {files.length === 0
            ? t(lang, 'files.onlyNames')
            : t(lang, 'files.count', { n: files.length, m: folderCount })}
        </p>
      </div>

      {files.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          {t(lang, 'files.empty')}
          <span className="mt-1 block text-xs text-ink-faint">
            {t(lang, 'files.emptyNote')}
          </span>
        </p>
      ) : (
        <>
          <div className="mt-4" data-course-file-tree>
            {tree.files.length > 0 && (
              <FileList courseId={courseId} lang={lang} files={tree.files} />
            )}
            {tree.children.map((child) => (
              <Folder key={child.path} courseId={courseId} lang={lang} node={child} />
            ))}
          </div>

          <p className="mt-4 border-t border-border pt-3 text-xs text-ink-faint">
            {t(lang, 'files.explain')}
          </p>
        </>
      )}
    </section>
  )
}

/** 一个文件夹（可展开）。子文件夹递归画在它里面，靠缩进表达层级。 */
function Folder({ courseId, lang, node }: { courseId: string; lang: Lang; node: CourseFileNode }) {
  return (
    <details className="border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 py-2.5 text-sm text-foreground hover:text-ink">
        <span className="font-medium">{node.name}</span>
        <span className="text-xs text-ink-faint">{t(lang, 'files.folderCount', { n: node.totalCount })}</span>
        {node.children.length > 0 && (
          <span className="text-xs text-ink-faint">
            {t(lang, 'files.subfolders', { n: node.children.length })}
          </span>
        )}
      </summary>
      <div className="pb-2 pl-4">
        {node.files.length > 0 && <FileList courseId={courseId} lang={lang} files={node.files} />}
        {node.children.map((child) => (
          <Folder key={child.path} courseId={courseId} lang={lang} node={child} />
        ))}
      </div>
    </details>
  )
}

/**
 * 一组文件的列表。超过 `COLLAPSE_THRESHOLD` 条时先露 20 条，其余折在一个"还有 N 个"里。
 *
 * 折的是**同一层里太多文件**，不是层级 —— 所以它只出现在"老师把几十个文件堆在同一个
 * 文件夹"的情况（R4A 根目录 101 个）。正常分好类的课看不到这一层。
 */
function FileList({ courseId, lang, files }: { courseId: string; lang: Lang; files: CourseFileView[] }) {
  if (files.length === 0) return null

  const overflow = files.length > COLLAPSE_THRESHOLD
  const head = overflow ? files.slice(0, COLLAPSE_THRESHOLD) : files
  const rest = overflow ? files.slice(COLLAPSE_THRESHOLD) : []

  return (
    <div className="mt-1">
      <FileTable courseId={courseId} lang={lang} files={head} />
      {rest.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-ink-faint hover:text-foreground">
            {t(lang, 'files.more', { n: rest.length })}
          </summary>
          <div className="mt-1">
            <FileTable courseId={courseId} lang={lang} files={rest} />
          </div>
        </details>
      )}
    </div>
  )
}

function FileTable({ courseId, lang, files }: { courseId: string; lang: Lang; files: CourseFileView[] }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {files.map((file) => (
        <FileRow key={file.id} courseId={courseId} lang={lang} file={file} />
      ))}
    </ul>
  )
}

function FileRow({ courseId, lang, file }: { courseId: string; lang: Lang; file: CourseFileView }) {
  const canSummarize = detectExtractableExtension(file.displayName, file.contentType) !== null
  /**
   * 「自测卷」只出现在**像试卷**的文件上（P0-3-23）。
   *
   * 判定走 `isExamLike()`（零依赖纯函数，回归脚本直接断言），**答案文件永远不出按钮** ——
   * 拿答案 key 去"出卷子"没有意义（那道题的答案就是它自己）。
   * 关键词表刻意取得宽（含 `practice` / `review`），因为**漏判比误判难查得多**：
   * 误判会走进去被一句"切不出题目"如实挡回来，漏判则是功能凭空消失。
   */
  const canMakeTest = isExamLike(file)
  const isAnswerFile = isKeyLikeName(file.displayName) || isKeyLikePath(file.folderPath)

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <a
        href={file.fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
      >
        {file.displayName}
      </a>

      <span className="shrink-0 text-xs text-ink-faint">
        {[formatFileSize(file.sizeBytes), fileExtension(file)].filter(Boolean).join(' · ')}
      </span>

      {canMakeTest ? (
        /*
         * ⚠️ 与「一键总结」同一条纪律：`prefetch={false}` 是**必填**。
         * 这个路由的渲染会触发一次真实下载（两份文件）+ 一次模型调用 ——
         * Next 的 `<Link>` 默认进视口就预取，那样列表一滚过去就会偷偷生成好几张卷子。
         */
        <Link
          href={paperHref({ courseId, examFileId: file.id })}
          target="_blank"
          rel="noopener noreferrer"
          prefetch={false}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          {t(lang, 'files.practiceTest')}
        </Link>
      ) : isAnswerFile && canSummarize ? (
        // 答案文件：明说为什么没有「自测卷」按钮，而不是留一个空白让人以为没做这个功能。
        <span className="shrink-0 px-2 py-1 text-xs text-ink-faint" title={t(lang, 'files.answerNote')}>
          —
        </span>
      ) : null}

      {canSummarize ? (
        /*
         * ⚠️ `prefetch={false}` 是**必填**，不是优化：
         * 这个路由的渲染**会触发一次真实的下载 + 模型调用**。
         * Next 的 `<Link>` 默认在进入视口时就预取 —— 那样列表一滚过去，
         * 十几个文件各自偷偷生成一份总结（慢、且真花钱）。
         */
        <Link
          href={`/courses/${courseId}/files/${file.id}`}
          target="_blank"
          rel="noopener noreferrer"
          prefetch={false}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          {t(lang, 'files.summarize')}
        </Link>
      ) : (
        <span
          className="shrink-0 px-2 py-1 text-xs text-ink-faint"
          title={unsupportedReason(file.displayName, file.contentType)}
        >
          —
        </span>
      )}
    </li>
  )
}

function countFolders(node: CourseFileNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countFolders(child), 0)
}

/**
 * 从展示名里取扩展名（大写）。
 *
 * ⚠️ 取不到就返回 `null`（**不是"未知"占位**）—— 没有扩展名是常见且正常的
 * （Canvas 上不少文件名不带后缀，如 `Weekly Review 1 - PDF`），画一堆「未知」只会制造噪音。
 * 也**不**用 `content_type` 反推后缀：那是另一套命名（`pptx` vs `presentation`），
 * 混着显示会让同一个文件在不同批次看起来不一样。
 *
 * 注意与 `detectExtractableExtension()` 的分工：那个是**功能判定**（能不能总结，
 * 会退到 `content_type` 上），这个是**纯展示**（名字里写了什么就显示什么）。
 * 两者刻意不合并 —— 一个文件"显示为 PDF"和"能被总结"不必是同一件事，
 * 合并之后任何一个需求变化都会牵动另一个。
 */
function fileExtension(file: CourseFileView): string | null {
  const dot = file.displayName.lastIndexOf('.')
  if (dot <= 0 || dot === file.displayName.length - 1) return null
  const ext = file.displayName.slice(dot + 1)
  if (ext.length > 5) return null
  return ext.toUpperCase()
}
