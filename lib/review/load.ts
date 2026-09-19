/**
 * 复习页的**载入**（P0-3-31）。
 *
 * ### 🔴 会话 client + RLS：这里的 id 来自客户端 URL
 * 别人的 `exam_dates.id` 在 RLS 下**根本查不到**（策略经 `courses.user_id` 反查），
 * 也就是"等同不存在"（ADR-010 统一 404 语义）。
 * 用 service role 就是"能看别人的考试复习页"——那是把越权写在明面上（Sync-Strategy §3）。
 *
 * ### 为什么这里再取一次整门课的文件
 * 复习页要按考试名**推荐**资料（可勾选），候选池就是这门课的全部未删除文件。
 * 与 `lib/practice-test/files.ts` 的 `loadPracticeExamContext()` 形状相近但入口不同：
 * 那边按**文件 id**（选中的试卷）进，这边按**考试 id**（`exam_dates`）进，
 * 且要多带"上传的额外文件"与"考试身份 key"。硬塞进同一个函数会让两边都变难读。
 *
 * ### 归属锚点是**考试身份**（`exam_key`），不是 `exam_dates.id`
 * `exam_dates` 的行会被重新解析整体替换（uuid 全变，见 `lib/parse/persist.ts`）。
 * 所以复习数据（总结 / 上传件）按 `(course_id, exam_key)` 存 —— 见迁移文件头。
 */

import { normalizeExamName } from '@/lib/course-update/exam-match'

import { loadExamExtraFiles } from './store'
import type { ReviewExtraFile } from './store'

import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 一门课最多取回多少个文件当推荐候选（兜住极端数据，不是展示上限）。 */
const CANDIDATE_LIMIT = 500

/** 库里的一个文件（够推荐 + 够取内容 + 够页面画标题）。 */
export type ReviewFile = {
  id: string
  courseId: string
  displayName: string
  folderPath: string
  /** Canvas 预览页（给人点的「原文 ↗」），与下载链不是一回事。 */
  fileUrl: string
  contentType: string | null
  sizeBytes: number | null
  /** Canvas 的 `modified_at`（**不是** `updated_at`）：内容变更时间，差量判据靠它。 */
  modifiedAt: string | null
  canvasFileId: string | null
}

export type ExamReviewContext = {
  exam: {
    /** `exam_dates.id`。**只用于本次渲染**，绝不作为持久键（重解析会换）。 */
    id: string
    courseId: string
    examName: string
    /** 考试身份 = `normalizeExamName(examName)`。持久键用它。可能为空串（名字全是标点）。 */
    examKey: string
    examDate: string | null
    examTime: string | null
    location: string | null
    status: 'confirmed' | 'tbd'
    /** syllabus 原文摘录（P0-3-31 的「考试信息」要素之一）。 */
    sourceExcerpt: string | null
  }
  courseName: string
  canvasCourseId: string | null
  /** 本门课全部未删除文件（推荐候选 + 出卷候选都从它里挑）。 */
  files: ReviewFile[]
  /** 用户为本场考试上传的额外文件（未删除）。 */
  extras: ReviewExtraFile[]
}

type ExamRow = {
  id: string
  course_id: string
  exam_name: string
  exam_date: string | null
  exam_time: string | null
  location: string | null
  status: string
  source_excerpt: string | null
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

/**
 * 取一场考试 + 它所属的课 + 这门课的全部文件 + 这场考试的上传件。
 *
 * ### 查询失败要**显式报错**，不降级成"考试不存在"
 * CodingRules 7：静默的空结果会被读成"这场考试没了"。
 * 迁移没跑（42P01）时 `exam_review_*` 会报错 —— 那是**预期内的**，界面显示
 * "读取复习数据失败"比假装"没有数据"诚实。
 */
export async function loadExamReviewContext(
  supabase: ServerSupabase,
  examDateId: string,
): Promise<{ context: ExamReviewContext | null; error: string | null }> {
  const { data, error } = await supabase
    .from('exam_dates')
    .select('id, course_id, exam_name, exam_date, exam_time, location, status, source_excerpt')
    .eq('id', examDateId)
    .maybeSingle()

  if (error) return { context: null, error: error.message }

  const exam = data as ExamRow | null
  if (!exam) return { context: null, error: null }

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('course_name, canvas_course_id')
    .eq('id', exam.course_id)
    .maybeSingle()

  if (courseError) return { context: null, error: courseError.message }
  const courseRow = course as { course_name: string; canvas_course_id: string | null } | null
  if (!courseRow) return { context: null, error: null }

  const { data: files, error: filesError } = await supabase
    .from('course_files')
    .select(FILE_COLUMNS)
    .eq('course_id', exam.course_id)
    .eq('is_deleted', false)
    .order('folder_path', { ascending: true })
    .order('display_name', { ascending: true })
    .limit(CANDIDATE_LIMIT)

  if (filesError) return { context: null, error: filesError.message }

  const examKey = normalizeExamName(exam.exam_name)
  const extras = await loadExamExtraFiles(supabase, exam.course_id, examKey)
  if (extras.error) return { context: null, error: extras.error }

  return {
    context: {
      exam: {
        id: exam.id,
        courseId: exam.course_id,
        examName: exam.exam_name,
        examKey,
        examDate: exam.exam_date,
        examTime: exam.exam_time,
        location: exam.location,
        status: exam.status === 'confirmed' ? 'confirmed' : 'tbd',
        sourceExcerpt: exam.source_excerpt,
      },
      courseName: courseRow.course_name,
      canvasCourseId: courseRow.canvas_course_id,
      files: ((files ?? []) as FileRow[]).map((row) => ({
        id: row.id,
        courseId: row.course_id,
        displayName: row.display_name,
        folderPath: row.folder_path,
        fileUrl: row.file_url,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        modifiedAt: row.modified_at,
        canvasFileId: row.canvas_file_id,
      })),
      extras: extras.files,
    },
    error: null,
  }
}

/**
 * 在一门课的文件列表里按 id 找一份文件 —— 勾选的文件 id 来自客户端 URL，
 * 只接受**这门课资料里确实存在的那一份**（一次判定同时回答"是不是你的"与"有没有这一份"）。
 */
export function findReviewFile(
  files: readonly ReviewFile[],
  fileId: string,
): ReviewFile | null {
  return files.find((file) => file.id === fileId) ?? null
}
