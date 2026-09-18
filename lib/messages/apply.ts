import type { MessagePayload, MessageType } from '@/types/message'

import type { getCurrentUser } from '@/lib/api/response'

import type { MessageApplied } from '@/types/message'

import { isApplierReady, type ApplierReadyType } from './registry'

/**
 * 提案的「写入器」注册表（P0-3-18 定义的**接缝**）。
 *
 * ### 为什么要有这一层
 * P0-3-18 只负责「提案怎么排队、怎么被确认 / 忽略」；**每种提案确认之后到底写什么**，
 * 是产生它的那张卡的事：`syllabus_drift` → P0-3-20（改五板块 / `exam_dates`）、
 * `practice_test` → P0-3-23、`routine` → P0-3-21（Phase 1）、
 * `material`（资料索引通知）→ P0-3-19、`announcement`（课程公告）→ P0-3-25。
 *
 * 所以这里只放「注册表 + 通知类实现」，其余类型明确返回"未接入" ——
 * 而不是塞一个空的 no-op 让确认看起来生效（那就是静默失败）。
 *
 * ### 🔴 两条必须一起守的约束（P0-3-25 踩出来的）
 *
 * **① applier 实现必须惰性加载。** 顶层值 import 会顺着
 * `appliers/announcement → lib/course-update/apply → lib/tasks → lib/supabase/server`
 * 把服务端依赖链拖进任何 import 本文件的调用方。
 *
 * **② 「哪些类型有 applier」必须住在 `registry.ts`（纯模块）里。**
 * 曾经 `isApplierReady` 在本文件、而 `view.ts`（客户端组件链上）读它 ——
 * 于是构建期出现 `messages-view.tsx → view.ts → apply.ts →（动态 import）
 * appliers/announcement → ... → next/headers`，**Turbopack 直接报错**。
 * ⚠️ 注意：**动态 `import()` 挡不住这件事** —— 模块图分析照样把它算进去。
 * 所以按钮可用性彻底不碰 applier 实现，权威取值在 `registry.APPLIER_READY_TYPES`。
 *
 * ### 后续卡怎么接
 * 1. `registry.ts` 的 `APPLIER_READY_TYPES` 加类型（按钮可用性随之生效）；
 * 2. 本文件的 `APPLIERS` 加加载器（`satisfies` 会强制两边键一致，不会漂）；
 * 3. applier 内部持有自己的写入纪律（如 3-20「绝不自动覆盖 exam_dates」）。
 *
 * 🔴 applier 只会被 `PATCH /api/v1/messages/:id` 在**确认**路径上调用一次；
 * 忽略路径永不调用（`lib/messages/decide.ts`）。
 */

/** 与 PATCH 路由同源的会话客户端（用户级：RLS 生效，越权自然写不进去）。 */
export type ApplierSupabase = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

export type ApplyOutcome =
  | { ok: true; summary: string; applied?: MessageApplied }
  | { ok: false; code: string; message: string }

export type ApplyContext = {
  type: MessageType
  payload: MessagePayload
  supabase: ApplierSupabase
  /**
   * 当前用户 id。**必须来自会话**（不是 payload 里的任何字段）——
   * applier 里会用它去调 LLM 记账（`llm_runs` 有 RLS，传错了写不进去）。
   */
  userId: string
}

export type MessageApplier = (ctx: ApplyContext) => Promise<ApplyOutcome>

/** 惰性加载器：注册表存的是"怎么拿到 applier"，不是 applier 本身。 */
type ApplierLoader = () => Promise<MessageApplier>

/**
 * `material`：资料索引通知（P0-3-19 产出）。
 * 语义是"告诉你发现了 N 个新文件"，**确认只代表看到了**，没有业务数据要写 ——
 * 这是**刻意**的空写入，不是"还没实现"。
 */
const materialApplier: MessageApplier = async () => ({
  ok: true,
  summary: '已确认（资料索引通知，无需写入业务数据）',
})

/**
 * 加载器表。
 *
 * `satisfies Record<ApplierReadyType, ApplierLoader>` 是**编译期**保证：
 * 这里与 `registry.APPLIER_READY_TYPES` 的键必须一模一样 ——
 * 少一个（按钮能点但加载不到）或多一个（有实现但按钮不亮）都会让 `tsc` 报错。
 */
const APPLIERS = {
  material: async () => materialApplier,
  announcement: async () => (await import('./appliers/announcement')).announcementApplier,
} satisfies Record<ApplierReadyType, ApplierLoader>

/** 宽化后的索引视图：`ctx.type` 是完整的 `MessageType`，取值可能没有对应加载器。 */
const APPLIERS_BY_TYPE = APPLIERS as Partial<Record<MessageType, ApplierLoader>>

export { isApplierReady }

/** 执行写入。未接入的类型返回明确的失败，**绝不假装成功**。 */
export async function applyMessage(ctx: ApplyContext): Promise<ApplyOutcome> {
  const loader = APPLIERS_BY_TYPE[ctx.type]
  if (!loader) {
    return {
      ok: false,
      code: 'applier_not_implemented',
      message: `这类提案（${ctx.type}）的写入逻辑还没接入，现在请先「忽略」`,
    }
  }

  let applier: MessageApplier
  try {
    applier = await loader()
  } catch (error) {
    // 加载失败（构建产物缺 chunk、循环依赖…）必须说出来：吞掉就变成
    // "点了确认什么都没发生"，而且日志里也看不到。
    console.error('[messages] 加载 applier 失败:', ctx.type, error)
    return {
      ok: false,
      code: 'applier_load_failed',
      message: '写入逻辑加载失败，请稍后重试或改用对话框',
    }
  }

  return applier(ctx)
}
