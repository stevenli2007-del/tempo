/**
 * 课程资料区（P0-3-19）的**纯**视图逻辑：分组与格式化。
 *
 * ### 🔴 这个文件必须保持零依赖（本卡踩到的第一个坑）
 * 分组逻辑要被回归脚本（`scripts/regress-course-files.ts`）直接 import 断言 ——
 * 验收标准①（Chem 1A 的 `Lecture Slides/Unit 1-4`、`Practice Exams/Unit 1 Exam/Answer Keys`
 * 按结构分组）**必须**能被脚本验，不能只靠肉眼看页面。
 *
 * 而本文件一旦 import 任何服务端模块（`lib/supabase/server` → `next/headers`），
 * 脚本就用 Node 的类型擦除跑不起来了 —— 这正是 P0-3-25 踩过的那条：
 * **客户端 / 脚本要用的纯逻辑，必须与带服务端依赖的实现分文件住。**
 *
 * 所以：`grouping.ts`（本文件，零依赖，随便 import）+ `load.ts`（查库，服务端专用）。
 *
 * ### 🔴 这里也**永不接触文件内容**
 * 视图形状里只有文件名、文件夹、外链、大小、修改时间 —— 没有正文、没有字节。
 * 要读内容是 3-20 / 3-23 的事，且那时才按 `modifiedAt` 差量取那一个文件。
 */

/** 资料区里一个文件的视图形状。 */
export type CourseFileView = {
  id: string
  displayName: string
  /** Canvas 文件夹相对路径；空串 = 根目录。 */
  folderPath: string
  /** 指回 Canvas 的文件预览页。 */
  fileUrl: string
  contentType: string | null
  sizeBytes: number | null
  modifiedAt: string | null
}

/** 资料区里的一个文件夹节点（树）。 */
export type CourseFileNode = {
  /** 本层文件夹名（根节点为空串）。 */
  name: string
  /** 完整路径（根节点为空串）。唯一键，React `key` 与回归断言都用它。 */
  path: string
  /** **直属**本文件夹的文件（不含子文件夹的），已排序。 */
  files: CourseFileView[]
  /** 子文件夹，已排序。 */
  children: CourseFileNode[]
  /** 子树内文件总数（含所有后代）—— 折叠状态下也要能一眼看出"这里有多少东西"。 */
  totalCount: number
}

/**
 * 把 Canvas 的扁平路径还原成一棵**文件夹树**。
 *
 * ### 为什么从"扁平路径当标题"改成树（2026-09-18 Steven 验收反馈）
 * 原实现把 `Practice Exams/Unit 1 Exam/Answer Keys` 当成**一个**分组标题，
 * 于是 `Practice Exams`、`Practice Exams/Unit 1 Exam`、`.../Answer Keys` 是三个**并列**小节。
 * 实测 Chem 1A 平铺出 7 个同级标题、Chem 1AL 平铺出 10 个、R4A 干脆 101 个文件一坨 ——
 * 用户的原话是「文件一股脑全列出来了」，看不出老师的分层。
 *
 * ### 路径切分是安全的
 * Canvas 的 `full_name` 用 `/` 作分隔符，且**中间层文件夹真实存在**
 * （有 `Practice Exams/Unit 1 Exam/Answer Keys` 就必然有 `Practice Exams`），
 * 所以纯按文件路径拼树不会造出幻觉节点。
 * 代价（刻意接受）：Canvas 上**空的**文件夹不会出现在树里 —— 一个没有文件的文件夹
 * 对"找资料"这件事没有价值。
 *
 * ### 🔴 这里也永不接触文件内容
 * 节点里只有文件名、路径、外链 —— 没有正文、没有字节。
 */
export function buildFileTree(files: CourseFileView[]): CourseFileNode {
  const root: CourseFileNode = { name: '', path: '', files: [], children: [], totalCount: 0 }

  for (const file of files) {
    const segments = file.folderPath === '' ? [] : file.folderPath.split('/').filter((s) => s !== '')

    let node = root
    let path = ''
    for (const segment of segments) {
      path = path === '' ? segment : `${path}/${segment}`
      let child = node.children.find((c) => c.name === segment)
      if (!child) {
        // 同名不同层是合法的（两门课都可能有 `Unit 1`），所以按**完整路径**建节点、
        // 只在**同一父节点下**按 `name` 复用。
        child = { name: segment, path, files: [], children: [], totalCount: 0 }
        node.children.push(child)
      }
      node = child
    }

    node.files.push(file)
  }

  return finalize(root)
}

/**
 * 排序 + 自底向上数数。
 *
 * 用 `numeric: true` 做**自然序**：`Unit 2` 要排在 `Unit 10` 前面，`L2 Slides` 排在 `L10 Slides` 前面。
 * 纯字典序会把 `10` 排到 `2` 前面 —— 这在课件命名里是常态，不是边缘情况。
 */
function finalize(node: CourseFileNode): CourseFileNode {
  const byNaturalOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

  node.children.sort((a, b) => byNaturalOrder(a.name, b.name))
  node.files.sort((a, b) => byNaturalOrder(a.displayName, b.displayName))
  node.children = node.children.map(finalize)
  node.totalCount =
    node.files.length + node.children.reduce((sum, child) => sum + child.totalCount, 0)

  return node
}

/**
 * 字节数 → 人话（`407 KB` / `2.1 MB`）。
 *
 * `null` 返回 `null`（**不是 `0 B`**，也不是 `—`）—— Canvas 没给就是没给，
 * 用占位符会把"没数据"渲染成"有数据但是空"（Database.md §3.9 同一条铁律）。
 */
export function formatFileSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
