import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { UUID_PATTERN } from '@/lib/api/params'
import { loadExamExtraFile, softDeleteExamExtraFile } from '@/lib/review/store'
import { EXAM_REVIEW_BUCKET } from '@/lib/review/storage'

/**
 * `DELETE /api/v1/courses/:id/exams/:examId/review/files/:fileId`
 * —— 移除一份用户上传的额外文件。
 *
 * ### 两步，且顺序重要
 * ① **先软删行**（`is_deleted = true`）：界面的真相在表里，行先没了界面才立刻对；
 * ② 再尽力删 Storage 对象。删不掉只记日志、**不判整次失败** ——
 *    对象留着只是白占空间，而"行已软删、界面已更新"对用户是正确的；
 *    为了一个清理动作把用户刚做的删除判失败，是本末倒置。
 *
 * ### 归属
 * 行经 RLS 查（别人的上传件查不到 → 404，ADR-010 统一语义），
 * 再校验 `file.courseId === :id`（URL 里的课程必须就是文件真实所属的那门）。
 * ⚠️ **不校验 `:examId` 与行的 `exam_key` 是否相等**：考试行可能刚被 syllabus 重解析
 *    换成新 id，而上传件按 `exam_key` 存活 —— 拿旧 url 来删自己的文件应当照常成功。
 */
interface RouteContext {
  params: Promise<{ id: string; examId: string; fileId: string }>
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const { id: courseId, fileId } = await params
    if (!UUID_PATTERN.test(courseId) || !UUID_PATTERN.test(fileId)) {
      return jsonError(request, 400, 'bad_request', '课程或文件 ID 格式不正确')
    }

    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const loaded = await loadExamExtraFile(supabase, fileId)
    if (loaded.error) {
      throw new Error(`读取上传件失败: ${loaded.error}`)
    }
    if (!loaded.file || loaded.file.courseId !== courseId) {
      return jsonError(request, 404, 'not_found', '文件不存在或无权访问')
    }

    const deleted = await softDeleteExamExtraFile(supabase, fileId)
    if (deleted.error) {
      throw new Error(`软删上传件失败: ${deleted.error}`)
    }

    // 尽力删对象；失败只记日志（见文件头）。
    const removed = await supabase.storage
      .from(EXAM_REVIEW_BUCKET)
      .remove([loaded.file.storagePath])
    if (removed.error) {
      console.error('[exam-review] 删除 Storage 对象失败（行已软删，对象成孤儿）:', removed.error)
    }

    return jsonOk(request, { ok: true })
  } catch (error) {
    return internalError(request, error)
  }
}
