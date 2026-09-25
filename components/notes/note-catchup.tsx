'use client'

import { useEffect, useRef } from 'react'

import { NOTES_UPDATED_EVENT } from '@/lib/notes/event'

/**
 * 总览页懒补的**客户端回声**（P0-5-4 验收反馈）。
 *
 * 服务端渲染时 `awardNotesForDone()` 补记了 Canvas 代判完成的音符（记入点之二），
 * 但那段代码在服务端 —— 彩带 / 飘行层全在客户端，听不到。这个零渲染组件把
 * 「本次新记入 N 枚」在挂载后广播成同一个事件，让既有听觉（彩带、飘行、计数刷新）
 * 对两条记入路径一视同仁：**只要总数变了，反馈就该出现**（Steven 2026-09-24：
 * 自动检测到的完成也要有反馈）。
 *
 * ### 为什么不会双响
 * 手勾路径里 PATCH 当场已记入，随后 `router.refresh()` 触发的这次服务端渲染
 * 懒补算出的 `awarded` 是 0 —— 这里 `awarded <= 0` 直接不广播。
 *
 * ### 为什么用 ref 防重入
 * React 18 严格模式 / 并发特性下 effect 可能跑两次；广播是纯客户端副作用，
 * 双响 = 彩带放两遍。`fired` 让同一次渲染只广播一次。
 */
export function NoteCatchup({ awarded }: { awarded: number }) {
  const fired = useRef(false)

  useEffect(() => {
    if (awarded <= 0 || fired.current) return
    fired.current = true
    // 懒补没有"完成的那一行"（origin 留空 → 飘行层从视口中下部起飞），
    // 也没有单条标题（sr-only 走 counts 那句中性陈述）。
    window.dispatchEvent(
      new CustomEvent(NOTES_UPDATED_EVENT, { detail: { title: '', count: awarded } }),
    )
  }, [awarded])

  return null
}
