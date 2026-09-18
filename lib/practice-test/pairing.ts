/**
 * 「这份 past exam 的 answer key 是哪一份」的**纯判定**（P0-3-23）。
 *
 * ### 🔴 这个文件必须保持零依赖
 * 判定要被回归脚本（`scripts/regress-practice-tests.ts`）直接 import 断言，
 * 也要被**客户端组件链**间接引用（卷面里要显示「答案来自哪一份」）。
 * 一旦 import 任何服务端模块（`lib/supabase/server` → `next/headers`），
 * 脚本跑不起来、构建期还会把 `next/headers` 拖进客户端图（3-25 踩过的同一个坑）。
 * 所以这里**连 type-only import 都没有**。
 *
 * ### 为什么要自动配对（而不是让用户在两份目录里翻）
 * 实测（2026-09-18 真账号）两类课的答案文件放法完全不同：
 *
 * | 课 | 试卷 | 答案 key | 形态 |
 * |---|---|---|---|
 * | Chem 1A | `Practice Exams/Unit 1 Exam/PracticeMidterm1_F23.pdf` | `Practice Exams/Unit 1 Exam/Answer Keys/PracticeMidterm1KEY_F23.pdf` | **子目录** `Answer Keys` |
 * | Math 53 Discussion | `FA 23 Quiz/53_Fall_23_Quiz_2.pdf` | `FA 23 Quiz Solution/53_Fall_23_Quiz_2.pdf` | **兄弟目录** + **同名文件** |
 *
 * 让用户自己去找，等于把"老师怎么放文件"这件事摊给他 —— 而这是**可以从文件名与目录推出来的**，
 * 零 LLM、零成本、可解释。配错了也看得见（页面显示配到哪一份，且能换）。
 *
 * ### 🔴 全部规则的共同前提：去掉 KEY 词之后名字必须一样
 * 没有这一条，`same-stem-anywhere`（兜底）会退化成"随便挑一个答案文件"——
 * 那比不配更坏：**配错答案会让用户背下一份错的答案**。
 * 所以下面 `rankKeyCandidates()` 第一件事就是比 `normalizeStem()`，不相等直接跳过。
 */

/** 配对涉及的**最小文件形状**（不依赖 `course_files` 的行结构，纯数据）。 */
export type PairingFile = {
  id: string
  displayName: string
  /** Canvas 相对路径，空串 = 课程文件根目录。 */
  folderPath: string
}

/**
 * 命中的规则。**顺序即优先级**（值越大越可信），见 `RULE_RANK`。
 *
 * - `answer-key-folder`：答案在试卷**子目录**里，且那个目录名是 key 味道的（Chem 1A）
 * - `solution-folder`：答案在**兄弟目录**里，且文件名与试卷**逐字相同**（Math 53）
 * - `same-folder-key-name`：答案与试卷**同一个文件夹**，名字带 KEY / Answer
 * - `same-stem-anywhere`：整门课范围内去掉 KEY 词后同名（兜底）
 */
export type PairingRule =
  | 'answer-key-folder'
  | 'solution-folder'
  | 'same-folder-key-name'
  | 'same-stem-anywhere'

export const PAIRING_RULE_LABELS: Record<PairingRule, string> = {
  'answer-key-folder': '试卷所在文件夹的子目录（Answer Keys）里同名的那份',
  'solution-folder': '与试卷所在文件夹同级、目录名含 Solution 的那份',
  'same-folder-key-name': '同一个文件夹里名字带 KEY / Answer 的那份',
  'same-stem-anywhere': '这门课里去掉 KEY 后与试卷同名的那份',
}

/** 出现这些词就说明"这是答案/解答"，不是试卷本身。 */
const KEY_WORDS = new Set([
  'key',
  'keys',
  'answer',
  'answers',
  'ans',
  'solution',
  'solutions',
  'soln',
  'sol',
])

/** 出现这些词就说明"这是一份要做的卷子"（用于决定资料区那一行要不要出「自测卷」按钮）。 */
const EXAM_WORDS = new Set([
  'exam',
  'exams',
  'midterm',
  'midterms',
  'final',
  'finals',
  'quiz',
  'quizzes',
  'test',
  'tests',
  'practice',
  'review',
  'mock',
  'past',
  'prelim',
  'prelims',
])

/**
 * 剥扩展名。
 *
 * ⚠️ **只在"看起来真像后缀"时才剥**：`Unit 3.2 Quiz` 的点后面是 `2 Quiz`（带空格），
 * 那不是后缀；把它当后缀会把展示名截成 `Unit 3`，两组名字就再也配不上了。
 * 实测库里还有 `Weekly Review 1 - PDF` 这种**根本没有点**的名字（`content_type` 才是 PDF），
 * 所以这里也不能假设一定有点可剥。
 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return name
  const ext = name.slice(dot + 1)
  if (!/^[a-z0-9]{1,6}$/i.test(ext)) return name
  return name.slice(0, dot)
}

/**
 * 把名字切成小写词元。
 *
 * ### 为什么不能只按非字母数字切
 * Chem 1A 的答案文件叫 `PracticeMidterm1KEY_F23.pdf` —— `KEY` 是**粘在** `Midterm1` 后面的，
 * 按非字母数字切只会得到 `practicemidterm1key` 一整个词，`key` 永远去不掉。
 * 所以要先在**驼峰**与**字母↔数字**边界上补空格：
 *
 * - `PracticeMidterm1KEY_F23` → `Practice Midterm 1 KEY F 23` → `[practice, midterm, 1, key, f, 23]`
 * - `PracticeMidterm1_F23`    → `Practice Midterm 1 F 23`     → `[practice, midterm, 1, f, 23]`
 *
 * 两者去掉 `key` 之后**完全相同** —— 配对就靠这一点。
 */
export function tokenizeName(name: string): string[] {
  const stem = stripExtension(name)
  const spaced = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')

  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '')
}

/**
 * 名字里去掉 KEY 词之后的**指纹**。两份文件的指纹相同 ⇒ 它们是同一份卷子的"题"与"答"。
 * 指纹为空（名字整一个就是 `Key`）时调用方必须放弃配对，否则会把所有答案文件都算成候选。
 */
export function normalizeStem(name: string): string {
  return tokenizeName(name)
    .filter((token) => !KEY_WORDS.has(token))
    .join('')
}

/** 这个**文件名**本身是不是答案/解答。 */
export function isKeyLikeName(name: string): boolean {
  return tokenizeName(name).some((token) => KEY_WORDS.has(token))
}

/** 这个**文件夹路径**里有没有一段是答案目录（`.../Answer Keys`、`FA 23 Quiz Solution`）。 */
export function isKeyLikePath(folderPath: string): boolean {
  return folderPath
    .split('/')
    .some((segment) => segment.trim() !== '' && isKeyLikeName(segment))
}

/**
 * 这份文件像不像"一份要做的卷子"。
 *
 * ### 🔴 这是个**关键词启发式**，所以两条纪律
 * 1. **宁可少显示**：只有像试卷的文件才出「自测卷」按钮。一个点了只会被拒的按钮，
 *    比没有按钮更糟（3-19b 对「一键总结」定下的同一条）。
 * 2. **答案文件永远不出按钮** —— 拿答案 key 去"出卷子"是没有意义的
 *    （那道题的答案就是……它自己）。所以 key 味道的名字/目录直接返回 false。
 *
 * ⚠️ 已知的**误判**（刻意接受，靠生成侧如实报错兜住）：
 * `Exam1EquationSheet.pdf` 落在 `Practice Exams/Unit 1 Exam` 里 → 会被判成像试卷，
 * 点进去后模型切不出题目 → 页面如实说「这份材料里没找到成题的题目」。
 * 反过来（漏判）比误判难查得多，所以关键词表刻意取得宽（含 `practice` / `review`）。
 */
export function isExamLike(file: PairingFile): boolean {
  if (isKeyLikeName(file.displayName)) return false
  if (isKeyLikePath(file.folderPath)) return false

  const nameTokens = tokenizeName(file.displayName)
  const pathTokens = file.folderPath
    .split('/')
    .flatMap((segment) => tokenizeName(segment))

  return [...nameTokens, ...pathTokens].some((token) => EXAM_WORDS.has(token))
}

/** 规则可信度。数值只用于排序，不落库（落库的是 `pairing_rule` 字面量）。 */
const RULE_RANK: Record<PairingRule, number> = {
  'answer-key-folder': 4,
  'solution-folder': 3,
  'same-folder-key-name': 2,
  'same-stem-anywhere': 1,
}

/** 取父路径。`FA 23 Quiz` → `''`（课程文件根目录），`A/B` → `A`。 */
function parentPath(folderPath: string): string {
  const index = folderPath.lastIndexOf('/')
  return index === -1 ? '' : folderPath.slice(0, index)
}

/** `candidate` 是不是 `examFolder` 的**后代**目录里的文件（根目录时任何非根目录都算）。 */
function isInsideFolder(candidateFolder: string, examFolder: string): boolean {
  if (candidateFolder === examFolder) return false
  if (examFolder === '') return candidateFolder !== ''
  return candidateFolder.startsWith(`${examFolder}/`)
}

export type RankedKey<T extends PairingFile = PairingFile> = {
  file: T
  rule: PairingRule
}

/**
 * 把候选答案文件按可信度排序（**最佳在前**）。
 *
 * 泛型 `<T>` 不是装饰：调用方传进来的是 `course_files` 的行（多了 `canvasFileId` /
 * `modifiedAt` 等字段），配完还要拿这些字段去下载 —— 返回 `PairingFile` 的话
 * 调用方就得再做一次查表把字段找回来（那正是"配到的"与"要下载的"可能对不上的缝）。
 *
 * 排序的第二个键是"名字更短"、第三个是展示名序 —— 两个都是为了让结果**可复现**：
 * 同样的输入必须永远得到同一个答案，否则"今天配到 A、明天配到 B"会让用户彻底失去信任。
 */
export function rankKeyCandidates<T extends PairingFile>(
  exam: PairingFile,
  candidates: readonly T[],
): RankedKey<T>[] {
  const examStem = normalizeStem(exam.displayName)
  // 指纹为空 = 这份文件的名字整一个就是 `Key`/`Solution` 之类，没有可比的实质内容。
  // 这时**不配对**（配中也只是巧合）。
  if (examStem === '') return []

  const examParent = parentPath(exam.folderPath)
  const examName = exam.displayName.trim().toLowerCase()

  const ranked: RankedKey<T>[] = []
  for (const candidate of candidates) {
    if (candidate.id === exam.id) continue
    // 🔴 共同前提：去掉 KEY 词之后必须同名（见文件头）。
    if (normalizeStem(candidate.displayName) !== examStem) continue

    const sameFolder = candidate.folderPath === exam.folderPath
    const nameIsKeyLike = isKeyLikeName(candidate.displayName)
    const folderIsKeyLike = isKeyLikePath(candidate.folderPath)
    const sameName = candidate.displayName.trim().toLowerCase() === examName

    if (isInsideFolder(candidate.folderPath, exam.folderPath) && folderIsKeyLike) {
      ranked.push({ file: candidate, rule: 'answer-key-folder' })
    } else if (
      !sameFolder &&
      candidate.folderPath !== '' &&
      parentPath(candidate.folderPath) === examParent &&
      folderIsKeyLike &&
      sameName
    ) {
      ranked.push({ file: candidate, rule: 'solution-folder' })
    } else if (sameFolder && nameIsKeyLike) {
      ranked.push({ file: candidate, rule: 'same-folder-key-name' })
    } else if (nameIsKeyLike || folderIsKeyLike) {
      ranked.push({ file: candidate, rule: 'same-stem-anywhere' })
    }
  }

  return ranked.sort((a, b) => {
    if (RULE_RANK[a.rule] !== RULE_RANK[b.rule]) return RULE_RANK[b.rule] - RULE_RANK[a.rule]
    if (a.file.displayName.length !== b.file.displayName.length) {
      return a.file.displayName.length - b.file.displayName.length
    }
    return a.file.displayName.localeCompare(b.file.displayName, 'zh-CN')
  })
}

export type PairingResult<T extends PairingFile = PairingFile> = {
  /** 最佳候选；没有就是 `null`（**如实说"没配到"，绝不硬塞一份**）。 */
  key: T | null
  rule: PairingRule | null
  /** 全部候选（已排序）。页面用它画「换一个答案文件」的备选列表。 */
  ranked: RankedKey<T>[]
  /** 比对过多少份文件 —— 界面上那句话要能对得上账（"在 271 份里找到 1 份"）。 */
  considered: number
}

/**
 * 给一份试卷配答案文件。**纯函数，不碰网络、不碰数据库。**
 *
 * 调用方负责把「同一门课、未被删除」的文件都传进来（`lib/practice-test/files.ts`），
 * 这里不判断归属 —— 归属是查询的事，判定是纯逻辑的事，混在一起就没法单测。
 */
export function pairAnswerKey<T extends PairingFile>(
  exam: PairingFile,
  candidates: readonly T[],
): PairingResult<T> {
  const ranked = rankKeyCandidates(exam, candidates)
  const best = ranked[0] ?? null
  return {
    key: best?.file ?? null,
    rule: best?.rule ?? null,
    ranked,
    considered: candidates.length,
  }
}
