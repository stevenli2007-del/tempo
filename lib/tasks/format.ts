import { SCHOOL_TIME_ZONE } from '@/lib/time'
import type { Lang } from '@/lib/i18n/types'

/**
 * 任务日期的展示标签。
 *
 * 用**学校本地时区**在服务端算好，避免 hydration mismatch ——
 * 服务端（UTC）与浏览器（用户时区）渲染结果不同，React 会直接报错。
 *
 * 🔴 用 `UTC` 会**必然差一天**（P0-3-10 修复）：Canvas 的 `due_at` 带真实时区
 * （如 `2026-09-09T23:59 PDT` = `2026-09-10T06:59Z`），按 UTC 取日期就印成 9/10，
 * 而用户在伯克利看到的是 9/9 —— 且**几乎所有 Canvas 作业都在晚上截止**。
 * 考试派生任务恰因硬编码 `T23:59:59 UTC` 才侥幸不出错（ADR-004 要跟 Canvas 对齐，
 * 本意就是按学校本地时间）。
 *
 * 📌 **P0-3-7b：从 dashboard 页搬到独立模块。** 课程列表页（`/courses`）也要用，
 * 复制两份 = 同一条任务在两个页面差一天。**改这里就是两处同时改。**
 */
/**
 * P0-5-1：zh / en 各一个格式化器。默认走 zh —— 既有调用方（课程列表等）一行不改。
 */
const DUE_FORMATTERS: Record<Lang, Intl.DateTimeFormat> = {
  zh: new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: SCHOOL_TIME_ZONE,
  }),
  en: new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: SCHOOL_TIME_ZONE,
  }),
}

/**
 * `iso === null` 表示**日期待定（TBD）** —— 返回 `label: null` 让展示层渲染成
 * 「日期待定」，不编一个假日期出来（`Database.md` 3.9）。
 */
export function formatDue(
  iso: string | null,
  now: Date,
  lang: Lang = 'zh',
): { label: string | null; isOverdue: boolean } {
  if (iso === null) {
    return { label: null, isOverdue: false }
  }
  const due = new Date(iso)
  if (Number.isNaN(due.getTime())) {
    return { label: null, isOverdue: false }
  }
  return { label: DUE_FORMATTERS[lang].format(due), isOverdue: due.getTime() < now.getTime() }
}
