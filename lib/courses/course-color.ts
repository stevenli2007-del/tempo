/**
 * 课程颜色（P0-3-6 配套小功能）：把每门课映射到一个确定性颜色，
 * 让总览任务列表 / 课程卡能用同一颗小色点标识课程归属，一眼区分。
 *
 * **不存数据库** —— 用 courseId 做确定性**排序分配**（`assignCourseColorKeys()`），
 * 零迁移、所有视图一致。
 * 若以后要做「用户自选颜色」，只改这一处（换成读 `courses.color` 字段）即可，
 * 调用方（TaskList / CourseCard）不用动。
 *
 * 颜色取自 P0-3-3 已落地的设计令牌：`--purple / --blue / --green / --coral / --amber`，
 * 亮暗主题都配好了，直接用 `var(--xxx)` 即可随主题自动切换。
 */

export const COURSE_COLOR_KEYS = ['purple', 'blue', 'green', 'coral', 'amber'] as const
export type CourseColorKey = (typeof COURSE_COLOR_KEYS)[number]

/** 由种子（courseId）算出确定性 32 位哈希。排序与兜底选色共用这一份。 */
function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    // 31 是经典字符串哈希乘子，分布均匀且不易溢出（用 >>>0 保持无符号 32 位）。
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * 单课哈希选色。**可能撞色** —— 只作 `courseColorClassesFor()` 在分配表缺行时的兜底，
 * 正常路径一律走 `assignCourseColorKeys()` 的全量分配。
 */
export function courseColorKey(seed: string): CourseColorKey {
  return COURSE_COLOR_KEYS[hashSeed(seed) % COURSE_COLOR_KEYS.length]
}

/**
 * 全量课程 → 颜色键的**去重分配**（2026-09-25 Steven：「每个课程的颜色又重复了」）。
 *
 * ### 为什么不再逐课哈希取模
 * 纯哈希把课扔进 5 个桶，撞色概率随课数暴涨：4 门课约 **81%** 必撞
 * （1 − 5·4·3·2/5⁴）—— Steven 的 4 门课里三门同色不是倒霉，是数学必然。
 * 调色板扩容治标不治本，真正要的是"**一次分配，两两不同**"。
 *
 * ### 算法
 * 每门课算哈希，按（哈希值, id）**全序排序**后按位置发色（`KEYS[i % 5]`）：
 * - 前 5 门课**保证互不相同**；第 6 门起才开始循环复用（5 色板的硬上限，
 *   真到 6+ 门再议扩色板，不在这里塞凑数颜色）；
 * - 排序依据只来自 courseId 本身，与传入顺序无关 → 同一批课在任何页面算出同一份分配；
 * - 🔴 调用方必须传**同一份全量列表**（dashboard 与 /courses 都是非归档全量课程）：
 *   传子集会让同一门课在不同页面拿到不同颜色，破坏"同一门课永远同色"。
 *
 * 返回普通对象（不是 Map）：要跨 server → client 边界传给客户端组件，必须可序列化。
 */
export function assignCourseColorKeys(courseIds: string[]): Record<string, CourseColorKey> {
  const entries = Array.from(new Set(courseIds)).map((id) => ({ id, h: hashSeed(id) }))
  entries.sort((a, b) => a.h - b.h || a.id.localeCompare(b.id))
  const result: Record<string, CourseColorKey> = {}
  entries.forEach((entry, index) => {
    result[entry.id] = COURSE_COLOR_KEYS[index % COURSE_COLOR_KEYS.length]
  })
  return result
}

/**
 * 从分配表取三件套。表里缺行（理论上不该发生：表由同一页的全量课程算出）
 * 退回旧的哈希选色 —— 兜底只在该坏处坏一行，不把整个组件打挂。
 */
export function courseColorClassesFor(
  colorKeys: Record<string, CourseColorKey>,
  courseId: string,
): CourseColorClasses {
  return courseColorClasses(colorKeys[courseId] ?? courseColorKey(courseId))
}

/** 返回该颜色键对应的、随主题切换的 CSS 颜色值（如 `var(--purple)`）。 */
export function courseColorVar(key: CourseColorKey): string {
  return `var(--${key})`
}

/**
 * 课程色的**静态类名三件套**（P0-3-33）。
 *
 * ### 为什么不再用 `courseColorVar()` 内联 style
 * 内联 style 只能画「一颗小圆点」这类极小面积 —— 它撑不成面，也就起不到区分作用
 * （Steven 2026-09-20 反馈：「单单一颗很小的颜色亮点不足以区分」）。
 * 要画色块 / 浅底 chip / 左侧色边，就得用工具类；而**工具类名不能运行时拼接**：
 * `bg-${key}` 这种写法 Tailwind 扫不到、CSS 根本不生成，表现是"点改了但没颜色"，
 * 而 `tsc` / `eslint` / `build` 全绿（CodingRules §10，本项目已踩过一次）。
 * 所以这里是**字面量表**，五个键 × 三件套全部写死 —— **不许改成拼接**。
 *
 * ### 三件套的分工
 * - `bar` —— 实色块（左侧竖色条 / 小圆点），负责"一眼看出是哪门课"；
 * - `chip` —— 浅底 + 同色文字，负责"把课程名本身染成这门课的颜色"；
 * - `edge` —— 左边框色，配 `border-l-2` 用，给周历 pill 这种"不能染色整块"的窄容器。
 *
 * 与 `lib/messages/view.ts` 的 `COURSE_TONES` 是同一个套路（那边也是字面量、不许拼接），
 * 但**取色口径不同**：那边按课程名的 FNV 哈希、五组顺序也不同，所以同一门课在
 * 消息栏与课程卡上大概率是**两个颜色**（P0-3-33 报告里记了这笔，本卡不动它）。
 *
 * ⚠️ 验证改动是否真的生效：build 后 grep 产物 CSS（CSS 里的 `/` 是转义写法 `.bg-lime\/20`，
 * 所以 grep 要加 `-F`），如 `grep -oF '.bg-purple' .next/static/css/*.css`。
 */
export interface CourseColorClasses {
  /** 实色（左侧竖色条 / 圆点）：`bg-<key>`。 */
  bar: string
  /** 浅底 + 同色文字（课程名 chip）：`bg-<key>-bg text-<key>`。 */
  chip: string
  /** 左边框色（配 `border-l-2`）：`border-l-<key>`。 */
  edge: string
}

export const COURSE_COLOR_CLASSES: Record<CourseColorKey, CourseColorClasses> = {
  purple: { bar: 'bg-purple', chip: 'bg-purple-bg text-purple', edge: 'border-l-purple' },
  blue: { bar: 'bg-blue', chip: 'bg-blue-bg text-blue', edge: 'border-l-blue' },
  green: { bar: 'bg-green', chip: 'bg-green-bg text-green', edge: 'border-l-green' },
  coral: { bar: 'bg-coral', chip: 'bg-coral-bg text-coral', edge: 'border-l-coral' },
  amber: { bar: 'bg-amber', chip: 'bg-amber-bg text-amber', edge: 'border-l-amber' },
}

/** 取某个颜色键的三件套类名。调用方先 `courseColorKey(seed)` 拿到键。 */
export function courseColorClasses(key: CourseColorKey): CourseColorClasses {
  return COURSE_COLOR_CLASSES[key]
}
