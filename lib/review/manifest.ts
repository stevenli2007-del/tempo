/**
 * 复习总结的**材料清单快照**与差量比对（P0-3-31）。
 *
 * ### 为什么单独一个零依赖文件
 * 差量判据（"要不要重算"）被**三处**用，且必须给出同一个答案：
 * ① 生成器（`generate.ts`）决定要不要打模型；② 页面决定要不要显示"刚生成"；
 * ③ 回归脚本直接断言。三处各写一份 = 分叉（P0-3-15 那类"两处都绿、肉眼才看得出"）。
 *
 * ### 判据：清单里**每一项**的 id + 内容版本都相同
 * - `file`：版本是 Canvas 的 `modified_at` —— 老师换掉这份资料 ⇒ 旧总结是**过期的谎话**。
 * - `extra`：版本是 `null`（用户上传件不会被原地改；要换只能删了重传 ⇒ id 变 ⇒ 清单变）。
 * - **勾选集合变了**（多勾/少勾一份）⇒ 清单长度或某项 id 不同 ⇒ 重算。这是对的：
 *   用户改了"要总结哪些资料"，就该拿到一份基于新集合的总结。
 */

import { sameInstant } from '@/lib/time'

/** 生成时用到的一份材料的快照（供界面挂「原文 ↗」与差量比对）。 */
export type ReviewManifestItem = {
  /** 编号（`f1` / `f2` …）。模型输出的 `files[].ref` 回指它。 */
  ref: string
  /** `file` = Canvas 索引里的文件；`extra` = 用户上传到 Storage 的文件。 */
  kind: 'file' | 'extra'
  /** `course_files.id` 或 `exam_review_files.id`。 */
  id: string
  /** 展示名（人话标签）。 */
  label: string
  /** 「原文 ↗」的目标：Canvas 预览页（`file`）。`extra` 为 null —— 渲染时现签 Storage 链接。 */
  url: string | null
  /** 内容版本（`file` 用 Canvas `modified_at`；`extra` 用 null）。任一变化即重算。 */
  modifiedAt: string | null
}

/**
 * 两份清单是不是"同一批同样的东西"。
 *
 * ⚠️ 顺序也要一致（`ref` 是按顺序发的）—— 用户在勾选顺序上做变化时，
 * 即便集合相同也会重算。代价是一次模型调用，换来的是"总结与当前勾选严格对应"，
 * 这个取舍是**有意的**（错的总结比多花一次钱坏得多）。
 */
export function sameManifest(
  a: readonly ReviewManifestItem[],
  b: readonly ReviewManifestItem[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.ref !== y.ref) return false
    if (x.kind !== y.kind) return false
    if (x.id !== y.id) return false
    if (!sameInstant(x.modifiedAt, y.modifiedAt)) return false
  }
  return true
}
