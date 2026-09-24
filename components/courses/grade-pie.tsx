import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import type { StoredGradeComponent } from '@/types/sections'

/**
 * 成绩构成的饼图（P0-3-17）—— **纯 SVG，不引入任何图表依赖**。
 *
 * ### 为什么手写而不是装 recharts / chart.js
 * 这里只要一个甜甜圈 + 图例，一屏静态图。为此加一个图表库会带来
 * 一个长期依赖、一次 SSR/CSR 边界处理（大部分图表库是 client-only）和一个水合风险，
 * 换来的只是省下这 60 行。ADR-016 的取向也是"更少的活动部件"。
 *
 * ### 数据来源：**syllabus 解析出来的成绩构成**（`grade_components.weight_percent`）
 * 不是 Canvas 的 `assignment_groups.group_weight` —— 后者本项目**尚未同步**
 * （`GET /courses/:id/assignment_groups` 不在同步范围里），
 * 且 Canvas 的加权口径各课不一（实测 Chem 1AL = 5/10/60/25，CHEM 1A 权重全 0）。
 * 课程**加权总分**因此归 Phase 1 的 `P0-3-22`。
 * 本卡只做"把已经解析到手的构成画出来"（执行卡：纯前端 + 加 1 字段）。
 *
 * ### 🔴 三件不编造的事
 * 1. `weightPercent === null`（原文没写占比）的条目**不进扇区** —— 它在图例里标「未标占比」，
 *    而不是当成 0%（0% 是"这门课不占分"的意思，完全相反）。
 * 2. 已知权重**不足 100%** 时留一段灰色的「未标注」扇区，绝不把剩下的按比例摊给其他项 ——
 *    摊出去就是把老师的 syllabus 改写成我们以为的样子。
 * 3. 一个扇区都没有时**不画空环**，直接给一句人话说明。
 *
 * ### 颜色为什么用 `var(--chart-N)` 而不是 Tailwind 的 `fill-chart-N`
 * 两条路都能跟随亮/暗主题（令牌本身在 `app/globals.css` 里两套都定义了）。
 * 选 CSS 变量是因为它**不依赖 Tailwind 把 `fill-chart-1` 这类类名真的扫进产物**
 * —— `P0-3-15` 踩过"类名写了、`build` 全绿、产物 CSS 里却没有那条规则"的坑
 * （见 `CodingRules.md` §10.1 第 21 条）。内联 `stroke="var(--chart-1)"` 没有这一层不确定性。
 */

/** 与 `app/globals.css` 的 `--chart-1..5` 一一对应（purple / blue / green / coral / amber）。 */
const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const

/** 第 6 项起循环取色。 */
function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

type Slice = {
  name: string
  /** 原文写的占比（可能为 null）。 */
  percent: number | null
  /** 实际用于画扇区的百分点（按原始值；未知项为 0）。 */
  drawn: number
  color: string
}

/**
 * 已知权重合计（只算数字型的）。
 * 用于判断"够不够 100%"，以及要不要补一段「未标注」扇区。
 */
function sumKnownPercent(components: StoredGradeComponent[]): number {
  return components.reduce(
    (sum, item) => (item.weightPercent === null ? sum : sum + item.weightPercent),
    0,
  )
}

export function GradePie({ components, lang }: { components: StoredGradeComponent[]; lang: Lang }) {
  if (components.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t(lang, 'grade.empty')}</p>
    )
  }

  const knownTotal = sumKnownPercent(components)

  // 一项权重都没解析到 → 不画环（0% 与"没写"是两回事）。
  if (knownTotal <= 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t(lang, 'grade.noWeights')}</p>
        <ul className="space-y-1">
          {components.map((item) => (
            <li key={item.id} className="text-xs text-ink">
              {item.name}
              <span className="ml-1.5 text-ink-faint">{t(lang, 'grade.unlabeled')}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  /**
   * 分母取 `max(knownTotal, 100)`：
   * - 已知合计 < 100 → 环上留出「未标注」缺口（诚实表达"老师没写全"）；
   * - 已知合计 > 100（个别 syllabus 会写重复/超额的项）→ 按 100 归一，避免扇区溢出整圈。
   */
  const denominator = Math.max(knownTotal, 100)
  const unlabeled = Math.max(0, 100 - knownTotal)

  const slices: Slice[] = components.map((item, index) => ({
    name: item.name,
    percent: item.weightPercent,
    drawn: item.weightPercent === null ? 0 : item.weightPercent,
    color: seriesColor(index),
  }))

  // 用 stroke-dasharray 画环，避免手算弧线路径（少一处三角函数 bug）。
  // `pathLength="100"` 把周长归一成 100，于是 dasharray 的单位就是"百分点"。
  //
  // ⚠️ 偏移量用**纯函数式**算（`slice(0, i).reduce()`）而不是在 `.map()` 里 `offset += length`：
  // 后者是在渲染期间改一个跨轮次复用的变量，React 的 lint 规则会直接报
  // `react-hooks/immutability`（多轮渲染下偏移量会累积出错）。扇区最多十来个，O(n²) 无所谓。
  const visible = slices.filter((slice) => slice.drawn > 0)
  const lengths = visible.map((slice) => (slice.drawn / denominator) * 100)
  const offsets = lengths.map((_, index) =>
    lengths.slice(0, index).reduce((sum, item) => sum + item, 0),
  )
  /** 已知扇区占满后剩下的起点（「未标注」缺口从这里开始）。 */
  const usedLength = lengths.reduce((sum, item) => sum + item, 0)

  const arcs = visible.map((slice, index) => (
    <circle
      key={slice.name}
      cx="50"
      cy="50"
      r="40"
      fill="none"
      stroke={slice.color}
      strokeWidth="14"
      pathLength={100}
      strokeDasharray={`${lengths[index]} ${100 - lengths[index]}`}
      strokeDashoffset={-offsets[index]}
    />
  ))

  return (
    <div className="space-y-3" data-grade-pie={knownTotal}>
      <div className="flex items-center gap-5">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={t(lang, 'grade.ariaLabel', { n: slices.length, pct: knownTotal })}
          className="h-28 w-28 shrink-0 -rotate-90"
        >
          <title>{t(lang, 'grade.caption')}</title>
          {/* 底环：所有扇区都画在同一圈线上，先铺一层浅底，缺角处才有东西可看。 */}
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--line)" strokeWidth="14" />
          {arcs}
          {unlabeled > 0 ? (
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke="var(--surface2)"
              strokeWidth="14"
              pathLength={100}
              strokeDasharray={`${unlabeled} ${100 - unlabeled}`}
              strokeDashoffset={-usedLength}
            />
          ) : null}
        </svg>

        <ul className="min-w-0 flex-1 space-y-1">
          {slices.map((slice) => (
            <li key={slice.name} className="flex items-baseline gap-2 text-xs">
              <span
                className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: slice.color }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-ink" title={slice.name}>
                {slice.name}
              </span>
              <span className="shrink-0 tabular-nums text-ink-muted">
                {slice.percent === null ? t(lang, 'grade.unlabeled') : `${slice.percent}%`}
              </span>
            </li>
          ))}
          {unlabeled > 0 ? (
            <li className="flex items-baseline gap-2 text-xs">
              <span
                className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: 'var(--surface2)' }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-ink-muted">{t(lang, 'grade.unlabeledSlice')}</span>
              <span className="shrink-0 tabular-nums text-ink-faint">{unlabeled}%</span>
            </li>
          ) : null}
        </ul>
      </div>

      {knownTotal !== 100 ? (
        <p className="text-xs text-ink-faint">
          {knownTotal < 100
            ? t(lang, 'grade.notFull', { n: knownTotal })
            : t(lang, 'grade.over100', { n: knownTotal })}
        </p>
      ) : null}

      <p className="text-xs text-ink-faint">{t(lang, 'grade.note')}</p>
    </div>
  )
}
