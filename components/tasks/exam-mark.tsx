import { GraduationCap } from 'lucide-react'

/**
 * 考试的视觉标记（P0-3-33）。
 *
 * ### 为什么单独抽一个文件
 * **同一场考试**在五处出现：周历 pill、今日任务行、待办清单、课程页「作业详情」、
 * 课程页「考试复习」区。之前五处各画各的 ——
 * 周历是 lime 实心块 + 「考」字，今日任务只有一个光秃秃的「考」字，
 * 待办清单是一段灰色小字「考试」，作业详情是另一段灰色小字，复习区什么都没有。
 * 用户看不出「这是同一类东西」（Steven 2026-09-20 反馈：「考试和作业几乎没差别」）。
 * 所以把「考试长什么样」收在这里一处，五处调它 —— 改一次，全站一起变。
 *
 * ### 🔴 判定**不**在这里
 * 「这是不是考试」的唯一判据是 `lib/tasks/progress.ts` 的 `isExamTask()`
 * （`task.taskType === 'exam'`，用 `taskType` 而不是 `isDerived`，理由见那个函数）。
 * 本组件只负责**画**，由调用方决定要不要画 ——
 * 在这里再写一遍判定，就是 P0-3-15 那类「同一件事两处副本」的起点。
 *
 * ### 三件套 = 边框 + 底色 + 图标（外加「考」字）
 * 「边框 + 底色」由容器用下面两个常量拼进自己的 className（大面积用淡的、
 * 小徽标用浓的），图标 + 「考」由 `<ExamMark />` 出。
 *
 * 「考」字是 Steven 明确要求保留的（2026-09-20：「留」）—— 它是给"扫一眼"用的最短线索，
 * 但**不靠它单独传达信息**：底色与边框即使在全色盲下也仍然在。
 * 无障碍上「考」不进朗读流（`aria-hidden`），屏幕阅读器读到的是 `sr-only` 的「考试」——
 * 否则单一个「考」字会被逐字念成 "kǎo"，听的人不知道那是"考试"。
 *
 * ### 🔴 类名必须是**静态字面量**（Tailwind v4）
 * `bg-lime/20`、`border-lime-dark/40` 这些都写成完整字面量 ——
 * 运行时拼接（`bg-${x}`）扫不到、CSS 不生成，而 `tsc` / `eslint` / `build` 全绿
 * （CodingRules §10）。改动后要 grep 产物 CSS 证明类真的在。
 */

/** 小块（徽标 / 周历 pill）的「边框 + 底色」—— 浓一档，小面积才看得见。 */
export const EXAM_CHIP_CLASS = 'border border-lime-dark/40 bg-lime/20'

/** 大面积（整行 / 整块）的「边框 + 底色」—— 淡一档，整行铺浓底会压过正文。 */
export const EXAM_SURFACE_CLASS = 'border border-lime-dark/30 bg-lime/10'

/**
 * 「图标 + 考」——考试标记的内容部分。
 *
 * - `bare`（裸）：只出图标与字，**不带**自己的边框底色。
 *   给"容器本身已经铺了考试底色"的场合用（周历 pill / 今日任务行 / 复习区整行），
 *   否则会出现"块里套块"的双层边框。
 * - 默认（徽标）：自带边框底色的独立小徽标，给光秃秃的文字行用。
 */
export function ExamMark({ bare = false }: { bare?: boolean }) {
  const content = (
    <>
      <GraduationCap className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">考试</span>
      <span aria-hidden>考</span>
    </>
  )

  if (bare) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-lime-dark"
        title="考试"
      >
        {content}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-badge px-1.5 py-0.5 text-[10px] font-medium text-lime-dark ${EXAM_CHIP_CLASS}`}
      title="考试"
    >
      {content}
    </span>
  )
}
