/**
 * 对话框解析的 prompt（P0-3-24 解禁 exam / gradeComponents 之后的版本）。
 *
 * ### 为什么从路由里搬出来
 * 原先是 `app/api/v1/tasks/parse/route.ts` 里的模块内常量。要**验证解禁是否真的生效**
 * （ADR-021 的验收 ①：Galen Quiz Dates 6 个日期全对带 excerpt），就必须能离线拿同一份
 * prompt 去打一次真模型 —— 路由只导出 `POST`，测试拿不到那个常量。
 * 与 `lib/parse/prompts.ts` 同一手法：prompt 独立成模块，端点和脚本共用一份，
 * 改了 prompt 不会出现"线上跑 A 版、脚本验 B 版"。
 *
 * ### 🔴 规则 1 的变迁（本卡的核心）
 * v1：「**绝不**产出 exam —— 考试日期是权威数据，必须到课程页改」。
 * v2：解禁，**代价是每条 exam / gradeComponent 必须带 `sourceExcerpt`**。
 *
 * 解禁不是放宽，而是把「防幻觉」从"禁止产出"换成"必须可核对"：
 * - `sourceExcerpt` 是原文逐字摘录，用户一眼能看出模型有没有编日期；
 * - 服务端 `validateExamInput()` 对缺摘录的条目**直接拒收**（不是留空）；
 * - 写入仍走确认通道（ADR-015），解析照旧不落库。
 *
 * ### v3（P0-3-34）：加 `scores`
 * 老师把分数登在 Canvas 之外（Gradescope 等）时，Canvas 里那条任务的分数列恒为 `null`。
 * 于是让用户**说一句**「Discussion quiz 得分 9.5/10」，由 Tempo 记下来。
 * 同样带 `sourceExcerpt`；同样**只记原文明确写出的得分** ——
 * 「平均分 8.5/10」「最高分 10/10」这类描述一律不许当成本人的得分（那是编造）。
 *
 * 三条禁令**保持不变**（改了就是回退 ADR-004）：
 * 日期没写就不填（落 TBD，绝不编）；占比没写就 null（绝不用 0 代替）；不确定的进 warnings。
 */

import type { LLMMessage } from '@/lib/llm'

/**
 * prompt 版本号。**换 prompt 或换 schema 都要升** ——
 * `llm_runs.prompt_version` 是将来按版本对比准确率的唯一依据（ADR-003 复审用）。
 * v2 = P0-3-24 解禁 exam / gradeComponents。
 * v3 = P0-3-34 加 scores。
 */
export const COURSE_UPDATE_PROMPT_VERSION = 'v3'

export const COURSE_UPDATE_SYSTEM_PROMPT = `你是 Tempo 的课程更新解析器。用户会粘贴一段关于某门课的课程更新文字（作业与阅读截止、考试安排、成绩构成、分数都可能出现）。请解析成结构化结果。

规则：
1. tasks：只放作业（assignment）、阅读（reading）、其他待办（other）。**考试与成绩构成不要放这里**——它们各有自己的字段（exams / gradeComponents）。**某次作业的得分也不要放这里**——放 scores。
2. exams：只有文本里**明确写出**考试 / 测验 / 期中 / 期末安排时才产出（如 "Quiz 1: Sep 4"、"Midterm 2 – Nov 6, 7-9pm"）。名称保留原文写法。日期只填文本里真的写了的那个（按 M/D，如 9/4）；原文没写日期就填 null（系统会记成待定），**严禁编造日期**。examTime / location 同理，原文没写就 null。每条 exam 的 sourceExcerpt 必须是**支持这一条的那行原文逐字摘录**（≤200 字符）——找不到原文依据就不要产出这条考试。
3. gradeComponents：文本写出的各项占比（如 "Each Midterm 30%"、"Final 40%"、"Homework 20%"）。同一个说法出现多次（如 "Each Midterm 30%" 指两次期中）就拆成两条。weightPercent 只填原文写出的百分数（0-100，不含百分号）；原文没写占比就填 null，**绝不能用 0 代替**。每条同样必须带原文摘录。
4. scores：只有文本里**明确给出某一次作业 / 测验的得分**时才产出（如 "Discussion quiz 得分 9.5/10"、"HW3: 18/20"、"Problem Set 2 拿了 45/50"）。title 写这条得分在原文里对应的作业 / 测验名字（Tempo 会拿它去检索现有任务）；score 是得分、possible 是满分，**两个都必须是原文写出的数字，缺一个就不要产出这条**（不许用 0 补缺，也不许把占比当满分）。**绝不要**从"平均分 8.5/10"、"最高分 10/10"、"班级平均 7/10"、"本次占 20%"这类描述里产出得分——那不是本人考了多少。每条同样必须带原文摘录。
5. 日期一律按 M/D 返回（9/20、12月10日→12/10、Oct 5→10/5）；禁止自补 4 位年份（年份由系统按当前学年推断）。
6. 无法归入上面四类的事项（歧义、与这门课无关、"office hours 改到周三"这类没有结构化落点的通知）放进 warnings，一句话说清。
7. 输出必须严格符合 JSON schema，不要输出任何解释性文字。`

/** 组装一次解析调用所需的 messages（端点与探针脚本共用）。 */
export function buildCourseUpdateMessages(text: string): LLMMessage[] {
  return [
    { role: 'system', content: COURSE_UPDATE_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ]
}
