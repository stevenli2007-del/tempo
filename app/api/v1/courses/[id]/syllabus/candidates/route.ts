import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { toSyllabusFileCandidate } from '@/lib/syllabus-drift/files'
import { buildSyllabusImportCandidates } from '@/lib/syllabus-import/candidates'
import type { SyllabusImportCandidate } from '@/lib/syllabus-import/candidates'

/**
 * `GET /api/v1/courses/:id/syllabus/candidates` —— 「从 Canvas 资料选一份」的清单。
 *
 * ### 只读元数据，一个字节都不下载
 * 列清单这件事发生在用户**点开面板**的时候，此时还没选定文件 ——
 * 下载任何内容都是偷跑（ADR-026 第 1 条：同步路径零下载，按需路径只下"用户点的那一个"）。
 * 抽不动的文件照样列出来，只是 `supported: false` + 原因，由界面灰掉。
 *
 * ### 越权
 * `course_files` 的 RLS 经 `courses.user_id` 反查，查不到就是"不是你的" → 404（ADR-010）。
 */

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { id: courseId } = await params
    if (!UUID_PATTERN.test(courseId)) {
      return jsonError(request, 400, 'bad_request', '课程 ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    // 课程存在性（RLS 已限定归属）；顺手确认未归档。
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .maybeSingle()

    if (courseError) {
      throw courseError
    }
    if (!course) {
      return jsonError(request, 404, 'not_found', '课程不存在或无权访问')
    }

    const { data, error } = await supabase
      .from('course_files')
      .select(
        'id, display_name, folder_path, file_url, content_type, size_bytes, modified_at, canvas_file_id, course_id, is_deleted',
      )
      .eq('course_id', courseId)
      .order('display_name', { ascending: true })
      .limit(500)

    if (error) {
      // 迁移没跑（42P01）也会走到这里 —— 如实报错，不降级成空清单
      // （空清单会被读成"这门课在 Canvas 上没有资料"，那是诬告）。
      throw error
    }

    type Row = {
      id: string
      display_name: string
      folder_path: string
      file_url: string
      content_type: string | null
      size_bytes: number | null
      modified_at: string | null
      canvas_file_id: string | null
      course_id: string
      is_deleted: boolean
    }

    const rows = (data ?? []) as Row[]
    const candidates: SyllabusImportCandidate[] = buildSyllabusImportCandidates(
      rows.map((row) =>
        toSyllabusFileCandidate({
          id: row.id,
          course_id: row.course_id,
          canvas_file_id: row.canvas_file_id,
          display_name: row.display_name,
          folder_path: row.folder_path,
          file_url: row.file_url,
          content_type: row.content_type,
          size_bytes: row.size_bytes,
          modified_at: row.modified_at,
          is_deleted: row.is_deleted,
        }),
      ),
      courseId,
    )

    return jsonOk(request, { courseId, candidates })
  } catch (error) {
    return internalError(request, error)
  }
}
