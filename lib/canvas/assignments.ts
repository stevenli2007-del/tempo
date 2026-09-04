import type { CanvasAssignment } from '@/types/canvas'

/**
 * Canvas 作业列表的端点与映射（P0-2-5，Sync-Strategy.md 第 4 / 14 节）。
 *
 * ### 这一层负责什么
 * - 知道作业端点长什么样（`assignmentsPath`）
 * - 把 Canvas 的原始对象**映射**成 `CanvasAssignment`
 *
 * **不负责**：发请求（`canvasGet`）、重试、翻页、限流、落库 ——
 * 那些是 `lib/sync/canvas-sync.ts` 的事（Sync-Strategy §8「重试与状态落库」归同步编排）。
 * 摆在这里是为了让「要什么数据」和「怎么调度请求」分开：前者跟着 Canvas 的字段变，
 * 后者跟着平台配额与限流策略变，两者的变化频率与原因完全不同。
 *
 * ### 同步范围的三个判断（都基于 2026-09-04 对 Steven 真实账号的实测）
 * 1. **`/assignments` 一个端点就够** —— 它同时返回作业与测验（`is_quiz_assignment` 标记），
 *    Phase 0 不区分二者，`task_type` 一律 `assignment`（DB 枚举里也没有 quiz）。
 * 2. **无 `due_at` 的作业照样同步，落库为 `null`（TBD）** —— Steven 2026-09-04 拍板。
 *    实测 CHEM 1A 的 25 条里有 9 条没日期（考勤打卡 + 4 个考试），
 *    宁可让它们在列表里显示为 TBD，也不替用户判断"这条不重要"。
 * 3. **跳过 `published=false` / `workflow_state` 为 unpublished·deleted 的条目** ——
 *    这些在 Canvas 学生端本来就看不见，同步进来只会制造"哪来的作业"的困惑。
 *    这不是替用户过滤内容，而是过滤掉**对学生不存在的东西**。
 *
 * ### 🔴 日志红线（Security-Privacy 第 8 节）
 * 不打印 token、Authorization 头或完整 URL；错误消息不含凭据。
 */

/** Canvas `/assignments` 返回对象里我们用到的字段，其余一律忽略。 */
type CanvasApiAssignment = {
  id?: number | string
  name?: string
  due_at?: string | null
  updated_at?: string | null
  published?: boolean
  workflow_state?: string | null
}

/** Sync-Strategy §4：单页 100 条。实测 6 门教学课最多 25 条，一页绰绰有余。 */
export const ASSIGNMENTS_PER_PAGE = 100

/** 单课程最多翻 3 页（Sync-Strategy §6.3 三级熔断的第三级）。 */
export const MAX_PAGES_PER_COURSE = 3

/**
 * 作业列表的第一页路径。翻页由 `canvasGet` 返回的 `nextPath` 驱动（Link 头），
 * 不在客户端手工拼 `page=2` —— Canvas 的分页游标格式可能变，Link 头才是契约。
 */
export function assignmentsPath(externalCourseId: string): string {
  return `/api/v1/courses/${encodeURIComponent(externalCourseId)}/assignments?per_page=${ASSIGNMENTS_PER_PAGE}`
}

/**
 * 原始响应 → `CanvasAssignment[]`。
 *
 * **绝不为拿到的数据编造内容**：标题缺失用「未命名作业」这种明确的占位，
 * 而不是去猜（Database.md：禁止编造 due_date，同样的道理对标题一样成立）。
 *
 * 解析不出 ID 的条目被跳过 —— `source_id` 是去重的唯一依据，
 * 没有它就无法判断"这是不是已经同步过的那条"，硬写进去只会产生重复任务。
 */
export function toCanvasAssignments(raw: unknown): CanvasAssignment[] {
  if (!Array.isArray(raw)) return []

  const result: CanvasAssignment[] = []
  const seen = new Set<string>()

  for (const item of raw as CanvasApiAssignment[]) {
    if (!item || typeof item !== 'object') continue

    // 学生端看不见的条目不同步（unpublished / 已删除）。
    if (item.published === false) continue
    if (item.workflow_state === 'unpublished' || item.workflow_state === 'deleted') continue

    if (item.id === undefined || item.id === null) continue
    const externalId = String(item.id)
    if (externalId === '' || seen.has(externalId)) continue

    seen.add(externalId)
    result.push({
      externalId,
      title: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '未命名作业',
      dueAt: typeof item.due_at === 'string' ? item.due_at : null,
      externalUpdatedAt: typeof item.updated_at === 'string' ? item.updated_at : null,
    })
  }

  return result
}
