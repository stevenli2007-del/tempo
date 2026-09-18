/**
 * 公告的「落点判定」（P0-3-25，Sync-Strategy §14）。
 *
 * ### 什么是落点
 * 公告进消息栏之后，用户点「确认」到底能不能**写出东西**：
 * - **有落点**：文本里有考试 / 成绩构成，能走 `lib/course-update/apply.ts` 写进
 *   `exam_dates` / `grade_components` → 按钮是「确认」；
 * - **无落点**：如「本周课取消」「office hours 改到周三」这类**没有结构化去处**的通知
 *   → 按钮是「知道了」，确认只留一行回执，**一个字段都不写**。
 *   Steven 2026-09-17 拍板去掉 office hours 结构化落点，避免造一个没人维护的 OH 模型。
 *
 * ### 🔴 这是「粗筛」，不是解析
 * 判定完全靠本地关键词，**不调 LLM**：同步一轮要给几十条公告判落点，
 * 每条打一次模型既慢又贵，而且同步不该依赖模型可用性
 * （同步失败会连累作业，那是本末倒置）。
 *
 * 于是这个函数**刻意宽进**：
 * - 判成"无落点"是**能力被藏起来**（用户连试都试不了），代价更大；
 * - 判成"有落点"但实际解析不出东西，代价只是用户点一下「确认」后看到
 *   「这条公告没有可写入的字段」—— **明确说出来了，不是静默失败**。
 *
 * 真正的解析在确认那一刻做（`lib/messages/apply.ts` 的 announcement applier），
 * 与 3-24「解析不落库、确认才写」完全同形。
 *
 * ### ⚠️ 已知的边界（如实记下，不假装覆盖）
 * 「HW7 截止改到 9/20」这类**作业变更**会被判成有落点（含日期 + 作业词），
 * 但 applier 当前只写 `exam_dates` / `grade_components` —— 作业的改动需要匹配已有任务
 * 再改期，那是对话框（有人看着）的活，不在无人值守的 applier 里做。
 * 这种情形 applier 会**在回执里明确说出**"另有 N 条作业类信息未写入"，让用户去对话框处理。
 */

/**
 * 考试 / 成绩构成类关键词 —— 能落到 `exam_dates` / `grade_components` 的信号。
 *
 * 中英并列，因为 bCourses 上的公告两种语言都有。
 */
const EXAM_KEYWORDS =
  /\b(exam|quiz|quizzes|midterm|midterms|final|finals|test|tests)\b|考试|测验|小测|期中|期末|大考/i

/** 作业类关键词。含它们时判定为"有落点"（尽管 applier 只写考试 / 构成，见文件头边界）。 */
const ASSIGNMENT_KEYWORDS =
  /\b(assignment|assignments|homework|hw|pset|problem\s*set|project|essay|paper|report|due|deadline|submission)\b|作业|论文|报告|截止|提交/i

/** 成绩构成信号：百分比、占比、权重。 */
const WEIGHT_PATTERN = /\d{1,3}\s*%|\bpercent(age)?\b|\bweight(ed)?\b|占比|权重|成绩构成/i

/**
 * 日期信号：`9/4`、`9/4/2026`、`9月4日`、`Sept 4`、`October 16`。
 *
 * ⚠️ 刻意**不认**光秃秃的 "Friday" —— 「Quiz 每两周的周五」这种没有具体日期，
 * 认了会把"没日期"的公告也说成有落点。但 "Friday, 9/4" 会被 `\d{1,2}\/\d{1,2}` 命中。
 */
const DATE_PATTERN =
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\d{1,2}\s*月\s*\d{1,2}\s*日|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i

/**
 * 判这条公告**大概**有没有结构化落点。
 *
 * 规则（并集，任一成立即算有落点）：
 * 1. 出现百分比 / 占比 → 成绩构成（**不需要日期**：`"Final 30%"` 就是一个完整条目）；
 * 2. 出现考试类或作业类关键词 **且** 有具体日期 → 考试或作业的日期变更。
 */
export function hasStructuredLanding(text: string): boolean {
  if (text.trim() === '') return false

  if (WEIGHT_PATTERN.test(text)) return true
  if ((EXAM_KEYWORDS.test(text) || ASSIGNMENT_KEYWORDS.test(text)) && DATE_PATTERN.test(text)) {
    return true
  }
  return false
}
