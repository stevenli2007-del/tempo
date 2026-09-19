/**
 * 「哪些资料跟这场考试有关」的**纯判定**（P0-3-31）。
 *
 * ### 🔴 这个文件必须保持零依赖
 * 判定要被回归脚本（`scripts/regress-exam-review.ts`）直接 import 断言。
 * 一旦 import 任何服务端模块（`lib/supabase/server` → `next/headers`），
 * 脚本跑不起来、构建期还会把 `next/headers` 拖进客户端图（3-25 / 3-23 踩过的同一个坑）。
 * 所以这里只从零依赖的 `lib/practice-test/pairing.ts` 取词元工具。
 *
 * ### 这是**推荐**，不是判定 —— 判错不会写坏任何数据
 * 复习页把推荐的文件画成一排**可勾选**的候选，勾哪些最终由用户决定。
 * 所以这里宁可**多推一份**（用户一眼能划掉），也不要漏推 —— 漏推的代价是
 * "我明明有那份 past exam，Tempo 却没列出来"，而用户无从知道原因。
 *
 * ### 两级推荐（顺序即优先级，见 `sortRecommendations`）
 * 1. **`name` 命中**：文件名/目录里**同时**出现考试名的全部词元。
 *    `Midterm 1` 的词元是 `[midterm, 1]`，`PracticeMidterm1_F23.pdf` 的词元含
 *    `midterm` 与 `1` ⇒ 命中。这是"看起来就是这场考试的资料"的强信号。
 * 2. **`exam-like` 兜底**：`isExamLike()` 为真（文件名/目录带 exam / quiz / midterm 等词）
 *    —— 一门课的 past exam 通常都该出现在复习清单里，即便名字与考试名对不上
 *    （如考试叫 `Midterm 1`，文件叫 `Practice Exam 1`）。
 *
 * ⚠️ **答案文件不会因此被判掉**：`isExamLike()` 会把答案 key 排除（它不该当"卷子"），
 * 但 **`name` 命中不看 `isExamLike`** —— 复习时答案 key 恰恰是要读的资料之一。
 */

import { isExamLike, tokenizeName } from '@/lib/practice-test/pairing'

/** 推荐只用得到这三列 —— 不依赖 `course_files` 的行结构（纯数据，便于单测）。 */
export type RecommendableFile = {
  id: string
  displayName: string
  /** Canvas 相对路径，空串 = 课程文件根目录。 */
  folderPath: string
}

/** 命中理由。界面据此画一句"为什么推荐它"。 */
export type RecommendReason = 'name' | 'exam-like'

export type Recommendation<T extends RecommendableFile> = {
  file: T
  reason: RecommendReason
}

/** 文件名 + 目录路径的全部词元（小写、去扩展名、驼峰/字母数字边界已切开）。 */
function allTokens(file: RecommendableFile): Set<string> {
  const tokens = tokenizeName(file.displayName)
  for (const segment of file.folderPath.split('/')) {
    for (const token of tokenizeName(segment)) tokens.push(token)
  }
  return new Set(tokens)
}

/**
 * 给一场考试挑出"可能相关的资料"。**不碰数据库、不碰网络。**
 *
 * 调用方负责把「同一门课、未被删除」的文件都传进来；归属是查询的事，
 * 判定是纯逻辑的事，混在一起就没法单测（与 `pairAnswerKey` 同一条纪律）。
 */
export function recommendExamFiles<T extends RecommendableFile>(params: {
  /** `exam_dates.exam_name`（如 `"Midterm 1"`）。 */
  examName: string
  files: readonly T[]
}): Recommendation<T>[] {
  // 去重词元；空（中文考试名会被切成空，因为词元只认 [a-z0-9]）⇒ 全部落到 exam-like 兜底。
  const examTokens = Array.from(new Set(tokenizeName(params.examName)))

  const out: Recommendation<T>[] = []
  for (const file of params.files) {
    if (examTokens.length > 0) {
      const tokens = allTokens(file)
      if (examTokens.every((token) => tokens.has(token))) {
        out.push({ file, reason: 'name' })
        continue
      }
    }
    if (isExamLike(file)) {
      out.push({ file, reason: 'exam-like' })
    }
  }

  return sortRecommendations(out)
}

/**
 * 排序：`name` 命中的在前，其次按目录、再按展示名 —— **可复现**（同样的输入永远同一个顺序），
 * 否则"今天这份排第一、明天那份排第一"会让用户失去信任（与 `rankKeyCandidates` 同一条）。
 */
function sortRecommendations<T extends RecommendableFile>(
  items: Recommendation<T>[],
): Recommendation<T>[] {
  return [...items].sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === 'name' ? -1 : 1
    if (a.file.folderPath !== b.file.folderPath) {
      return a.file.folderPath.localeCompare(b.file.folderPath, 'zh-CN')
    }
    return a.file.displayName.localeCompare(b.file.displayName, 'zh-CN')
  })
}

/**
 * 在**用户已勾选**的资料里，挑出可以拿去出卷的 past exam（`isExamLike`）。
 *
 * 🔴 这是本卡验收③的判定点：返回空数组 ⇒ 复习页的「试卷」按钮必须**不可用**并说明原因
 * （绝不降级成让 LLM 出新题，ADR-027）。答案 key / 讲义 / 图片都不算 past exam。
 * 判定与资料区「自测卷」按钮**共用同一个 `isExamLike`**，不另写一套。
 */
export function paperCandidates<T extends RecommendableFile>(selected: readonly T[]): T[] {
  return selected.filter((file) => isExamLike(file))
}
