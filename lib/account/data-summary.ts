import { loadCredentialMeta } from '@/lib/canvas/credentials'
import type { createClient } from '@/lib/supabase/server'
import type { CredentialStatus } from '@/types/canvas'

/**
 * 「我们存了你什么」的结构化清单（P0-3-2，PRD F6 / API-Contract §7）。
 *
 * 设置页与 `GET /api/v1/account/data-summary` **共用这一个函数** ——
 * 页面是服务端渲染，没必要自己 fetch 自己的端点绕一圈；
 * 更重要是：两处各写一份计数逻辑，迟早会飘成两个数字，
 * 而这是个"我要不要相信这个产品"的页面，数字打架最伤信任。
 *
 * ### 计数依赖 RLS，不手写 user_id
 * 五张表的 RLS 都是"只能看见自己的行"，所以直接 count 即可，
 * 不拼 `eq('user_id', …)`。少一处手写条件就少一处漏（同步层那条
 * "用 service role 就必须显式带 userId"的教训，正是手写条件的反面）。
 */

type Supabase = Awaited<ReturnType<typeof createClient>>

export type AccountDataSummary = {
  /** 未归档课程数（设置页展示的主体数字）。 */
  courses: number
  /** 归档课程数。单独列，不与未归档混在一起。 */
  archivedCourses: number
  /** syllabus 文件数（`syllabi` 行数；Storage 里的文件与之对应）。 */
  syllabi: number
  /** 未软删的任务数（含 syllabus 派生与 Canvas 导入）。 */
  tasks: number
  canvas: {
    /** 是否处于"已连接且可同步"状态：有凭据且未撤销。 */
    connected: boolean
    /** null = 从未连接过。 */
    status: CredentialStatus | null
    expiresAt: string | null
    /** 已关联 Canvas 的未归档课程数。 */
    linkedCourses: number
  }
}

export async function loadDataSummary(
  supabase: Supabase,
  userId: string,
): Promise<AccountDataSummary> {
  const [courses, archived, syllabi, tasks, linked, credential] = await Promise.all([
    supabase.from('courses').select('id', { count: 'exact', head: true }).eq('is_archived', false),
    supabase.from('courses').select('id', { count: 'exact', head: true }).eq('is_archived', true),
    supabase.from('syllabi').select('id', { count: 'exact', head: true }),
    supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('is_deleted', false),
    supabase
      .from('courses')
      .select('id', { count: 'exact', head: true })
      .eq('is_archived', false)
      .not('canvas_course_id', 'is', null),
    loadCredentialMeta(supabase, userId),
  ])

  // 计数失败必须抛出去，不能静默当成 0 —— "有 12 门课"显示成 0，
  // 用户会以为数据已经被清掉了，那是比报错危险得多的假信号（CodingRules 7）。
  const failure = [courses, archived, syllabi, tasks, linked].find((result) => result.error)
  if (failure?.error) {
    throw new Error(`统计数据读取失败：${failure.error.message}`)
  }

  return {
    courses: courses.count ?? 0,
    archivedCourses: archived.count ?? 0,
    syllabi: syllabi.count ?? 0,
    tasks: tasks.count ?? 0,
    canvas: {
      connected: credential !== null && credential.status !== 'revoked',
      status: credential?.status ?? null,
      expiresAt: credential?.expiresAt ?? null,
      linkedCourses: linked.count ?? 0,
    },
  }
}
