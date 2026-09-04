import type { CanvasCourse } from '@/types/canvas'

/**
 * 把 Canvas 课程列表分成「像教学课」与「其他」两组（P0-2-4 关联 UI）。
 *
 * ### 为什么需要这个分组
 * Canvas 的 active enrollment 里混着一堆不是课的东西。Steven 的真实账号 13 门里
 * 只有 6 门是 Fall 2026 教学课，另外 7 门是入学流程/培训模块
 * （Bear Pact Quiz / GBO / PartySafe / Hazing / SHAPE，term 是
 * "Default Term" 或 "Projects"）。混在一起展示，6 门真课会被淹没。
 *
 * ### 为什么用规则而不是模型
 * 判断"这是不是一门课"看上去像个分类问题，但它的代价结构不适合上模型：
 * 判错的代价（把用户真要的课藏起来）远大于分组不好看的代价，
 * 而规则的两条信号在真实数据上就是准的。要用模型得先攒标注数据，
 * Phase 0 不值得。等真出现"规则分错了"的样本再升级。
 *
 * ### 两个信号取「或」
 * - `term` 是标准学期名（`Fall 2026` / `Spring 2027` …）
 * - `name` 里有课程代码特征（`CHEM 1A` / `MATH 53-LEC-001` / `R4A`）
 *
 * 取或是刻意的：**宁可把培训模块错分进"教学课"，也不能把真课分进"其他"**。
 * 前者只是分组不好看，后者等于替用户把选项藏了 —— 而"不静默过滤"是 Steven
 * 2026-09-04 拍板的前提（见 Phase-0-MVP P0-2-3 执行卡的噪音课结论）。
 *
 * ### 分组只影响展示，不影响可关联性
 * 两组里的每一项都能被关联。分到"其他"只是换个位置展示 + 多一句提示。
 */

/** 标准学期名：季节 + 四位年份，中间允许任意分隔符（`Fall 2026` / `Fall-2026`）。 */
const TERM_PATTERN = /\b(fall|spring|summer|winter)\b[\s\-_/]*\b(20\d{2})\b/i

/**
 * 课程代码特征：2-6 个字母 + **至少一个空格** + 1-3 位数字 + 可选字母后缀。
 * 覆盖 `CHEM 1A` / `MATH 53-LEC-001` / `Chem 1AL`。
 * 培训模块名（"Bear Pact Quiz" / "PartySafe" / "SHAPE"）不含数字，不会被误判。
 *
 * ⚠️ **空格是必需的**，这不是排版洁癖：Steven 真实数据里的入学类模块叫
 * `GBO-FL26` / `GBA-FL26-ENROLLMENT COURSE` —— 学期限定符（FL26 = Fall 2026）
 * 是**贴着字母**写的。允许可选空格会让 `FL26` 命中"字母+数字"，
 * 于是入学模块被判成教学课，分组就白做了。真实的课程代码
 * （`CHEM 1A`、`MATH 53`）在字母与数字之间都有空格。
 */
const COURSE_CODE_PATTERN = /\b[A-Za-z]{2,6}\s+\d{1,3}[A-Za-z]{0,2}\b/

export function looksLikeCourse(course: CanvasCourse): boolean {
  if (course.term && TERM_PATTERN.test(course.term)) {
    return true
  }
  return COURSE_CODE_PATTERN.test(course.name)
}

/** 分成两组，组内保持 Canvas 返回的原顺序（不重排，用户对得上 Canvas 里的顺序）。 */
export function groupCanvasCourses(courses: CanvasCourse[]): {
  courseLike: CanvasCourse[]
  other: CanvasCourse[]
} {
  const courseLike: CanvasCourse[] = []
  const other: CanvasCourse[] = []
  for (const course of courses) {
    if (looksLikeCourse(course)) {
      courseLike.push(course)
    } else {
      other.push(course)
    }
  }
  return { courseLike, other }
}
