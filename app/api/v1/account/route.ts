import { deleteAccountAndData } from '@/lib/account/delete-account'
import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'
import { createServiceRoleClient } from '@/lib/supabase/admin'

/**
 * 删除账号及全部数据（P0-3-2，契约 §7 / PRD F6 / Security-Privacy A11）。
 *
 * 级联范围（全部由 FK `ON DELETE CASCADE` 覆盖，顺序与理由见
 * `lib/account/delete-account.ts`）：`profiles` / `courses` 及全部子表
 * （`syllabi` / 五板块 / `tasks`）/ `canvas_credentials` / `sync_runs` /
 * `llm_runs` / `parse_corrections` / `usage_events` / Supabase Storage 里的
 * syllabus 文件 / Supabase Auth 用户。
 *
 * ### 为什么这是 service role 的第四个合法使用方
 * 删 Auth 用户只能走 `auth.admin.deleteUser()`，用户级客户端没有这个权限。
 * 其余动作仍交给用户级客户端（Storage 删除走 RLS，只能删自己前缀下的对象）。
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    // 与 /sync/scheduled、/metrics 同款 fail closed：没配 service role key 就说缺什么，
    // 而不是笼统的 500 internal_error（那种消息排障时等于没有）。
    let adminClient
    try {
      adminClient = createServiceRoleClient()
    } catch {
      return jsonError(
        request,
        500,
        'service_role_key_missing',
        '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法删除登录账号',
      )
    }

    const result = await deleteAccountAndData({
      userId: user.id,
      supabase,
      adminClient,
    })

    if (result.error !== null) {
      // 文件没删干净就绝不算成功（否则就是制造无主文件）。用户可直接重试：
      // 每一步都幂等，已删的不会再删一遍。
      return jsonError(request, 500, 'delete_failed', result.error)
    }

    return jsonOk(request, {
      dataDeleted: result.dataDeleted,
      authUserDeleted: result.authUserDeleted,
      storageFilesDeleted: result.storage.deleted,
    })
  } catch (error) {
    return internalError(request, error)
  }
}
