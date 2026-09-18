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

/** 一个文件夹分组。 */
export type CourseFileGroup = {
  /** 原始路径（空串 = 根目录）。排序用。 */
  path: string
  /** 分组标题：根目录显示为「课程文件」，其余直接显示 Canvas 路径。 */
  label: string
  files: CourseFileView[]
}

/**
 * 按 Canvas 文件夹路径分组。
 *
 * ### 两处刻意的排序
 * 1. **根目录排最前**：实测大量文件直接躺在根目录（Chem 1A 的 syllabus 就在根上），
 *    它们是全课通用的，理应第一眼看到。
 * 2. 其余按路径字符串升序 —— `Lecture Slides/Unit 1` 自然排在 `Unit 2` 之前，
 *    不必解析层级。
 *
 * ### 为什么做扁平分组而不是多级树
 * Canvas 的 `full_name` 本来就是**扁平**的（`Practice Exams/Unit 1 Exam/Answer Keys`），
 * 做树要自己按 `/` 切段再拼父子，多一处逻辑就多一处出错；
 * 而实测一门课只有 13 个文件夹，扁平分组已经够读 ——
 * 标题直接显示完整路径反而比三级折叠更好扫（验收标准①要的就是"按结构分组"）。
 */
export function groupByFolder(files: CourseFileView[]): CourseFileGroup[] {
  const byPath = new Map<string, CourseFileView[]>()

  for (const file of files) {
    const bucket = byPath.get(file.folderPath)
    if (bucket) {
      bucket.push(file)
    } else {
      byPath.set(file.folderPath, [file])
    }
  }

  const groups: CourseFileGroup[] = []
  for (const [path, groupFiles] of byPath) {
    groups.push({
      path,
      label: path === '' ? '课程文件' : path,
      // 同一分组内按名字排（DB 已排过一次，分组后顺序可能被打散，这里再稳一次）。
      files: [...groupFiles].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    })
  }

  // 根目录第一，其余按路径升序。
  return groups.sort((a, b) => {
    if (a.path === '' && b.path !== '') return -1
    if (b.path === '' && a.path !== '') return 1
    return a.path.localeCompare(b.path)
  })
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
