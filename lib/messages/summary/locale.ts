/**
 * 摘要的**语言与文案**（P0-3-25b，纯模块：无任何 import，客户端链上也能安全引用）。
 *
 * ### 为什么语言要从第一天就当成参数，而不是写死中文
 * Steven 2026-09-18 拍板：公告原文几乎全是英文，**先出简体中文要点**
 * （course code / 考试名这类专有名词保留英文原样）。
 * 但他同时点明"后期 Tempo 也要出英文版给外国人用" ——
 * 于是语言从第一版起就是**入参**：缓存表按 `(message_id, locale)` 分行、
 * prompt 按语言分支、界面文案按语言取。英文版上线时**不需要改数据结构**，
 * 只是多一门语言多跑一遍生成。
 *
 * 🔴 这里**不是**"i18n 框架"：只有摘要这一处需要，做一层最小映射即可。
 *    UI 其余部分要国际化时另开卡（那涉及路由、日期格式、整个站点的文案）。
 *
 * ⚠️ 白名单是**封闭**的：`isSummaryLocale()` 之外的取值一律拒绝（路由层回 400），
 *    绝不"不认识就当 zh-CN" —— 那会往库里写下一个谁也读不到的 locale 行。
 */

/** 摘要支持的语言。加语言 = 改这里 + `LOCALE_LABELS` + `prompt.ts` 的指令表。 */
export const SUMMARY_LOCALES = ['zh-CN', 'en'] as const

export type SummaryLocale = (typeof SUMMARY_LOCALES)[number]

/**
 * 当前界面语言下的默认摘要语言。
 *
 * P0-3-25b 的界面是中文 → `zh-CN`。英文版上线时改成按用户/请求判定即可
 * （客户端本来就会显式带上 locale，这里是兜底）。
 */
export const DEFAULT_SUMMARY_LOCALE: SummaryLocale = 'zh-CN'

/** 语言 → 展示名（写进 prompt 的"用哪种语言回答"）。 */
export const LOCALE_LABELS: Record<SummaryLocale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
}

/** 类型守卫。**不认识的取值一律拒绝**，不静默回退。 */
export function isSummaryLocale(value: unknown): value is SummaryLocale {
  return typeof value === 'string' && (SUMMARY_LOCALES as readonly string[]).includes(value)
}

/**
 * 覆盖率文案：喂给模型的条数少于消息挂着的总条数时，必须如实说明。
 *
 * 只有一条公告的消息（绝大多数）返回 `null` —— 那时"覆盖 1/1"是废话，
 * 画出来只会让每条气泡都多一行噪音。
 *
 * 🔴 宁可报"基于最新 20 条 / 共 40 条"，也不许把 20 条要点画成"这 40 条的要点"：
 *    用户据此决定要不要点原文，而"以为都总结过了"正是他会漏事的那种错觉。
 */
export function coverageLabel(
  itemsUsed: number,
  itemsTotal: number,
  locale: SummaryLocale = DEFAULT_SUMMARY_LOCALE,
): string | null {
  if (!Number.isFinite(itemsUsed) || !Number.isFinite(itemsTotal)) return null
  const used = Math.max(0, Math.floor(itemsUsed))
  const total = Math.max(0, Math.floor(itemsTotal))
  // `used <= 0` 也要挡：那会写出"基于最新 0 条 / 共 40 条"这种句子 ——
  // 诚实是说"没覆盖全"，不是把不可能的组合画出来。
  if (total <= 1 || used <= 0 || used >= total) return null
  return locale === 'en'
    ? `newest ${used} of ${total}`
    : `基于最新 ${used} 条 / 共 ${total} 条`
}

/**
 * 界面上的 AI 归因标签。
 *
 * 🔴 **必须有**：要点是模型提炼的，不是老师写的原话。没有这行标注，
 *    用户会把"AI 的理解"读成"老师的原话"，而两边不一致时他无从判断该信谁。
 *    所以要点永远和「原文 ↗」并排出现（见 `messages-view.tsx`）。
 */
export function summaryLabel(locale: SummaryLocale = DEFAULT_SUMMARY_LOCALE): string {
  return locale === 'en' ? 'AI summary' : 'AI 总结'
}

/**
 * 生成中的占位文案。
 *
 * 为什么值得占一行：要点是**后台异步**补进来的（`POST /api/v1/messages/summaries`），
 * 第一次打开消息栏要等几秒模型。没有这行字，用户无法区分"还在算"和"这功能没生效"
 * —— 而后者会让他去翻代码找 bug。
 *
 * ⚠️ 这一行**会消失**（请求结束就撤），且失败时不给任何替代文案：
 *    失败的表现就是"没有要点"，原文照常显示。这是刻意的降级 ——
 *    不要在气泡里塞一句"AI 总结失败"，那既占版面又让用户为一件增强功能操心。
 */
export function summaryPendingLabel(locale: SummaryLocale = DEFAULT_SUMMARY_LOCALE): string {
  return locale === 'en' ? 'Generating AI summary…' : 'AI 总结生成中…'
}
