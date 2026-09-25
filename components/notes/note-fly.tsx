'use client'

import { useEffect, useRef, useState } from 'react'

import { NOTES_UPDATED_EVENT, type NotesUpdatedDetail } from '@/lib/notes/event'

/**
 * 飘行的音符（P0-5-4 验收反馈，Steven 2026-09-24）：完成一件事后，
 * 一枚 ♪ 从**完成那一行的位置**起飞，落进顶栏的计数里。
 *
 * ### 为什么是"从行飞向计数"而不是原地跳一下
 * Steven 的原话：「从完成的任务那一条消息那里，飘出来一个音符飞向这个累计值」。
 * 这条轨迹同时讲清了两件事：**刚完成的是这一条**（起点）与**它进了总数**（终点）——
 * 不需要任何文字，R5 的"不评价"靠运动本身成立。
 *
 * ### 起点从哪来
 * `NOTES_UPDATED_EVENT` 的 `detail.origin`（TaskList 勾选时读的行矩形中心）。
 * 总览页懒补（Canvas 代判）没有"用户盯着的某一 行"，detail 里 origin 为 null
 * → 从视口中下部起飞，向上飘进计数 —— 同一条轨迹语言，只是没有具体行。
 *
 * ### 为什么用 Web Animations API 而不是 CSS keyframes
 * 起点与终点都是**运行时才知道的像素坐标**（行的位置随滚动变），写不进静态样式表；
 * CSS 自定义属性 + keyframes 也能做，但那是两套坐标系统的拼接，WAAPI 一段就够。
 * 产物 CSS 里不需要为新类做 grep（Tailwind v4 陷阱不适用：这里没有新类名）。
 *
 * ### 纪律
 * - 整层 `pointer-events-none`，动画完自卸，不拦任何点击。
 * - `prefers-reduced-motion` → 不放飞（读屏另有彩带层那句 sr-only 陈述）。
 * - 一次懒补最多补几十枚 → **最多放飞 6 枚**：视觉语言是"有几件进来了"，
 *   不是精确计数（精确的数字由计数器自己说）。
 */

/** 一次最多放飞几枚（一次懒补可能补几十枚，全放就是彩带糊脸）。 */
const MAX_FLIGHTS = 6

/** 每枚的间隔与时长（毫秒）：总窗口 ≈ 5×130 + 900 ≈ 1.55s，与彩带同量级。 */
const STAGGER_MS = 130
const FLIGHT_MS = 900

/** 动画放完后等多久把节点全卸掉（取最后一枚的结束时刻，留 100ms 余量）。 */
const LIFETIME_MS = (MAX_FLIGHTS - 1) * STAGGER_MS + FLIGHT_MS + 100

/** 一枚在飞♪ 的渲染模型。 */
interface Flight {
  id: number
  from: { x: number; y: number }
  /** 每枚稍 different 的弧线偏移，避免 6 枚叠成一条直线。 */
  bend: number
  delay: number
}

/** 全局自增 id：连续两批事件不共用 React key。 */
let nextFlightId = 0

export function NoteFlyLayer() {
  const [flights, setFlights] = useState<Flight[]>([])

  useEffect(() => {
    function onNotesUpdated(event: Event) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

      const detail = (event as CustomEvent<NotesUpdatedDetail>).detail ?? {}
      const count = Math.max(1, Math.min(detail.count ?? 1, MAX_FLIGHTS))
      // 懒补（origin 为 null/缺省）：没有"那一行"，从视口中下部起飞。
      const fallback = { x: window.innerWidth / 2, y: window.innerHeight * 0.72 }
      const from = detail.origin ?? fallback

      const batch: Flight[] = Array.from({ length: count }, (_, i) => ({
        id: nextFlightId++,
        from,
        // 相邻枚往相反侧弯，铺开成一小束。
        bend: (i - (count - 1) / 2) * 46,
        delay: i * STAGGER_MS,
      }))
      setFlights((prev) => [...prev, ...batch])
    }

    window.addEventListener(NOTES_UPDATED_EVENT, onNotesUpdated)
    return () => window.removeEventListener(NOTES_UPDATED_EVENT, onNotesUpdated)
  }, [])

  // 全批放完自卸 —— 不留绝对定位的空节点挂在 DOM 里。
  useEffect(() => {
    if (flights.length === 0) return
    const timer = window.setTimeout(() => setFlights([]), LIFETIME_MS)
    return () => window.clearTimeout(timer)
  }, [flights])

  /** 起飞后由 effect 逐枚启动 WAAPI 动画（终点坐标只有浏览器里才有）。 */
  const launched = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (flights.length === 0) return
    const target = document.getElementById('note-counter')
    if (!target) return

    const to = target.getBoundingClientRect()
    const tx = to.left + to.width / 2
    const ty = to.top + to.height / 2

    const animations: Animation[] = []
    for (const node of document.querySelectorAll('[data-note-flight]')) {
      const id = Number((node as HTMLElement).dataset.noteFlight ?? '')
      // 只起飞没飞过的那一枚：连续两批事件叠加时，第一批正在飞的
      // **绝不能**被重启（终点变了会瞬移）。
      if (launched.current.has(id)) continue
      const flight = flights.find((entry) => entry.id === id)
      if (!flight) continue
      launched.current.add(id)

      const midX = (flight.from.x + tx) / 2 + flight.bend
      const midY = Math.min(flight.from.y, ty) - 60
      const animation = node.animate(
        [
          { transform: `translate(${flight.from.x}px, ${flight.from.y}px) scale(1)`, opacity: 0 },
          { transform: `translate(${flight.from.x}px, ${flight.from.y}px) scale(1)`, opacity: 1, offset: 0.12 },
          { transform: `translate(${midX}px, ${midY}px) scale(1.3)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${tx}px, ${ty}px) scale(0.6)`, opacity: 0.9 },
        ],
        { duration: FLIGHT_MS, delay: flight.delay, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)', fill: 'both' },
      )
      animation.onfinish = () => node.remove()
      animations.push(animation)
    }

    return () => animations.forEach((animation) => animation.cancel())
  }, [flights])

  if (flights.length === 0) return null

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {flights.map((flight) => (
        <span
          key={flight.id}
          data-note-flight={flight.id}
          className="fixed left-0 top-0 text-[15px] leading-none text-foreground/80"
          style={{ transform: `translate(${flight.from.x}px, ${flight.from.y}px)` }}
        >
          ♪
        </span>
      ))}
    </div>
  )
}
