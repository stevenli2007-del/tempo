import { loadCredentialMeta, revokeCredential } from '@/lib/canvas/credentials'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * 按范围删除数据（P0-3-2，契约 §7）。Phase 0 只支持 `scope=canvas`。
 *
 * 与 `DELETE /api/v1/canvas/credentials`（P0-2-9 的「撤销授权」）的**唯一区别**：
 * 撤销只断凭据、**保留**已导入的作业任务（Steven 2026-09-05 拍板：撤销不该销毁
 * 用户已建立的结构）；本端点连 Canvas 导入的 `tasks` 一起删 —— 回答的是另一个问题：
 * 「我不想让 Tempo 还留着从 Canvas 拉来的东西」。
 *
 * 两个动作都保留 syllabus 与手动任务，也保留 `courses.canvas_course_id`：
 * 重新连接后一同步，任务就回来了，所以这一条不需要二次确认到"输入邮箱"那个级别。
 *
 * 幂等：没有凭据时 `revoked = false`、没有 canvas 任务时 `deletedTasks = 0`，
 * 重复调用不会报错也不会把数字刷大。
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const scope = new URL(request.url).searchParams.get('scope')
    if (scope !== 'canvas') {
      return jsonError(request, 400, 'bad_request', 'scope 只支持 canvas')
    }

    // 先删任务再撤凭据：反过来的话，凭据一断，用户会看到"任务还在但连不上"的半截状态。
    const { data: deleted, error: deleteError } = await supabase
      .from('tasks')
      .delete()
      .eq('source', 'canvas')
      .select('id')
    if (deleteError) {
      throw deleteError
    }

    const credential = await loadCredentialMeta(supabase, user.id)
    let revoked = false
    if (credential !== null && credential.status !== 'revoked') {
      try {
        await revokeCredential(supabase, credential.id)
        revoked = true
      } catch {
        // 凭据行在查与写之间消失（并发）。想达到的状态本来就成立了，不算失败。
      }
    }

    return jsonOk(request, { revoked, deletedTasks: (deleted ?? []).length })
  } catch (error) {
    return internalError(request, error)
  }
}
