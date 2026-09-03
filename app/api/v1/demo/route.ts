import { getCurrentUser, internalError, jsonError, jsonOk } from '@/lib/api/response'

/**
 * Demo Workspace 清空端点（P0-1-10，契约 §8）。
 *
 * 一键清空当前用户全部 `is_demo = true` 的课程及其数据。
 *
 * 子表（五板块 + 派生的 tasks）全部对 `courses` 设了 `ON DELETE CASCADE`，
 * 所以物理删课程即级联清掉所有子数据；RLS 的 `for all` 策略保证只能删自己的。
 * 同时在 `profiles.demo_seeded_at` 复位为 null。
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, user } = await getCurrentUser()
    if (!user) {
      return jsonError(request, 401, 'unauthenticated', '请先登录')
    }

    const { data: demoCourses, error: listError } = await supabase
      .from('courses')
      .select('id')
      .eq('is_demo', true)
    if (listError) {
      throw listError
    }

    const ids = ((demoCourses ?? []) as Array<{ id: string }>).map((row) => row.id)
    if (ids.length === 0) {
      return jsonOk(request, { deleted: 0 })
    }

    // 级联清掉五板块 + 派生 tasks。
    const { error: deleteError } = await supabase.from('courses').delete().in('id', ids)
    if (deleteError) {
      throw deleteError
    }

    // 复位 demo 标记，让 UI 重新展示「先看看效果」入口。
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ demo_seeded_at: null })
      .eq('id', user.id)
    if (profileError) {
      throw profileError
    }

    return jsonOk(request, { deleted: ids.length })
  } catch (error) {
    return internalError(request, error)
  }
}
