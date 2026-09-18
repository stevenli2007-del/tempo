/**
 * 自测卷的**文件载入**（P0-3-23）。
 *
 * ### 与 3-19b 的 `loadSummaryTarget()` 的关系：刻意不共用
 * 那个函数是"取一份文件 + 它所属的课"，而这里要的是**一次取齐三样**：
 * 试卷、它所属的课、**以及这门课的全部文件**（配对答案 key 的候选池，
 * 也是页面上「换一个答案文件」的备选列表）。
 * 多出来的那一大块查询形状完全不同，硬塞进同一个函数会让两边都变难读。
 *
 * ### 🔴 会话 client + RLS：这里的每一个 id 都来自客户端 URL 或查询参数
 * 别人的 `course_files.id` 在 RLS 下**根本查不到**（策略经 `courses.user_id` 反查），
 * 也就是"等同不存在"（ADR-010 统一 404 语义）。
 * 用 service role 就是"能拿别人的课件出卷子"——那是把越权写在明面上（Sync-Strategy §3）。
 *
 * ### 候选池为什么取整门课而不是"试卷所在文件夹"
 * 实测两种真实放法里有一种是**兄弟目录**（Math 53：`FA 23 Quiz` ↔ `FA 23 Quiz Solution`），
 * 只扫试卷所在文件夹就永远配不到。整门课的代价只是多查回来一些行（实测最大一门 271 个），
 * 而配对的判定本身是纯函数、零成本。
 */

import type { createClient } from '@/lib/supabase/server'

import { pairAnswerKey } from './pairing'
import type { PairingFile, PairingRule, RankedKey } from './pairing'

/** 服务端 Supabase 客户端（与 `lib/course-files/load.ts` 同一写法）。 */
type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 一门课最多取回多少个文件当配对候选（兜住极端数据，不是展示上限）。 */
const CANDIDATE_LIMIT = 500

/** 库里的一个文件（够配对 + 够生成 + 够页面画标题）。 */
export type PracticeFile = PairingFile & {
  /** 指回 Canvas 的预览页（给人点的那条）—— 也就是界面上的「原文 ↗」。 */
  fileUrl: string
  contentType: string | null
  sizeBytes: number | null
  /** Canvas 的 `modified_at`（**不是** `updated_at`）：内容变更时间，差量判据靠它。 */
  modifiedAt: string | null
  canvasFileId: string | null
  courseId: string
}

export type PracticeExamContext = {
  exam: PracticeFile
  courseName: string
  canvasCourseId: string | null
  /** 同课程全部未删除文件（含试卷自己）。配对与备选列表都从它里面挑。 */
  siblings: PracticeFile[]
}

type FileRow = {
  id: string
  course_id: string
  canvas_file_id: string | null
  display_name: string
  content_type: string | null
  size_bytes: number | null
  folder_path: string
  file_url: string
  modified_at: string | null
}

const FILE_COLUMNS =
  'id, course_id, canvas_file_id, display_name, content_type, size_bytes, folder_path, file_url, modified_at'

function toPracticeFile(row: FileRow): PracticeFile {
  return {
    id: row.id,
    courseId: row.course_id,
    displayName: row.display_name,
    folderPath: row.folder_path,
    fileUrl: row.file_url,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    canvasFileId: row.canvas_file_id,
  }
}

/**
 * 取一份试卷 + 它所属的课 + 这门课的全部文件。
 *
 * ### 查询失败要**显式报错**，不降级成"文件不存在"
 * CodingRules 7：静默的空结果会被读成"这份试卷没了"。
 * 迁移没跑（42P01）时 `course_files` 会报错 —— 那是**预期内的**，界面显示
 * "读取文件失败"比假装"文件不存在"诚实。
 */
export async function loadPracticeExamContext(
  supabase: ServerSupabase,
  examFileId: string,
): Promise<{ context: PracticeExamContext | null; error: string | null }> {
  const { data, error } = await supabase
    .from('course_files')
    .select(`${FILE_COLUMNS}, is_deleted`)
    .eq('id', examFileId)
    .maybeSingle()

  if (error) return { context: null, error: error.message }

  const examRow = data as (FileRow & { is_deleted: boolean }) | null
  // 软删的试卷当作"不存在"：它在 Canvas 上已经没了，这时去下载大概率失败 ——
  // 与其给一个网络错误，不如当作找不到（与 `loadSummaryTarget` 同一取舍）。
  if (!examRow || examRow.is_deleted) return { context: null, error: null }

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('course_name, canvas_course_id')
    .eq('id', examRow.course_id)
    .maybeSingle()

  if (courseError) return { context: null, error: courseError.message }
  const courseRow = course as { course_name: string; canvas_course_id: string | null } | null
  if (!courseRow) return { context: null, error: null }

  const { data: files, error: filesError } = await supabase
    .from('course_files')
    .select(FILE_COLUMNS)
    .eq('course_id', examRow.course_id)
    .eq('is_deleted', false)
    .order('display_name', { ascending: true })
    .limit(CANDIDATE_LIMIT)

  if (filesError) return { context: null, error: filesError.message }

  const siblings = ((files ?? []) as FileRow[]).map(toPracticeFile)
  const exam = toPracticeFile(examRow)
  // 试卷自己必须也在候选里（列表被截断到上限时可能不在）—— 补回去，
  // 免得调用方以为"这门课没有文件"。
  if (!siblings.some((file) => file.id === exam.id)) siblings.unshift(exam)

  return {
    context: {
      exam,
      courseName: courseRow.course_name,
      canvasCourseId: courseRow.canvas_course_id,
      siblings,
    },
    error: null,
  }
}

/**
 * 在一门课的文件列表里按 id 找一份文件。
 *
 * 🔴 **答案文件必须从候选池里找，不接受"任意 id"**：
 * 页面的 `?key=` 来自客户端，若直接拿它去查库，就能用**别人的**文件 id 出卷子
 * （RLS 会挡住查不到，但那样报的是"文件不存在"，说不清是"不是你的"还是"真没了"）。
 * 从候选池里找等价于"这份文件必须属于这门课"，一次判定两件事。
 */
export function findSibling(
  siblings: readonly PracticeFile[],
  fileId: string,
): PracticeFile | null {
  return siblings.find((file) => file.id === fileId) ?? null
}

export type KeyChoice = {
  /** 最终要用哪一份当答案。`null` = 这次没有答案（卷子只有题目，界面必须说出来）。 */
  key: PracticeFile | null
  /** 自动配对命中的规则。**用户自己换过就是 `null`**（那一份不是任何规则选的）。 */
  rule: PairingRule | null
  /** 全部候选（已排序）—— 页面用它画「换一个答案文件」。 */
  ranked: RankedKey<PracticeFile>[]
  /** 比对过多少份文件。界面那句话要能对得上账（"在这门课的 271 份文件里比的"）。 */
  considered: number
  /**
   * 用户在 `?key=` 里指定的那份**不在候选池里**（不属于这门课 / 已被删除）。
   * 页面必须**如实说出来**，而不是静默退回自动配对 ——
   * 后者会让用户以为"我选的那份生效了"，而实际上答案是另一份的。
   */
  explicitNotFound: boolean
}

/**
 * 定下"用哪一份答案"。
 *
 * 收在这里（而不是页面里）的理由：**页面、探针脚本、回归脚本都要算它**，
 * 三处各写一遍的话，"用户指定优先"这条规则会有三个版本，
 * 而它写错的后果是**配到另一份答案**（用户拿到一份错的答案还不知道）。
 *
 * 优先级：用户显式指定 > 自动配对 > 没有。
 */
export function resolveKeyChoice(params: {
  exam: PracticeFile
  siblings: readonly PracticeFile[]
  /** `?key=` 的值；没有就是 `null`。 */
  explicitKeyFileId: string | null
}): KeyChoice {
  const pairing = pairAnswerKey(
    params.exam,
    params.siblings.filter((file) => file.id !== params.exam.id),
  )

  if (params.explicitKeyFileId === null) {
    return {
      key: pairing.key,
      rule: pairing.rule,
      ranked: pairing.ranked,
      considered: pairing.considered,
      explicitNotFound: false,
    }
  }

  const explicit = findSibling(params.siblings, params.explicitKeyFileId)
  if (!explicit) {
    return {
      key: pairing.key,
      rule: pairing.rule,
      ranked: pairing.ranked,
      considered: pairing.considered,
      explicitNotFound: true,
    }
  }

  return {
    key: explicit,
    rule: null,
    ranked: pairing.ranked,
    considered: pairing.considered,
    explicitNotFound: false,
  }
}
