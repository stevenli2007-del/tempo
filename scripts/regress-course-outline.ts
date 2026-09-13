/**
 * P0-3-4 回归：courseOutline 对任意顺序标签（L / W / 讲 / 日期 / 混排）都能抽出，
 * 不再整块漏掉。
 *
 * 运行：`npm run regress`（会自动加载 .env.local 里的 LLM key；另需出网才能真调 DeepSeek）
 * 它会遍历 `lib/parse/fixtures/*.txt`，对每份 syllabus 只调 courseOutline 这一个板块，
 * 断言抽到的条目数 > 0，且期望的关键标签（如 "L1"、"第1讲"）出现在结果里。
 *
 * 设计要点：
 * - 只测 courseOutline，不跑其他四个板块，省 token、快。
 * - 核心断言是「条目数 > 0」——P0-3-4 的 bug 表现就是整块抽空（0 条）。
 * - 关键标签断言用来证明不是「抽了但认错格式」。
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runStructured } from '@/lib/llm/run'
import { COURSE_OUTLINE_SCHEMA } from '@/lib/parse/schemas'
import { buildSectionInstruction } from '@/lib/parse/prompts'
import { PROMPT_VERSION } from '@/lib/parse'
import type { CourseOutlineItem } from '@/types/parse'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(here, '..', 'lib', 'parse', 'fixtures')

/** 每个 fixture 期望在抽取结果里出现的关键标签（验证没漏抽、也没认错格式）。
 *  注意：标签必须是 fixture 文本里**真实存在**的——chem1a 的清理版只到 L34，
 *  所以取 L1 / L11 / L34（首+中+末），而不是 syllabus 里提到的 L40。 */
const EXPECTED: Record<string, string[]> = {
  'chem1a-lecture-L.txt': ['L1', 'L11', 'L34'],
  'course-week-W.txt': ['Week 1', 'Week 14'],
  'course-chinese-lecture.txt': ['第1讲', '第14讲'],
  'course-dated-mixed.txt': ['Jan 15', 'May 6'],
}

type OutlineResult = { items: CourseOutlineItem[] }

/**
 * tsx 不会自动加载 .env.local（那是 Next 的特权），但脚本需要 DEEPSEEK_API_KEY。
 * 这里手动解析 .env.local（找不到就退而求其次 .env），在调 LLM 之前把变量塞进 process.env。
 * 已存在的真实环境变量优先、不被覆盖；值去首尾引号。
 */
function loadEnvLocal(): void {
  const candidates = ['.env.local', '.env']
  for (const name of candidates) {
    const p = path.join(here, '..', name)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const line of text.split('\n')) {
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

async function main(): Promise<void> {
  loadEnvLocal()
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.txt'))
  let failed = 0

  for (const file of files.sort()) {
    const rawText = await readFile(path.join(FIXTURE_DIR, file), 'utf8')

    const result = await runStructured<OutlineResult>({
      userId: 'regression-local',
      purpose: 'regression_outline',
      promptVersion: PROMPT_VERSION,
      syllabusId: null,
      record: false,
      schema: COURSE_OUTLINE_SCHEMA,
      schemaName: 'CourseOutline',
      messages: [
        { role: 'system', content: buildSectionInstruction('courseOutline', {}) },
        { role: 'user', content: rawText },
      ],
    })

    if (!result.ok) {
      console.log(`FAIL  ${file}  -> LLM error: ${result.error.message}`)
      failed++
      continue
    }

    const items = result.data.items ?? []
    const labels = items.map((i) => i.weekLabel).filter((l): l is string => Boolean(l))
    const want = EXPECTED[file] ?? []
    const missing = want.filter((w) => !labels.includes(w))

    if (items.length === 0) {
      console.log(`FAIL  ${file}  -> 0 items extracted (whole block dropped)`)
      failed++
    } else if (missing.length > 0) {
      console.log(
        `FAIL  ${file}  -> ${items.length} items, but missing expected labels: ${missing.join(', ')}`,
      )
      failed++
    } else {
      console.log(`PASS  ${file}  -> ${items.length} items; sample labels: ${labels.slice(0, 3).join(' / ')}`)
    }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS ✅' : `${failed} FAILED ❌`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
