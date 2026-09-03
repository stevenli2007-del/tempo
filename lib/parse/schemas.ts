/**
 * 五个板块的 JSON Schema（P0-1-4）。
 *
 * 设计原则：
 *
 * 1. **只声明抽取真正用得上的字段**，字段越多模型越容易跑偏（schema 会拼进 prompt）。
 * 2. **除"名称/主题"这类主键外一律可空**（`['string','null']`）——
 *    PRD F3 的硬要求是"缺失显示 TBD、禁止编造"，schema 层面就得给模型"可以填 null"的许可，
 *    否则模型为了填满字段会去猜。
 * 3. **每个条目都带 `sourceExcerpt`**：逼模型给出原文依据，既抗幻觉也让用户可核对。
 * 4. **模块级 `as const`**：`JSONSchema` 的数组字段接受 readonly，不需要去掉 `as const`。
 *
 * ⚠️ **改 schema 等于改 prompt**，必须同步改 `prompts.ts` 里的说明，并升 `PROMPT_VERSION` ——
 * 否则 `llm_runs.prompt_version` 会把不同版本的调用混在一起，将来按 prompt 版本对比准确率就失真的。
 */

import type { JSONSchema } from '@/lib/llm'

/** 原文摘录：≤200 字的逐字引用，找不到就 null。五个板块都用同一套说明。 */
const EXCERPT: JSONSchema = {
  type: ['string', 'null'],
  description: ' syllabus 原文中支持本条结论的逐字摘录，不超过 200 字符；找不到对应原文就填 null。',
}

export const GRADE_COMPOSITION_SCHEMA = {
  type: 'object',
  properties: {
    components: {
      type: 'array',
      description: '成绩构成项。整份 syllabus 都没有评分说明时返回空数组，不要编造。',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '构成项名称，如 Homework、Midterm 1、Final。' },
          weightPercent: {
            type: ['number', 'null'],
            description: '占比百分数（0-100），不含百分号。原文没写占比时填 null，不要用 0 代替。',
          },
          notes: {
            type: ['string', 'null'],
            description: '附加规则，如"取最好的 10 次中的 8 次"。没有就填 null。',
          },
          sourceExcerpt: EXCERPT,
        },
        required: ['name', 'weightPercent', 'notes', 'sourceExcerpt'],
      },
    },
  },
  required: ['components'],
} as const

export const COURSE_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '按 syllabus 中出现的先后顺序排列的章节/周次安排。没有大纲时返回空数组。',
      items: {
        type: 'object',
        properties: {
          orderIndex: {
            type: 'integer',
            description: '从 1 开始的序号，按原文出现顺序递增。',
          },
          weekLabel: {
            type: ['string', 'null'],
            description: '周次或章节标签，如 "Week 3"、"Ch. 5"。原文没标注时填 null。',
          },
          topic: { type: 'string', description: '该周次/章节的主题。' },
          sourceExcerpt: EXCERPT,
        },
        required: ['orderIndex', 'weekLabel', 'topic', 'sourceExcerpt'],
      },
    },
  },
  required: ['items'],
} as const

export const TEST_DATES_SCHEMA = {
  type: 'object',
  properties: {
    exams: {
      type: 'array',
      description: '考试、测验、期中和期末考试。只列有明确名称的考核；没有考试安排时返回空数组。',
      items: {
        type: 'object',
        properties: {
          examName: { type: 'string', description: '考试名称，如 Midterm 1、Final Exam。' },
          examDate: {
            type: ['string', 'null'],
            description: 'ISO 日期 YYYY-MM-DD。年份按课程所属学期推断。**日期不明时填 null，绝不猜测。**',
          },
          examTime: {
            type: ['string', 'null'],
            description: '时间区间或时刻，尽量保留原文写法，如 "7-9pm"。没有就填 null。',
          },
          location: {
            type: ['string', 'null'],
            description: '考场地点。没有就填 null。',
          },
          sourceExcerpt: EXCERPT,
        },
        required: ['examName', 'examDate', 'examTime', 'location', 'sourceExcerpt'],
      },
    },
  },
  required: ['exams'],
} as const

export const OFFICE_HOURS_SCHEMA = {
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      description:
        'Office hour 时段。同一人每周多次、或不同人分别值班，各占一条。没有就返回空数组。',
      items: {
        type: 'object',
        properties: {
          personName: {
            type: 'string',
            description: '值班人姓名，如 Prof. Douskey、TA Jane Doe。',
          },
          dayOfWeek: {
            type: ['string', 'null'],
            description: '星期，英文如 "Tuesday"。每周多天时用逗号连接。没有就填 null。',
          },
          startTime: {
            type: ['string', 'null'],
            description: '开始时间，规整为 24 小时制 HH:MM；无法可靠转换时保留原文。没有就填 null。',
          },
          endTime: {
            type: ['string', 'null'],
            description: '结束时间，规整为 24 小时制 HH:MM；无法可靠转换时保留原文。没有就填 null。',
          },
          location: {
            type: ['string', 'null'],
            description: '办公室地点或线上会议链接。没有就填 null。',
          },
          sourceExcerpt: EXCERPT,
        },
        required: ['personName', 'dayOfWeek', 'startTime', 'endTime', 'location', 'sourceExcerpt'],
      },
    },
  },
  required: ['sessions'],
} as const

export const SUBMISSION_POLICY_SCHEMA = {
  type: 'object',
  properties: {
    policies: {
      type: 'array',
      description: '作业提交方式的规定。同一份 syllabus 里针对不同作业的规定各占一条。没有就返回空数组。',
      items: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '提交方式的说明，如"作业须在截止前通过 Gradescope 上传 PDF"。',
          },
          platformName: {
            type: ['string', 'null'],
            description: '涉及平台名，如 Gradescope、bCourses、Piazza。没有就填 null。',
          },
          sourceExcerpt: EXCERPT,
        },
        required: ['description', 'platformName', 'sourceExcerpt'],
      },
    },
  },
  required: ['policies'],
} as const
