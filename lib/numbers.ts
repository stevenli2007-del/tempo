/**
 * 可空数字的收窄（P0-3-17）。
 *
 * ### 为什么单独一个文件
 * 同一个转换在三层各需要一次，而三层喂进来的形状完全不同：
 * - `lib/canvas/assignments.ts` —— Canvas 原始响应（实测给数字，但历史上出现过字符串化 `"2.5"`）；
 * - `lib/tasks.ts` —— PostgREST 的行（`numeric` 列在 JSON 里可能退化成字符串）；
 * - `lib/sync/canvas-tasks.ts` —— 比对「库里已存的值 vs 本次拉到的值」是否真的变了。
 *
 * 三处各写一份 `Number(...)` 看似无害，但只要有一处写成 `Number(x) || 0`，
 * 就会出现"未评分被显示成 0 分"这类**静默的错数据**（CodingRules 7）。
 *
 * ### 🔴 `null` 与 `0` 必须严格区分（本项目的通用铁律）
 * 与 Database.md §3.9「禁止用假日期填 TBD」同一条原则：
 * - `points_possible = null` → Canvas 没设满分（**不是 0 分**）；
 * - `submission_score = null` → 尚未评分（**不是 0 分**）。
 *
 * 0 是一个**真实且极端**的取值（考试考了 0 分），拿它当"没有"会让用户看到
 * "0 / 100"这种凭空捏造的结论。所以本函数**只把真正无法解析的值降级为 null**，
 * 而 `0` 会原样返回。
 */

/** 数字 / 数字串 → number；其余（null / 空串 / NaN / 对象…）→ null。`0` 原样保留。 */
export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 两个可空数字是否「同一个值」—— 用于同步层的变更判定。
 *
 * - 两边都是 null → 相同（都没数据，无需重写，遵守「没有变化就不写库」）；
 * - 只有一边是 null → 不同（出现了新的真相，要写）；
 * - 都能解析 → 按数值比（`"2.50"` 与 `2.5` 算相同，避免每轮同步都白写一次）。
 *
 * 注意：解析不出形状的值（`{}` / `"abc"` / `NaN`）会被 `toNumberOrNull` 归成 null，
 * 于是与真正的 null 判为「相同」而**不重写**。这是刻意的取舍 ——
 * 同步层的两个输入（PostgREST 行 / Canvas 映射结果）都已在各自的边界上收窄过，
 * 走到这里还能出现异常形状说明上游坏了，此时"少写一次"比"每轮都写"更安全
 * （真正的问题会在同步的报错通道里暴露，而不是靠这里反复重写来掩盖）。
 */
export function sameNumber(a: unknown, b: unknown): boolean {
  const left = toNumberOrNull(a)
  const right = toNumberOrNull(b)
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return left === right
}
