/**
 * 五个板块的 prompt v1（P0-1-4）。
 *
 * ⚠️ **改这里必须升 `PROMPT_VERSION`**（在 `lib/parse/index.ts`）。
 * `llm_runs.prompt_version` 是 P0-1-5 之后做 "这次改 prompt 到底有没有变准" 的唯一分组依据，
 * 版本号不动的话，新旧调用会混在一组分不出效果。
 *
 * 只产出 **system 指令**；syllabus 正文由编排器作为 user 消息附加，
 * JSON Schema 由 `lib/llm` 的 adapter 自动拼在前面。
 */

import type { ParseSection } from '@/types/parse'

/** 已知的板块中文名，用于给模型一句角色定位。 */
const SECTION_LABEL: Record<ParseSection, string> = {
  gradeComposition: '成绩构成（Grade Composition）',
  courseOutline: '课程大纲（Course Outline）',
  testDates: '考试安排（Test Dates）',
  officeHours: '答疑时间（Office Hours）',
  submissionPolicy: '作业提交政策（Submission Policy）',
}

/**
 * 课程上下文。
 *
 * `semester` 尤其关键：syllabus 里考试日期常写成 "October 15"（不带年份），
 * 没有学期就无法确定是 2026 还是 2027。**日期是本产品最容易编造也最容易出错的字段**，
 * 给模型一个可靠的年份锚点，比事后校验便宜得多。
 */
export type SyllabusContext = {
  courseName?: string | null
  courseCode?: string | null
  semester?: string | null
  instructorName?: string | null
}

/** 所有板块共通的铁律。**禁止编造**是 PRD F3 的硬要求，各板块指令都会带上这一段。 */
const GLOBAL_RULES = [
  '## 铁律',
  '1. **禁止编造**。任何在原文中找不到依据的字段一律填 null。宁可空缺，不可猜测。',
  '2. 不要用"一般大学都这样"之类的常识去补全。你只知道这份 syllabus 里写了什么。',
  '3. 原文里整块没有这块内容时，返回**空数组**，不要为了填充而构造条目。',
  '4. `sourceExcerpt` 必须是原文**逐字**摘录（不超过 200 字符），用来让人核对依据；找不到原文依据就填 null —— 这也意味着这条结论本身不该被抽出来。',
  // ⚠️ 这条是 2026-09-02 自测时补的：不加的话模型会把 submission policy 的 description
  // 翻成中文，而 examName / topic 等逐字字段仍是英文，同一份结果里语言不一致。
  // 更重要的是：抽取层的首要目标是**可核对**，译文无法与原文比对（sourceExcerpt 也跟着失效）。
  // 展示层要翻译是后话，且翻译不可逆 —— 抽取层丢掉的原文信息找不回来。
  '5. **所有字段的值保留 syllabus 原文语言，不要翻译**。抽取的首要目标是让人能核对回原文；译文做不到这一点。需要其他语言由展示层处理。',
  '6. 只输出 JSON，不要任何解释、前后缀或 Markdown 代码块。',
].join('\n')

function contextBlock(context: SyllabusContext): string {
  const lines = Object.entries({
    课程名: context.courseName,
    课程代码: context.courseCode,
    学期: context.semester,
    教师: context.instructorName,
  })
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}：${value}`)

  if (lines.length === 0) return ''
  return ['## 课程信息（仅用于消歧，例如推断考试日期的年份）', ...lines].join('\n')
}

const SECTION_RULES: Record<ParseSection, string> = {
  gradeComposition: [
    '## 抽取范围',
    '- 只抽**成绩构成项**（各项名称与占总评的百分比）。',
    '- 不要抽 letter grade 换算表（如 "93-100 = A"），除非里面含有占比信息。',
    '- 同一类考核多次出现时（如每周 homework）**合并成一条**，把规则写进 `notes`（如"取最好的 10 次中的 8 次"）。',
    '- 占比统一换算成 0-100 的数字：`20%` → `20`，`one fifth` → `20`。原文没写占比就填 null。',
    '- ⚠️ **各项占比加起来不等于 100 时照抽不误**。不要为了凑满 100 分而补一条原文没有的构成项 —— 那是最典型的编造。',
  ].join('\n'),

  courseOutline: [
    '## 抽取范围',
    '- 抽取章节 / 周次安排，按原文出现的先后顺序编号（`orderIndex` 从 1 开始递增）。',
    '- 原文是表格或日历时逐行抽取。',
    '- `weekLabel` 填周次或章节标签（`Week 3`、`Ch. 5`）；原文没标注就填 null。',
    '- `topic` 要写完整主题，不要截断、不要合并多行。',
  ].join('\n'),

  testDates: [
    '## 抽取范围',
    '- 只抽**有明确名称的考核**（Midterm 1、Final Exam、Quiz 2 等）。',
    '- 日常作业（homework / problem set）不算考试，即使它有截止日期。',
    '',
    '## 日期处理（最易出错，务必谨慎）',
    '- `examDate` 必须是 **YYYY-MM-DD**，且**这份 syllabus 里必须写明了具体日期**才能填。',
    '- 原文只说 "midterm 在十月中旬"、"final 见校历" 这类**没有确切日期**的，`examDate` 一律填 null（系统会自动标记为 TBD）。这比猜一个日期安全得多。',
    '- 年份按上方课程信息里的学期推断（如 Fall 2026 → 2026）。跨年情况（Fall 学期里出现 January）按学期归属判断。',
    '- `examTime` 保留原文写法（如 `7-9pm`），不要擅自换算时区或格式。',
  ].join('\n'),

  officeHours: [
    '## 抽取范围',
    '- 每个值班人的每个时段占一条：同一人每周两天 → 两条；两个人分别值班 → 两条。',
    '- `startTime` / `endTime` 规整为 24 小时制 `HH:MM`（`2pm` → `14:00`）；无法可靠换算时保留原文。',
    '- `location` 既可能是办公室门牌，也可能是线上会议链接，如实照抄。',
    '- ⚠️ 不要把"需要预约（by appointment）"当成具体时段填进去；没有固定时段就把时间字段填 null，把"需预约"写进 `location`。',
  ].join('\n'),

  submissionPolicy: [
    '## 抽取范围',
    '- 抽**作业怎么交**的规定：交到哪个平台、文件格式要求、迟交处理。',
    '- 不同类别作业有不同规定时，各占一条。',
    '- 不要抽学术诚信声明、抄袭政策 —— 除非其中含有提交方式的要求。',
    '- `platformName` 只填平台名（Gradescope / bCourses / Piazza 等），没有明确平台就填 null。',
  ].join('\n'),
}

/**
 * 构造某个板块的 system 指令。
 *
 * 传回 `role: 'system'` 的完整消息：`lib/llm` 的 adapter 会把 JSON Schema 指令放在**最前面**，
 * 这条消息紧随其后，两者共同约束模型输出。
 */
export function buildSectionInstruction(
  section: ParseSection,
  context: SyllabusContext = {},
): string {
  return [
    `你是从大学课程 syllabus 中抽取${SECTION_LABEL[section]}的助手。`,
    '',
    contextBlock(context),
    '',
    SECTION_RULES[section],
    '',
    GLOBAL_RULES,
  ]
    .filter((part) => part !== '')
    .join('\n')
}
