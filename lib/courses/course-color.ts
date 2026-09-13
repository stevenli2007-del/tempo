/**
 * 课程颜色（P0-3-6 配套小功能）：把每门课映射到一个确定性颜色，
 * 让总览任务列表 / 课程卡能用同一颗小色点标识课程归属，一眼区分。
 *
 * **不存数据库** —— 用 courseId 做确定性哈希，零迁移、所有视图一致。
 * 若以后要做「用户自选颜色」，只改这一处（换成读 `courses.color` 字段）即可，
 * 调用方（TaskList / CourseCard）不用动。
 *
 * 颜色取自 P0-3-3 已落地的设计令牌：`--purple / --blue / --green / --coral / --amber`，
 * 亮暗主题都配好了，直接用 `var(--xxx)` 即可随主题自动切换。
 */

export const COURSE_COLOR_KEYS = ['purple', 'blue', 'green', 'coral', 'amber'] as const
export type CourseColorKey = (typeof COURSE_COLOR_KEYS)[number]

/** 由种子（courseId）确定性地选一个颜色键。同一门课永远同色。 */
export function courseColorKey(seed: string): CourseColorKey {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    // 31 是经典字符串哈希乘子，分布均匀且不易溢出（用 >>>0 保持无符号 32 位）。
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return COURSE_COLOR_KEYS[h % COURSE_COLOR_KEYS.length]
}

/** 返回该颜色键对应的、随主题切换的 CSS 颜色值（如 `var(--purple)`）。 */
export function courseColorVar(key: CourseColorKey): string {
  return `var(--${key})`
}
