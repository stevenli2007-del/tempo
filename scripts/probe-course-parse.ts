/**
 * P0-3-24 **在线探针**：把真实课程原文喂给**线上同款** prompt + schema，再用**真校验器**验收输出。
 *
 * 运行：`npm run probe:course-parse`
 *
 * ### 为什么必须有这个脚本（而不是"本地看一遍模型输出"）
 * 本卡改动的是 prompt 与 schema，`tsc`/`eslint`/`build` 全绿**完全不能证明它有用**：
 * 产出通道接得对不对，只有真模型 + 真校验器跑一遍才知道。
 * 而且这里**不重新实现任何判定** —— 直接 import：
 * - `COURSE_UPDATE_SYSTEM_PROMPT` / `COURSE_UPDATE_PROMPT_VERSION`（端点用的同一份 prompt）
 * - `COURSE_UPDATE_PARSE_SCHEMA`（端点用的同一份 schema）
 * - `validateExamInput` / `validateGradeComponentInput` / `validateApplyBody`（写入前的同一道闸）
 * - `weightWarnings`（合计算法的同一份实现）
 * 手抄一份"差不多的"逻辑进脚本，就是在制造"脚本绿了、线上挂了"的分叉。
 *
 * ### 两个样本都是 Steven 的真课原文（不是构造的）
 * ① **Galen 公告（Canvas）**：「quizzes on the following Fridays: 9/4, 9/18, 10/16, 10/30,
 *    11/20, 12/4」→ 期望 6 条 exam，日期全中、每条带 excerpt。
 *    这是 ADR-021 里"编排不出考试不是模型不行、是一条 prompt 在拦"的原案。
 * ② **Math 53 课程网页**（`course_mechanics.html` + `exams_and_grading.html`）：
 *    「Homework/Quizzes: 10%, Each Midterm: 30%, Final: 30%」+ 两场 midterm（Oct 1st / Nov 5th）
 *    + Final（Dec 16 3-6pm）→ 期望成绩构成拆成 4 条（Each Midterm 拆两条）。
 *
 * 需要出网 + `.env.local` 里的 `LLM_PROVIDER_TEXT`（默认 DeepSeek）key。
 * **有副作用吗**：没有。`record: false` 不写 `llm_runs`；本脚本不连数据库、不写任何表。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runStructured } from '@/lib/llm/run'
import {
  COURSE_UPDATE_PARSE_SCHEMA,
  validateApplyBody,
  validateExamInput,
  validateGradeComponentInput,
} from '@/lib/course-update/normalize'
import {
  COURSE_UPDATE_PROMPT_VERSION,
  buildCourseUpdateMessages,
} from '@/lib/course-update/prompt'
import { weightWarnings } from '@/lib/course-update/weights'

const here = path.dirname(fileURLToPath(import.meta.url))

/** tsx 不自动加载 .env.local（那是 Next 的特权），与 regress-course-outline.ts 同一手法。 */
function loadEnvLocal(): void {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(here, '..', name)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}

type Sample = {
  name: string
  /** 原文出处（写进报告，方便 Steven 回原文对账）。 */
  source: string
  text: string
  /** 必须全部出现的日期（exam_date，YYYY-MM-DD）。 */
  expectDates?: string[]
  /** 期望的成绩构成条数。 */
  expectGradeCount?: number
  /** 期望的成绩构成合计（按 manual 分组）。 */
  expectGradeTotal?: number
}

const SAMPLES: Sample[] = [
  {
    name: "① Galen Quiz Dates（Canvas 公告）",
    source: 'Canvas 公告 · Math 53 GSI',
    text: `Quiz dates — the quizzes will be held on the following Fridays: 9/4, 9/18, 10/16, 10/30, 11/20, 12/4. All quizzes are held in section, in the usual room.`,
    expectDates: [
      '2026-09-04',
      '2026-09-18',
      '2026-10-16',
      '2026-10-30',
      '2026-11-20',
      '2026-12-04',
    ],
  },
  {
    name: '② Math 53 成绩构成 + 考试（课程网页）',
    source: 'math.berkeley.edu/~sethian/math53_fall26.html → course_mechanics.html + exams_and_grading.html',
    text: `The grade breakdown is: Homework/Quizzes: 10%, Each Midterm: 30%, Final: 30%.
There will be two midterms, on Oct 1st and Nov 5th, held in class.
The Final Exam is on Dec 16, 3-6pm; location to be announced.`,
    expectGradeCount: 4,
    expectGradeTotal: 100,
  },
]

type Parsed = {
  tasks: Array<{ title: string; taskType: string; dueDate: string | null; notes: string | null }>
  exams: Array<Record<string, unknown>>
  gradeComponents: Array<Record<string, unknown>>
  warnings: string[]
}

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function main(): Promise<void> {
  loadEnvLocal()
  console.log(`prompt 版本：${COURSE_UPDATE_PROMPT_VERSION}\n`)

  for (const sample of SAMPLES) {
    console.log(`${sample.name}`)
    console.log(`  出处：${sample.source}`)

    const result = await runStructured<Parsed>({
      userId: 'probe-local',
      purpose: 'probe_course_parse',
      promptVersion: COURSE_UPDATE_PROMPT_VERSION,
      record: false,
      schema: COURSE_UPDATE_PARSE_SCHEMA,
      schemaName: 'CourseUpdateParse',
      messages: buildCourseUpdateMessages(sample.text),
      temperature: 0,
    })

    if (!result.ok) {
      failed += 1
      console.error(`  ✗ 模型调用失败：${result.error.code} — ${result.error.message}\n`)
      continue
    }

    const parsed = result.data
    console.log(`  模型返回：${parsed.exams.length} exam / ${parsed.gradeComponents.length} 构成 / ${parsed.tasks.length} task / ${parsed.warnings.length} warning`)

    // ---- 过真校验器（这一步才是"能不能写进库"的判据）----
    const exams: Array<{ examName: string; examDate: string | null; examTime: string | null; location: string | null; sourceExcerpt: string }> = []
    let examRejected = 0
    for (const raw of parsed.exams) {
      const valid = validateExamInput(raw)
      if (valid.ok) exams.push(valid.value)
      else {
        examRejected += 1
        console.error(`    ! 被校验器拒收：${valid.message}`)
      }
    }

    const grades: Array<{ name: string; weightPercent: number | null; notes: string | null; sourceExcerpt: string }> = []
    let gradeRejected = 0
    for (const raw of parsed.gradeComponents) {
      const valid = validateGradeComponentInput(raw)
      if (valid.ok) grades.push(valid.value)
      else {
        gradeRejected += 1
        console.error(`    ! 被校验器拒收：${valid.message}`)
      }
    }

    check('模型产出的 exam 全部通过校验器', examRejected === 0, `${examRejected} 条被拒`)
    check('模型产出的成绩构成全部通过校验器', gradeRejected === 0, `${gradeRejected} 条被拒`)
    check(
      '每条 exam 都带原文摘录（ADR-021 的解禁对价）',
      exams.length === 0 || exams.every((e) => e.sourceExcerpt.trim() !== ''),
    )

    for (const exam of exams) {
      console.log(
        `    · ${exam.examName} | ${exam.examDate ?? 'TBD'} | ${exam.examTime ?? '-'} | 原文: ${exam.sourceExcerpt.slice(0, 60)}`,
      )
    }
    for (const grade of grades) {
      console.log(
        `    · ${grade.name} | ${grade.weightPercent === null ? '未标占比' : `${grade.weightPercent}%`} | 原文: ${grade.sourceExcerpt.slice(0, 50)}`,
      )
    }

    if (sample.expectDates) {
      const got = new Set(exams.map((e) => e.examDate))
      const missing = sample.expectDates.filter((d) => !got.has(d))
      check(
        `${sample.expectDates.length} 个日期全对`,
        missing.length === 0,
        missing.length > 0 ? `缺 ${missing.join(', ')}` : undefined,
      )
      check(
        `exam 条数与期望一致（${sample.expectDates.length}）`,
        exams.length === sample.expectDates.length,
        `实际 ${exams.length}`,
      )
    }

    if (sample.expectGradeCount !== undefined) {
      check(
        `成绩构成拆成 ${sample.expectGradeCount} 条`,
        grades.length === sample.expectGradeCount,
        `实际 ${grades.length}`,
      )
    }

    if (sample.expectGradeTotal !== undefined) {
      const warnings = weightWarnings(
        grades.map((g) => ({ source: 'manual', weightPercent: g.weightPercent })),
      )
      check(
        `合计 = ${sample.expectGradeTotal}%（无缺口报警）`,
        warnings.length === 0,
        warnings.join(' | '),
      )
    }

    // ---- 整批走一次写入前的闸：证明解析结果能直接进 `POST /api/v1/course-updates` ----
    const body = validateApplyBody({
      courseId: '11111111-2222-4333-8444-555555555555',
      exams,
      gradeComponents: grades,
    })
    check('整批请求体通过写入闸（可直送确认端点）', body.ok, body.ok ? undefined : body.message)

    console.log('')
  }

  console.log(`结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
