/**
 * 「哪一个是这门课的 syllabus」+「该不该出漂移提案」—— 两个纯判定（P0-3-20）。
 *
 * ### 为什么独立成零依赖文件
 * 三条边都要给出**同一个**答案，任一处各写一遍就是分叉（CodingRules §10.1 第 21 条）：
 * 1. 同步侧（`lib/sync/syllabus-drift.ts`）—— 要不要建提案；
 * 2. 按需路径（`lib/syllabus-drift/generate.ts`）—— 下载的是不是同一个文件；
 * 3. 回归脚本 —— 断言"多个候选时选谁""换文件算不算变更"这类边界。
 *
 * 另外 `lib/sync/*` 会被定时同步（service role、无请求上下文）调用，
 * 这些判定一旦拖进 `next/headers` 之类的服务端依赖，脚本与回归都跑不起来
 * （P0-3-19 的 `grouping.ts` / P0-3-25 的 `registry.ts` 是同一个教训）。
 *
 * ### 🔴 本文件的三个"不"
 * - **不下载任何东西**：判定只看元数据（`course_files` 已有的列）。
 * - **不猜**：`size_bytes` 为 null 的文件**不当候选** —— ADR-026 的红线是
 *   "大小未知就不下载"（判不了成本宁可拒绝），选它当锚点等于把用户导到一个必然失败的按钮。
 * - **不诬告**：`modified_at` 缺失时**绝不**因此报"内容变了"。
 */

import { detectExtractableExtension } from '@/lib/course-files/extractable'
import { sameInstant } from '@/lib/time'

/** 判定只需要这些列 —— 与 `course_files` 的读取列一一对应（不多查一列）。 */
export type SyllabusFileCandidate = {
  /** `course_files.id`。落进 `courses.syllabus_file_id`。 */
  id: string
  /** Canvas 侧文件 ID。下载那一步要用它换下载链。 */
  canvasFileId: string | null
  displayName: string
  folderPath: string
  contentType: string | null
  /** null = Canvas 没给大小 → **不当候选**（ADR-026）。 */
  sizeBytes: number | null
  /** Canvas 的 `modified_at`。差量的唯一依据。 */
  modifiedAt: string | null
  isDeleted: boolean
  /**
   * 指回 Canvas 的**预览页**（`course_files.file_url`，3-19 已拼好）。
   *
   * 提案里的「原文 ↗」就用它 —— 用户要核对的是"这份大纲到底写了什么"，
   * 而差异是我们读出来的二手结论。**不要**用 Canvas 返回的那个 `url`
   * （带 verifier 的能力凭据，不能下发浏览器，ADR-026 第 3 条）。
   */
  fileUrl: string
}

/**
 * 名字里出现这些就算"可能是大纲"。
 *
 * 中英并列：bCourses 上两种语言的课都有；`大纲` 是中文课的常见写法。
 * ⚠️ 刻意不认 `outline` / `schedule` —— 那是"课程安排"，与"大纲（含考试与成绩构成）"
 * 不是一回事，认了会把 `Weekly Schedule.pdf` 选成大纲。
 */
const SYLLABUS_NAME_PATTERN = /syllabus|大纲/i

/**
 * 名字像不像 syllabus。
 *
 * ⚠️ 与 `isSyllabusFile()` 是**两件事**：那个回答"够不够格当漂移锚点"
 * （还要抽得动、大小已知），这个只回答"要不要排在清单最前面"。
 * 抽不动的文件也要显示 —— 只是**灰掉 + 给原因**，不能凭空消失。
 */
export function matchesSyllabusName(name: string): boolean {
  return SYLLABUS_NAME_PATTERN.test(name)
}

/**
 * 选出这门课的 syllabus 文件；没有合适的返回 `null`。
 *
 * ### 候选三条件（任一不满足就出局）
 * 1. 未软删除；
 * 2. 名字含 `syllabus` / `大纲`（大小写不敏感）；
 * 3. **抽得动**（`detectExtractableExtension` 认得）且 `size_bytes` 已知
 *    —— 图片型 / 压缩包 / 大小未知的文件做锚点，用户点开必然失败。
 *
 * ### 🔴 排序必须是**全序**（确定性 tie-break）
 * 判据：根目录优先 → PDF 优先 → 名字短优先（越短的越像正本）→ 名字字典序 → id 字典序。
 * 最后两级看着多余，但它们才是"同样输入永远同样输出"的保证 ——
 * `lib/tasks/match.ts` 就因为只按分数 `sort`、同分时留 DB 返回顺序，
 * 在无人确认的自动写路径上把 `Homework 9999` 匹到了 `Homework 9`。
 * 这里一旦不是全序，两轮同步可能选中不同文件 → 差量判定永远判"变了" → 每轮都投一份提案。
 */
export function pickSyllabusFile(files: SyllabusFileCandidate[]): SyllabusFileCandidate | null {
  const candidates = files.filter(isSyllabusFile)
  if (candidates.length === 0) return null

  const sorted = [...candidates].sort(compareCandidates)
  return sorted[0] ?? null
}

/** 单个文件够不够格当"这门课的大纲"。抽出来是为了让 pick 与回归断言共用同一条判据。 */
export function isSyllabusFile(file: SyllabusFileCandidate): boolean {  if (file.isDeleted) return false
  if (!SYLLABUS_NAME_PATTERN.test(file.displayName)) return false
  if (file.sizeBytes === null) return false
  return detectExtractableExtension(file.displayName, file.contentType) !== null
}

export function compareCandidates(a: SyllabusFileCandidate, b: SyllabusFileCandidate): number {
  // ① 根目录优先：实测 Chem 1A 的 `Chem1A_Syllabus_Fall2026.pdf` 就在根上，
  //    而 `Archive/` 之类目录下的同名文件多半是旧版。
  if (a.folderPath !== b.folderPath) {
    if (a.folderPath === '') return -1
    if (b.folderPath === '') return 1
    return a.folderPath < b.folderPath ? -1 : 1
  }

  // ② PDF 优先：syllabus 的正本几乎总是 PDF；docx 多为老师的工作稿。
  const aPdf = isPdf(a) ? 0 : 1
  const bPdf = isPdf(b) ? 0 : 1
  if (aPdf !== bPdf) return aPdf - bPdf

  // ③ 名字短优先（「Syllabus.pdf」胜过「Syllabus old version 2020 final.pdf」）。
  if (a.displayName.length !== b.displayName.length) return a.displayName.length - b.displayName.length

  // ④⑤ 全序收尾：不给"同分"留任何余地。
  const byName = a.displayName.localeCompare(b.displayName, 'en')
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id === b.id ? 0 : 1
}

function isPdf(file: SyllabusFileCandidate): boolean {
  return detectExtractableExtension(file.displayName, file.contentType) === 'pdf'
}

/**
 * 差量锚点（`courses` 的两列）在同步侧读出来的形状。
 *
 * `syllabusSeenModifiedAt` 是**文件版本**（`course_files.modified_at` 的值），
 * 不是"什么时候核对的" —— 见迁移 `20260923000000_syllabus_drift.sql` 的注释。
 */
export type DriftAnchor = {
  syllabusFileId: string | null
  syllabusSeenModifiedAt: string | null
}

/**
 * 判定结果。`baseline` / `propose` **把选中的那个文件一起带出来**（`candidate`）。
 *
 * 这不是"顺手多带一个字段"：调用方拿到 `propose` 后要拿这个文件的 id 去写锚点、
 * 拿 `modified_at` 去建提案。如果只给一个 `kind`，调用方就得对 `pickSyllabusFile()`
 * 的返回值再做一次 `if (!candidate) continue` —— 而那是个**类型系统逼出来的、
 * 逻辑上永远不成立**的守卫（`decideDrift` 在 candidate 为 null 时只会返回 `skip`）。
 * 把文件放进结果里，不变量就写在类型上，调用方一处都不用猜。
 */
export type DriftDecision =
  /** 什么都不做。`no_file` = 这门课没有合格的大纲文件（无 Files 区 / 没传 / 抽不动）。 */
  | { kind: 'skip'; reason: 'no_file' | 'unchanged' }
  /** 只记锚点、**不建提案**（首次核对，或换了一个文件）。 */
  | { kind: 'baseline'; candidate: SyllabusFileCandidate }
  /** 建一条 `syllabus_drift` 提案（同步侧到此为止，diff 由用户打开消息栏时懒补）。 */
  | { kind: 'propose'; candidate: SyllabusFileCandidate }

/**
 * 判这门课这次要不要出提案。**纯函数**：不查库、不下载、不调模型。
 *
 * ### 🔴 首次核对只记基线、不提案（刻意）
 * 卡面的触发条件是「**抓到 syllabus 内容变化**」—— 首次看到某个文件不是"变化"。
 * 若首次就提案，Steven 的 6~13 门课会在第一次同步后每门课塞一条"大纲可能有变更"，
 * 而用户什么也没做错 —— 那正是 ADR-016 R2/R3 要防的噪音。
 * 而"我的记录是不是过时了"另有入口（重新上传 / 重新解析 syllabus），不需要在这里补。
 *
 * ### 🔴 换了文件 → 也走基线
 * 判据是"**同一个文件的内容变了**"。文件名从 `Syllabus.pdf` 变成 `Syllabus_v2.pdf`
 * 是**另一份文档**，我们与它没有任何共同锚点：此刻说"内容变了"是诬告
 * （说不定只是老师重命名了一次）。所以换文件只重记基线，让新文件从下一版开始被跟踪。
 *
 * ### 🔴 `modified_at` 缺失时不报变更
 * Canvas 没给 `modified_at` 时无法判断内容有没有变。此时**既不报变更**（会诬告），
 * **也不写成"已核对"**（会把这门课永久锁死）—— 只在换过文件时重记一次基线。
 */
export function decideDrift(input: {
  anchor: DriftAnchor
  candidate: SyllabusFileCandidate | null
}): DriftDecision {
  const { anchor, candidate } = input

  if (!candidate) return { kind: 'skip', reason: 'no_file' }

  const sameFile = anchor.syllabusFileId === candidate.id

  if (candidate.modifiedAt === null) {
    // 没有版本信息：不写、也不提案（见上方注释）。
    if (sameFile && anchor.syllabusSeenModifiedAt === null) return { kind: 'skip', reason: 'unchanged' }
    return { kind: 'baseline', candidate }
  }

  // 从没核对过（首次），或换了一个文件 → 只记基线。
  if (anchor.syllabusFileId === null || anchor.syllabusSeenModifiedAt === null) {
    return { kind: 'baseline', candidate }
  }
  if (!sameFile) return { kind: 'baseline', candidate }

  // 同一个文件，比版本。**用 epoch 比，不比字符串**（CodingRules §10.1 第 13 条：
  // PostgREST 回 `+00:00`、Canvas 给 `Z`，比字符串会永远判成"变了"→ 每轮同步都提案）。
  return sameInstant(candidate.modifiedAt, anchor.syllabusSeenModifiedAt)
    ? { kind: 'skip', reason: 'unchanged' }
    : { kind: 'propose', candidate }
}

/** `course_files` 的一行（snake_case，只列判定需要的列）。 */
export type CourseFileDriftRow = {
  id: string
  course_id: string
  canvas_file_id: string | null
  display_name: string
  folder_path: string
  content_type: string | null
  size_bytes: number | null
  modified_at: string | null
  file_url: string
  is_deleted: boolean
}

/**
 * 库里的一行 → 判定用的候选。
 *
 * 映射只此一处：同步侧与探针读的是同一列集合，哪一列漏了会**同时**在两边暴露，
 * 而不是"同步看不到、探针看得到"这种最难查的半边错。
 */
export function toSyllabusFileCandidate(row: CourseFileDriftRow): SyllabusFileCandidate {
  return {
    id: row.id,
    canvasFileId: row.canvas_file_id,
    displayName: row.display_name,
    folderPath: row.folder_path,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    isDeleted: row.is_deleted,
    fileUrl: row.file_url,
  }
}
