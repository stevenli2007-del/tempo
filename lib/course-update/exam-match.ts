/**
 * 考试改期的**匹配判定层**（P0-3-29）—— 纯函数、零依赖。
 *
 * ### 它解决什么
 * 老师说「Midterm 1 改期到 9/27」，而库里已有一条 syllabus 抽出来的 `Midterm 1 · 9/28`。
 * 写入器（`lib/course-update/apply.ts`）原先**只 insert 不查重**，于是两条并存，
 * 用户看不出哪条是真的。本模块在**写之前**回答一个问题：
 * 这条输入应当落到哪一行？
 *
 * ### 🔴 三条红线
 * 1. **匹配只在同课程内做** —— 调用方传进来的 `existing` 必须是**那一门课**的行，
 *    本模块绝不接受"全部考试再按 course_id 过滤"（漏掉过滤就是跨课串数据）。
 *    判据是**考试名归一**（小写、去标点与空格）：`Midterm1` ≡ `Midterm 1`。
 * 2. **同义折叠只做一对**：`test` ≡ `exam`（口语里同指一场考试，2026-09-19 实测：
 *    「Unit 1 test 改期」指的是库里那条 `Unit 1 Exam`）。除此之外**绝不做语义别名推断**
 *    —— 不许自己得出 `Unit 1 Exam` ≡ `Midterm 1` 或 `Quiz 1` ≡ `Exam 1`。
 *    猜错的代价（把 A 场考试的日期写到 B 场上）远大于不猜（多一条待确认的提案）。
 * 3. **多命中 = 不猜**。同课程有 2 条同名时返回 `ambiguous` 并把候选列出来让人挑，
 *    绝不自动选第一条。
 *
 * ### 为什么不放在 `apply.ts` 里
 * 三个调用方要**同一份**判定：① 写入器（确认时）；② 公告的懒补（打开消息栏时，
 * 要让用户在点确认**之前**看到 9/28 → 9/27）；③ 对话框的预览（客户端）。
 * 三处各写一遍就会变成 P0-3-15 那种"两处都绿、肉眼才看得出"的分叉。
 * 而且它是纯的 —— `scripts/regress-course-updates.ts` 可以直接断言，无需数据库。
 *
 * 注：本文件原为「零 import」；i18n 只引入了同仓的纯函数字典（无第三方包），
 * 不破坏「零外部依赖」的约束。
 */
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'

/** 一条待写入的考试（只要匹配用得到的那几个字段）。 */
export type ExamMatchInput = {
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
  /**
   * 用户在对话框里**显式指定**的目标行（P0-3-29 的"列出来让人挑"）。
   * - `undefined` = 没挑过 → 由本模块按名字解析；
   * - `null` = 明确要"新建一条"（即便有同名行）→ 强制 `create`；
   * - 字符串 = 明确要改这一条 → 强制 `update`（找不到就是 `missing`）。
   */
  targetExamId?: string | null
}

/** 库里已有的一行考试（匹配目标）。 */
export type ExamRowRef = {
  id: string
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
}

/**
 * 解析结果。
 *
 * | kind | 含义 | 写入器做什么 |
 * |---|---|---|
 * | `create` | 这门课没有同名考试 | insert |
 * | `update` | 唯一命中 → **改期** | update 那一行 + 留旧值快照 |
 * | `duplicate` | 命中且值完全一样（或本批已有一条落到它） | 不写，回执点名 |
 * | `ambiguous` | 同名多行，**或** 同一天已有考试可能是同一场 | 不写，列出来让人挑 |
 * | `unidentifiable` | 名字不可辨识（只写了「考试」这类通称）且该课已有考试 | 不写，让人指定 |
 * | `missing` | 指定了目标行但它不在（已删 / 不属于这门课） | 不写，回执点名 |
 */
export type ExamResolutionKind =
  | 'create'
  | 'update'
  | 'duplicate'
  | 'ambiguous'
  | 'unidentifiable'
  | 'missing'

export type ExamResolution = {
  exam: ExamMatchInput
  kind: ExamResolutionKind
  /** `update` / `duplicate` 时命中的那一行；其余为 null。 */
  target: ExamRowRef | null
  /** `ambiguous` / `unidentifiable` 时供人挑选的候选（`unidentifiable` 是这门课全部考试）。 */
  candidates: ExamRowRef[]
  /** 不写的原因（人话，直接进回执）。`create` / `update` 时为 null。 */
  reason: string | null
}

/**
 * 考试名归一：小写 + 词级切分 + `test ≡ exam` 同义折叠 + 拼接（切分即去掉标点空格）。
 *
 * 于是 `Midterm 1` ≡ `Midterm1` ≡ `midterm-1` ≡ `MIDTERM 1`，
 * 且 `Unit 1 test` ≡ `Unit 1 Exam`（唯一一对同义折叠 —— 口语里 test 和 exam 同指
 * 一场 Summative；词级替换，"protest" 这类内嵌子串不受影响）。
 *
 * ⚠️ 刻意**不**做更多折叠：`quiz` / `midterm` / `final` 是**不同的考试类型**，
 * 不与 `exam` 互折 —— 否则 `Midterm 1` 与 `Exam 1` 会撞成同一个键，
 * 那是把两场不同的考试当成一场，比多出一条待确认的提案危险得多。
 */
export function normalizeExamName(name: string): string {
  // 分隔符 = 允许字符（字母数字 + CJK，含日文假名）的补集；切完折叠再拼回。
  return name
    .toLowerCase()
    .split(/[^a-z0-9\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff]+/)
    .map((token) => (token === 'test' || token === 'tests' ? 'exam' : token))
    .join('')
}

/**
 * 通称词（按长度倒序 —— 先删长的，否则 `quizzes` 会被 `quiz` 先切一刀，
 * 剩下 `zes` 就被误判成"可辨识"）。
 */
const GENERIC_TOKENS = [
  '期末考试',
  '期中考试',
  '期中测验',
  '期末测验',
  'quizzes',
  'midterms',
  'finals',
  'exams',
  'tests',
  'midterm',
  'final',
  'exam',
  'test',
  'quiz',
  '考试',
  '测验',
  '期中',
  '期末',
  '小测',
  '月考',
]

/**
 * 这个名字**不可辨识**吗（只由通称词构成，如「the exam」「考试」）。
 *
 * ⚠️ 只用于"能不能新增"的判断，**绝不用于匹配**（见 `normalizeExamName` 的注释）：
 * 把 `Exam 1` 与 `Midterm 1` 都归成 `1` 会让两场不同的考试互相覆盖。
 */
export function isGenericExamName(name: string): boolean {
  const key = normalizeExamName(name)
  if (key === '') return true
  // 英语冠词：'the exam' 与 'exam' 同样不可辨识。
  let rest = key.replace(/^(the|a|an)/, '')
  for (const token of GENERIC_TOKENS) {
    rest = rest.split(token).join('')
  }
  return rest === ''
}

/** 四个可写字段完全一致 → "已经是这样了"，没必要写。 */
function sameSchedule(exam: ExamMatchInput, row: ExamRowRef): boolean {
  return (
    exam.examDate === row.examDate &&
    (exam.examTime ?? null) === (row.examTime ?? null) &&
    (exam.location ?? null) === (row.location ?? null)
  )
}

/**
 * 解析一批输入落到哪一行。
 *
 * ### 批内占位
 * 同一批里两条输入命中同一行（如正文里两次提到 Midterm 1）→ 第二条判 `duplicate`，
 * 否则会把同一行连写两次、第二次的旧值快照覆盖第一次的（撤销只能还原到中间态）。
 *
 * ### 名字不可辨识时为什么还要看"这门课有没有考试"
 * 一门课一条考试都没有时，「考试改到 9/27」指的是唯一那一场，新增是安全的；
 * 已经有 3 场时它指哪一场是未知的 —— 这时候悄悄新增就是制造一条假数据。
 */
export function resolveExamTargets(
  exams: ExamMatchInput[],
  existing: ExamRowRef[],
): ExamResolution[] {
  const byName = new Map<string, ExamRowRef[]>()
  for (const row of existing) {
    const key = normalizeExamName(row.examName)
    // 空名（脏数据）不进索引：它没有可匹配的字面，留着只会误吞"名字为空的输入"。
    if (key === '') continue
    const bucket = byName.get(key)
    if (bucket) bucket.push(row)
    else byName.set(key, [row])
  }

  const claimed = new Set<string>()
  const results: ExamResolution[] = []

  for (const exam of exams) {
    // ---------- 用户显式指定：不解析，直接照办 ----------
    if (exam.targetExamId === null) {
      results.push({ exam, kind: 'create', target: null, candidates: [], reason: null })
      continue
    }
    if (typeof exam.targetExamId === 'string') {
      const row = existing.find((item) => item.id === exam.targetExamId)
      if (!row) {
        results.push({
          exam,
          kind: 'missing',
          target: null,
          candidates: [],
          reason: '你指定的那场考试已经不在了（可能被删或属于别的课），未写入',
        })
        continue
      }
      // 同一行被本批前面的条目占了 → 不重复写。
      if (claimed.has(row.id)) {
        results.push({
          exam,
          kind: 'duplicate',
          target: row,
          candidates: [],
          reason: '本批已有一条落到这一行，未重复写入',
        })
        continue
      }
      claimed.add(row.id)
      results.push({ exam, kind: 'update', target: row, candidates: [], reason: null })
      continue
    }

    // ---------- 按名字解析 ----------
    const matches = byName.get(normalizeExamName(exam.examName)) ?? []

    if (matches.length === 1) {
      const row = matches[0]
      if (claimed.has(row.id)) {
        results.push({
          exam,
          kind: 'duplicate',
          target: row,
          candidates: [],
          reason: '本批已有一条落到这一行，未重复写入',
        })
        continue
      }
      if (sameSchedule(exam, row)) {
        results.push({
          exam,
          kind: 'duplicate',
          target: row,
          candidates: [],
          reason: '这门课已经有一条一模一样的，未重复写入',
        })
        continue
      }
      claimed.add(row.id)
      results.push({ exam, kind: 'update', target: row, candidates: [], reason: null })
      continue
    }

    if (matches.length > 1) {
      results.push({
        exam,
        kind: 'ambiguous',
        target: null,
        candidates: matches,
        reason: `这门课有 ${matches.length} 条同名考试，Tempo 不替你猜是哪一场`,
      })
      continue
    }

    // 0 命中：新增 —— 但名字不可辨识时不许悄悄加。
    if (isGenericExamName(exam.examName) && existing.length > 0) {
      results.push({
        exam,
        kind: 'unidentifiable',
        target: null,
        candidates: existing,
        reason: '没说清是哪一场（只写了「考试」这类通称），疑似与已有考试重复 —— 请指定一场',
      })
      continue
    }

    // ---------- P0-3-36：0 命中、但**同一天**这门课已有考试 → 不许静默新增 ----------
    //
    // 名字对不上不代表不是同一场：老师的座位公告写「明天晚上的 Chem 1A exam」，
    // 库里那条叫 `Unit 1 Exam` —— 归一后对不上，按老规则就判 create，
    // 于是同一场考试变成两行（复习页显示 5 场，实际 4 场）。
    // 🔴 这里**仍然不猜**：同日命中 1 条也不自动 update ——
    // 「同一天考两场不同的考试」是可能的（上午 quiz + 晚上 exam），
    // 自动覆盖的代价（把 A 场的日期/地点写到 B 场上）远大于让人点一下。
    const sameDay =
      exam.examDate === null
        ? []
        : existing.filter((row) => row.examDate === exam.examDate && !claimed.has(row.id))
    if (sameDay.length > 0) {
      results.push({
        exam,
        kind: 'ambiguous',
        target: null,
        candidates: sameDay,
        reason: `这门课 ${exam.examDate} 已有一场考试（${sameDay[0]!.examName}），可能是同一场 —— Tempo 不替你猜，请指定要改哪一条，或新增一条`,
      })
      continue
    }

    results.push({ exam, kind: 'create', target: null, candidates: [], reason: null })
  }

  return results
}

/**
 * 一行考试的人话标签（`Midterm 1 · 2026-09-28 · 7-9pm`）。
 *
 * 服务端（回执 / 提案文案）与客户端（候选下拉）共用它 —— 两处各拼一遍就会出现
 * "消息栏说 9/28、对话框说 2026-09-28" 这种不一致。
 */
export function examScheduleLabel(input: {
  examName?: string | null
  examDate: string | null
  examTime?: string | null
  location?: string | null
  lang?: Lang
}): string {
  const bits: string[] = []
  if (input.examName) bits.push(input.examName)
  bits.push(input.examDate ?? t(input.lang ?? 'zh', 'exam.tbd'))
  if (input.examTime) bits.push(input.examTime)
  if (input.location) bits.push(input.location)
  return bits.join(' · ')
}

/** 改期的那句人话（`Midterm 1 2026-09-28 · 7-9pm → 2026-09-27 · 7-9pm`）。 */
export function examChangeLabel(exam: ExamMatchInput, target: ExamRowRef): string {
  const before = examScheduleLabel({
    examDate: target.examDate,
    examTime: target.examTime,
    location: target.location,
  })
  const after = examScheduleLabel({
    examDate: exam.examDate,
    examTime: exam.examTime,
    location: exam.location,
  })
  return `${exam.examName} ${before} → ${after}`
}
