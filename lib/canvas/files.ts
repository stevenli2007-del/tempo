import { toNumberOrNull } from '@/lib/numbers'
import type { CanvasFile, CanvasFolder } from '@/types/canvas'

/**
 * Canvas 文件 / 文件夹**元数据**的端点与映射（P0-3-19，Sync-Strategy.md 第 14 节）。
 *
 * ### 这一层负责什么
 * - 知道两个端点长什么样（`filesPath` / `foldersPath`）
 * - 把 Canvas 的原始对象**映射**成 `CanvasFile` / `CanvasFolder`
 * - 拼出指回 Canvas 的文件预览页（`filePreviewUrl`）
 *
 * **不负责**：发请求（`canvasGet`）、重试、翻页、限流、落库 ——
 * 那些是 `lib/sync/canvas-files.ts` 与 `lib/sync/canvas-request.ts` 的事。
 * 与 `lib/canvas/assignments.ts` 完全同一个分工：要什么数据 / 怎么调度请求，分开。
 *
 * ### 🔴 只建目录，不碰内容（本卡的红线）
 * 映射结果里**没有任何字段**能装文件内容。文件内容一个字节都不下载：
 * 要读某个文件时（3-20 大纲漂移 / 3-23 practice test）才按 `modifiedAt` 差量去取那一个。
 *
 * ### 实测依据（2026-09-18，Steven 真账号 14 门课）
 * - `/folders`：**全部 14 门课都 200**；`/files`：**8 门课 403**（没开 Files 区）。
 *   → 403 在本卡里是**常态**，不能当凭证失效（详见 `lib/sync/canvas-files.ts` 文件头）。
 * - Chem 1A：13 文件夹 / 37 文件，`Lecture Slides/Unit 1-4`、
 *   `Practice Exams/Unit 1 Exam/Answer Keys` 全在 —— 验收标准①的结构真实存在。
 * - Chem 1AL：55 文件夹里 **24 个 hidden**（教师区），57 文件里 2 个 restricted。
 *   → 「学生看不见就不索引」这条过滤有真实例，不是纸上谈兵。
 * - `hidden` 字段实测是 **`null` 而非 `false`**（未隐藏），必须判 `=== true`。
 * - `full_name` 直接给全路径（`course files/Lecture Slides/Unit 1`）→ 不必自己拼父子链。
 * - `/files` **没有** `html_url`；`url` 是 `/files/{id}/download?...&verifier=...`
 *   （**需 Bearer**，浏览器点开 401）→ 外链必须自己拼，见 `filePreviewUrl`。
 *
 * ### 🔴 日志红线（Security-Privacy 第 8 节）
 * 不打印 token、Authorization 头或完整 URL；错误消息不含凭据。
 */

/** `/files` 返回对象里我们用到的字段，其余一律忽略。 */
type CanvasApiFile = {
  id?: number | string
  folder_id?: number | string | null
  display_name?: string | null
  'content-type'?: string | null
  size?: number | string | null
  modified_at?: string | null
  locked?: boolean | null
  hidden?: boolean | null
  locked_for_user?: boolean | null
  hidden_for_user?: boolean | null
}

/** `/folders` 返回对象里我们用到的字段，其余一律忽略。 */
type CanvasApiFolder = {
  id?: number | string
  name?: string | null
  /** 全路径，实测形如 `course files/Lecture Slides/Unit 1`。 */
  full_name?: string | null
  parent_folder_id?: number | string | null
  hidden?: boolean | null
  locked?: boolean | null
  hidden_for_user?: boolean | null
  locked_for_user?: boolean | null
}

/** Sync-Strategy §4：单页 100 条。实测单课最多 100+（R4A），两页内够用。 */
export const FILES_PER_PAGE = 100

/**
 * 单课程资料区最多翻 3 页（沿用 Sync-Strategy §6.3 三级熔断的第三级）。
 * 文件夹与文件**各自**独立计数 —— 一门课最坏 3 + 3 = 6 个请求。
 */
export const MAX_PAGES_PER_COURSE_FILES = 3

/**
 * 根文件夹在 `full_name` 里的前缀。
 *
 * 实测：Canvas 的根文件夹 `full_name` 就是 `course files`，
 * 它下面的文件夹是 `course files/Lecture Slides`，再往下 `course files/Lecture Slides/Unit 1`。
 * 剥掉这个前缀后剩下的才是"用户在 Canvas 界面上看到的路径"。
 * 剥完为空串 = 根目录（**不是"未知"**，未知另有处理）。
 */
const ROOT_PREFIX = 'course files'

/**
 * 文件夹列表的第一页路径。翻页由 `canvasGet` 返回的 `nextPath` 驱动（Link 头），
 * 不在客户端手工拼 `page=2` —— Canvas 的分页游标格式可能变，Link 头才是契约。
 */
export function foldersPath(externalCourseId: string): string {
  return `/api/v1/courses/${encodeURIComponent(externalCourseId)}/folders?per_page=${FILES_PER_PAGE}`
}

/** 文件列表的第一页路径（同上，翻页交给 Link 头）。 */
export function filesPath(externalCourseId: string): string {
  return `/api/v1/courses/${encodeURIComponent(externalCourseId)}/files?per_page=${FILES_PER_PAGE}`
}

/**
 * 文件在 Canvas 上的**预览页**地址 —— 资料区里每个文件点开去的就是这里。
 *
 * ### 为什么不用 Canvas 返回的 `url`
 * `/files` 给的 `url` 形如 `https://{domain}/files/{id}/download?download_frd=1&verifier=<uuid>`：
 * 它**带着一次性 verifier 且需要 Bearer token**，用户在自己浏览器里点开是 401
 * （2026-09-18 实测）。本卡要的是"点开外链回 Canvas"，不是"替用户把文件下下来"。
 *
 * ### 为什么是这个形态
 * 2026-09-18 实测四个候选：
 * | URL | 结果 |
 * |---|---|
 * | `/courses/{cid}/files/{fid}` | **200** ✅ |
 * | `/courses/{cid}/files/{fid}?preview=1` | 302（跳下载） |
 * | `/files/{fid}/download?download_frd=1` | 302 |
 * | `/files/{fid}` | 200（但脱离课程上下文） |
 * 选第一个：它是 Canvas 课程内的文件页，用户登着 Canvas 就能看，且带课程上下文。
 */
export function filePreviewUrl(domain: string, canvasCourseId: string, fileId: string): string {
  return `https://${domain}/courses/${encodeURIComponent(canvasCourseId)}/files/${encodeURIComponent(fileId)}`
}

/**
 * 原始响应 → `CanvasFolder[]`。
 *
 * **不丢数据**：hidden 的文件夹照样映射出来（`visible: false`），
 * 由调用方决定要不要用 —— 映射层替调用方"先删掉一批"会让
 * "这门课到底有多少文件夹"这件事说不清（探针与回归脚本要靠它报数）。
 */
export function toCanvasFolders(raw: unknown): CanvasFolder[] {
  if (!Array.isArray(raw)) return []

  const result: CanvasFolder[] = []
  const seen = new Set<string>()

  for (const item of raw as CanvasApiFolder[]) {
    if (!item || typeof item !== 'object') continue
    if (item.id === undefined || item.id === null) continue

    const externalId = String(item.id)
    if (externalId === '' || seen.has(externalId)) continue
    seen.add(externalId)

    // ⚠️ 实测 `hidden` 是 `null` 而不是 `false`（表示"未隐藏"）—— 必须判 `=== true`，
    //    写成 `item.hidden == null ? false : item.hidden` 之类都要小心别把 null 当真。
    const restricted =
      item.hidden === true ||
      item.locked === true ||
      item.hidden_for_user === true ||
      item.locked_for_user === true

    // 路径优先取 `full_name`（Canvas 直接给全路径）；没有时退化成文件夹自己的名字
    // （那只是一段，不是全路径，但比丢掉强 —— 且探针会发现它）。
    const rawPath =
      typeof item.full_name === 'string' && item.full_name.trim() !== ''
        ? item.full_name
        : typeof item.name === 'string'
          ? item.name
          : ''

    result.push({
      externalId,
      name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '未命名文件夹',
      path: stripRootPrefix(rawPath),
      visible: !restricted,
    })
  }

  return result
}

/**
 * 原始响应 → `CanvasFile[]`（**已跳过学生看不见的条目**）。
 *
 * ### 跳过什么，以及为什么
 * 1. `locked` / `hidden` / `locked_for_user` / `hidden_for_user` 任一为真 —— 学生端
 *    根本看不到（实测 Chem 1AL 57 条里有 2 条）。索引进来只会制造"哪来的资料"。
 * 2. **没有展示名**的条目 —— 一个没有名字的条目在资料区里无法呈现，
 *    也不该拿 `filename`（URL 编码的原始名，`Chem+1A+...`）去顶替 —— 那是噪音不是名字。
 *
 * ⚠️ **不在这里过滤"文件夹不可见"**：那需要文件夹表一起判断，是同步层的职责
 * （`lib/sync/canvas-files.ts`），映射层只有这一个响应体。
 *
 * ### 解析不出 ID 的条目被跳过
 * `externalId` 是去重的唯一依据，没有它就无法判断"这是不是已经索引过的那个文件"。
 */
export function toCanvasFiles(raw: unknown): CanvasFile[] {
  if (!Array.isArray(raw)) return []

  const result: CanvasFile[] = []
  const seen = new Set<string>()

  for (const item of raw as CanvasApiFile[]) {
    if (!item || typeof item !== 'object') continue

    // 学生端看不见的文件不索引（同上，`null` 不等于 `true`，必须显式判）。
    if (
      item.locked === true ||
      item.hidden === true ||
      item.locked_for_user === true ||
      item.hidden_for_user === true
    ) {
      continue
    }

    if (item.id === undefined || item.id === null) continue
    const externalId = String(item.id)
    if (externalId === '' || seen.has(externalId)) continue

    const displayName = typeof item.display_name === 'string' ? item.display_name.trim() : ''
    if (displayName === '') continue

    seen.add(externalId)

    result.push({
      externalId,
      folderId: item.folder_id === undefined || item.folder_id === null ? null : String(item.folder_id),
      displayName,
      contentType:
        typeof item['content-type'] === 'string' && item['content-type'].trim() !== ''
          ? item['content-type']
          : null,
      sizeBytes: toNumberOrNull(item.size),
      modifiedAt: typeof item.modified_at === 'string' ? item.modified_at : null,
    })
  }

  return result
}

/**
 * 数一数原始响应里有多少条是**学生看不见**的（被 `toCanvasFiles` 跳过的那些）。
 *
 * ### 为什么单独一个函数
 * 被跳过的是**沉默的大多数** —— `tsc` / `eslint` / `build` 全绿，界面上也看不出来，
 * 只有真打一次 Canvas 才知道"我们到底漏了多少"。探针脚本（`probe:course-files`）
 * 靠它把"跳过 N 条"印成一行可对照的数字，否则"资料少了几条"根本无从查起。
 */
export function countRestrictedFiles(raw: unknown): number {
  if (!Array.isArray(raw)) return 0

  let count = 0
  for (const item of raw as CanvasApiFile[]) {
    if (!item || typeof item !== 'object') continue
    if (
      item.locked === true ||
      item.hidden === true ||
      item.locked_for_user === true ||
      item.hidden_for_user === true
    ) {
      count += 1
    }
  }
  return count
}

/**
 * `文件夹 ID → 路径`，**只收学生看得见的文件夹**。
 *
 * 文件靠它找到自己的分组。落在不可见文件夹里的文件会因为"查不到路径"而被同步层跳过
 * —— 这正是我们要的：学生在 Canvas 上看不见，就不该出现在 Tempo 的资料区里。
 *
 * ⚠️ 根文件夹（path 为空串）**必须**在表里：实测有大量文件直接躺在根目录
 * （Chem 1A 的 `Chem1A_Syllabus_Fall2026.pdf` 就在根上），漏了它们等于丢了整门课的散装资料。
 */
export function folderPathById(folders: CanvasFolder[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    if (folder.visible) {
      map.set(folder.externalId, folder.path)
    }
  }
  return map
}

/**
 * 剥掉 `full_name` 里的根前缀 `course files/`。
 *
 * `course files` → `''`（根目录）；
 * `course files/Lecture Slides/Unit 1` → `Lecture Slides/Unit 1`；
 * 不以该前缀开头的值（理论上不该出现）**原样返回**，不去猜 ——
 * 猜错的路径会把文件分到一个根本不存在的分组里。
 */
export function stripRootPrefix(fullName: string): string {
  const trimmed = fullName.trim()
  if (trimmed === ROOT_PREFIX) return ''
  if (trimmed.startsWith(`${ROOT_PREFIX}/`)) {
    return trimmed.slice(ROOT_PREFIX.length + 1)
  }
  return trimmed
}
