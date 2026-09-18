import type { MessageStatus, MessageType } from '@/types/message'

/**
 * 消息枚举的**运行时白名单**（P0-3-25 抽出）。
 *
 * ### 为什么要独立成文件
 * `toMessage()`（`lib/messages.ts`）用它来判断"这一行认不认识"，不认识就返回 null
 * —— 也就是 CodingRules §10.1 第 16 条那四处同改里的第 ② 处。
 * 它原先藏在 `lib/messages.ts` 里，而那个文件顶着
 * `import { createClient } from '@/lib/supabase/server'`（值 import）——
 * 回归脚本 import 它就会把 `next/headers` 拖进来，在没有请求上下文的地方直接抛错。
 * **结果就是第 ② 处漏改永远没有任何测试能发现**（表现：新类型的消息一条都不显示，
 * 只在服务端日志里留下一行 console.warn）。
 *
 * 抽到这里之后：纯模块、零依赖，`scripts/regress-messages.ts` 可以直接断言
 * 「白名单 == 标签表的键 == 类型定义的取值」，四处同改里第 ①②④ 三处一下就对齐了。
 *
 * 🔴 剩下唯一测不到的是第 ③ 处（数据库 CHECK 约束）—— 那个靠
 * `npm run probe:schema`（零写入枚举探针）在真库上验。
 */

/** 所有合法的 `messages.type`。与迁移的 CHECK 约束必须一致。 */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'syllabus_drift',
  'practice_test',
  'routine',
  'material',
  'announcement',
]

/** 所有合法的 `messages.status`。与迁移的 CHECK 约束必须一致。 */
export const MESSAGE_STATUSES: readonly MessageStatus[] = ['pending', 'accepted', 'dismissed']

/**
 * 已接入「确认后写入」逻辑的提案类型（P0-3-25 从 `apply.ts` 挪过来的）。
 *
 * ### 🔴 为什么这道数据必须住在纯模块里
 * 「确认」按钮的可用性是**客户端组件**在算的（`components/messages/messages-view.tsx`
 * → `lib/messages/view.ts` → 这里）。原先它读的是 `lib/messages/apply.ts` 的注册表，
 * 于是构建时出现这样一条依赖链：
 *
 * ```
 * messages-view.tsx(use client) → view.ts → apply.ts
 *   →（动态 import）appliers/announcement.ts → course-update/parse.ts
 *   → llm/run.ts → supabase/server.ts → next/headers   ✗ 客户端图里禁止
 * ```
 *
 * ⚠️ **动态 `import()` 救不了**：Turbopack 的模块图分析照样把它算进去，构建直接失败
 * （本次实测：`You're importing a module that depends on "next/headers"`）。
 * 所以唯一干净的做法是——**让按钮可用性完全不碰 applier 实现**。
 *
 * ### 单一真相怎么保证
 * 这里是权威取值；`apply.ts` 的加载器表用
 * `satisfies Record<ApplierReadyType, ApplierLoader>` 声明 ——
 * 少一个键、多一个键，`tsc` 都会报错。两边不可能漂开。
 */
export const APPLIER_READY_TYPES = ['material', 'announcement'] as const

export type ApplierReadyType = (typeof APPLIER_READY_TYPES)[number]

/** 该类型是否有已接入的 applier —— UI 的「确认」按钮可用性与 API 的 501 判定共用它。 */
export function isApplierReady(type: MessageType): boolean {
  return (APPLIER_READY_TYPES as readonly MessageType[]).includes(type)
}
