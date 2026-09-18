/**
 * 权重合计校验（P0-3-24 ·「同 source 合计 ≠ 100% 报警，缺口留灰」）。
 *
 * ### 为什么按 source 分组算
 * `grade_components` 可能有多个写入方：syllabus 解析（`syllabus`）、用户在课程页手填或
 * 对话框编排（`manual`）、将来 Canvas 侧写入（`canvas`）。把三来源的行**混在一起求和**
 * 得到的是「160%」这种数字 —— 它不是"老师写错了"，而是"我们把两份独立构成叠起来算了"，
 * 报警就是在诬告 syllabus。所以**只在同一个 source 内部比 100**。
 *
 * ### 三条不编造
 * 1. `weightPercent === null`（原文没写占比）**不计入合计**，也不当 0 处理 ——
 *    0% 的语义是"这一项不占分"，与"没写"完全相反（`grade-pie.tsx` 同一条纪律）。
 * 2. 合计 ≠ 100 时**只报警**，绝不按比例摊到各项上、也绝不补一条原文没有的构成项 ——
 *    那是替老师改写 syllabus（与 `lib/parse/prompts.ts` gradeComposition 规则同源）。
 * 3. 合计 > 100（原文写重了/超额）同样如实报，不静默归一化。
 *
 * 纯函数，不碰数据库 —— `scripts/regress-course-updates.ts` 直接 import 断言。
 */

/** 只需要这两列，方便同时接受「已落库行」与「解析预览」两种输入。 */
export type WeightedItem = {
  source?: string | null
  weightPercent: number | null
}

export type WeightGroupSummary = {
  source: string
  /** 已知占比的合计（null 项不计）。 */
  total: number
  /** 写了占比的条目数。 */
  knownCount: number
  /** 没写占比的条目数（"未知"，不是 0）。 */
  unknownCount: number
  /** 距 100 的差额：正数=缺口，负数=超额，0=正好。 */
  gap: number
  /** 合计正好 100。 */
  complete: boolean
  /** 这一组里存在"没写占比"的项 —— 合计即使等于 100 也仍然不完整。 */
  hasUnknown: boolean
}

/** 来源标签（人话，用于 UI 文案）。 */
const SOURCE_LABEL: Record<string, string> = {
  syllabus: 'syllabus 解析',
  manual: '手动 / 对话编排',
  canvas: 'Canvas',
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

/**
 * 按 source 分组求合计。
 *
 * **保留输入顺序**：先出现的 source 排前面，UI 列表才不会每次渲染跳动。
 * 空数组输入返回空数组（"一项都没有"不是"合计 0%"，不造一条假分组）。
 */
export function summarizeWeightTotals(items: WeightedItem[]): WeightGroupSummary[] {
  const order: string[] = []
  const buckets = new Map<
    string,
    { total: number; knownCount: number; unknownCount: number }
  >()

  for (const item of items) {
    const source = item.source ?? 'manual'
    let bucket = buckets.get(source)
    if (!bucket) {
      bucket = { total: 0, knownCount: 0, unknownCount: 0 }
      buckets.set(source, bucket)
      order.push(source)
    }
    if (typeof item.weightPercent === 'number' && Number.isFinite(item.weightPercent)) {
      bucket.total += item.weightPercent
      bucket.knownCount += 1
    } else {
      bucket.unknownCount += 1
    }
  }

  return order.map((source) => {
    const bucket = buckets.get(source) as { total: number; knownCount: number; unknownCount: number }
    // numeric 列回来可能是字符串；统一四舍五入到 2 位，避免 0.1+0.2 那种浮点毛刺进文案。
    const total = Math.round(bucket.total * 100) / 100
    return {
      source,
      total,
      knownCount: bucket.knownCount,
      unknownCount: bucket.unknownCount,
      gap: Math.round((100 - total) * 100) / 100,
      complete: total === 100,
      hasUnknown: bucket.unknownCount > 0,
    }
  })
}

/**
 * 一组的人话说明。**没有"完整"这回事就返回 null** —— 不为了"有话说"而凑一句。
 *
 * 三种情况各自成句，因为用户要采取的行动不同：
 * - 缺口（<100）：原文没写全 / 你只贴了一部分 → 提示补；
 * - 超额（>100）：原文写重了 → 提示去核对原文；
 * - 正好 100 但有未知项：数字对得上，但有几项没写占比 → 说明"这几项不参与合计"。
 */
export function weightWarning(group: WeightGroupSummary): string | null {
  const label = sourceLabel(group.source)
  if (group.gap > 0) {
    return `${label}来源合计 ${group.total}%，还差 ${group.gap}% —— 缺口留灰，Tempo 不会替你补一条构成项。`
  }
  if (group.gap < 0) {
    return `${label}来源合计 ${group.total}%，超过 100% —— 原文可能写重了，请回原文核对。`
  }
  if (group.hasUnknown) {
    return `${label}来源已标注部分合计正好 100%，另有 ${group.unknownCount} 项没写占比（不参与合计）。`
  }
  return null
}

/** 只取"需要报警"的分组说明（UI 直接渲染）。 */
export function weightWarnings(items: WeightedItem[]): string[] {
  return summarizeWeightTotals(items)
    .map(weightWarning)
    .filter((line): line is string => line !== null)
}
