/**
 * 「这门课哪些文件可以当 syllabus 导入」的**清单构建**（P0-3-30）—— 纯函数、零依赖。
 *
 * ### 三条纪律
 * 1. **抽不动的文件也要列出来**，只是灰掉并给原因。
 *    凭空不显示会让用户以为"Canvas 上没传大纲"，那是**诬告**（ADR-016 R5 的同源取向）。
 * 2. **原因必须是「Tempo 读不了」，不是「这份文件没内容」**（`unsupportedReason` 的纪律）。
 * 3. **排序必须是全序**：① 抽得动 + 名字像 syllabus → ② 抽得动的其他 → ③ 抽不动的。
 *    第①档直接复用 3-20 的 `compareCandidates`（根目录 → PDF → 名字短 → 名字 → id），
 *    否则"同一门课每次打开顺序不一样"会让用户以为文件在动。
 *
 * ### 为什么不做"自动替你选好"
 * ADR-015/016：把 A 文件当成这门课的大纲去覆盖，代价是**替换掉用户已确认过的行**。
 * 这里只负责排顺序、"大纲"打个标，点哪一份由用户决定。
 */

import { checkFetchable } from '@/lib/course-files/fetch-content'
import {
  compareCandidates,
  matchesSyllabusName,
  type SyllabusFileCandidate,
} from '@/lib/syllabus-drift/files'
import { buildInternalPath } from '@/lib/internal-path'

/** 清单里的一行（客户端直接渲染，字段名 camelCase）。 */
export type SyllabusImportCandidate = {
  /** `course_files.id`。导入时回传它。 */
  id: string
  displayName: string
  folderPath: string
  sizeBytes: number | null
  modifiedAt: string | null
  /** 站内的资料页路径（给人点的）。与 `syllabi.file_url` 同一形状。 */
  fileUrl: string | null
  /** 名字像 syllabus（`syllabus` / `大纲`）—— 只影响排序与角标，不代表它就一定对。 */
  looksLikeSyllabus: boolean
  /** Tempo 能不能读它（三道闸门全在发请求之前判过）。 */
  supported: boolean
  /** `supported === false` 时的原因，必须是「Tempo 读不了」口径。 */
  reason: string | null
}

/**
 * 构建清单。
 *
 * ⚠️ 入参**必须已经是这一门课**的文件（调用方按 `course_id` 查过）——
 * 本函数不做归属判断，混进别课的文件就会跨课串数据（3-29 匹配层的同一条纪律）。
 *
 * 软删的文件**不进清单**：它在 Canvas 上已经没了，导入必然失败。
 */
export function buildSyllabusImportCandidates(
  files: SyllabusFileCandidate[],
  courseId: string,
): SyllabusImportCandidate[] {
  const usable = files.filter((file) => !file.isDeleted)

  const mapped = usable.map((file) => {
    const gate = checkFetchable({
      displayName: file.displayName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })
    return {
      file,
      item: {
        id: file.id,
        displayName: file.displayName,
        folderPath: file.folderPath,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        // 站内路径（`/courses/{cid}/files/{fid}`）—— 与资料区给用户的那条同构。
        // 🔴 绝不能写 Canvas 单文件端点返回的 `url`：那是能力凭据（ADR-026 第 3 条）。
        fileUrl: buildInternalPath(['courses', courseId, 'files', file.id]),
        looksLikeSyllabus: matchesSyllabusName(file.displayName),
        supported: gate.kind === 'ok',
        reason: gate.kind === 'ok' ? null : gate.reason,
      } satisfies SyllabusImportCandidate,
    }
  })

  const tier = (entry: { file: SyllabusFileCandidate; item: SyllabusImportCandidate }): number => {
    if (!entry.item.supported) return 2
    return entry.item.looksLikeSyllabus ? 0 : 1
  }

  return [...mapped]
    .sort((a, b) => {
      const tierDiff = tier(a) - tier(b)
      if (tierDiff !== 0) return tierDiff
      // 同一档内：第 0 档用 3-20 的全序；其余两档用「目录 → 名字 → id」全序。
      if (tier(a) === 0) return compareCandidates(a.file, b.file)
      return fallbackCompare(a.file, b.file)
    })
    .map((entry) => entry.item)
}

/** 兜底全序（不许留"同分"，否则顺序会随 DB 返回顺序漂）。 */
function fallbackCompare(a: SyllabusFileCandidate, b: SyllabusFileCandidate): number {
  if (a.folderPath !== b.folderPath) return a.folderPath < b.folderPath ? -1 : 1
  const byName = a.displayName.localeCompare(b.displayName, 'en')
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id === b.id ? 0 : 1
}
