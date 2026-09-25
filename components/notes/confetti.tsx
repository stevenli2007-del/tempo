'use client'

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { useT } from '@/lib/i18n/use-i18n'
import { NOTES_UPDATED_EVENT, type NotesUpdatedDetail } from '@/lib/notes/event'

/**
 * 完成一件事之后的**彩带**（P0-5-4，零依赖 —— 不引 `canvas-confetti` 之类的包）。
 *
 * ### 为什么零操作（ADR-016 R1/R2）
 * 它只是"刚完成的那件事"的**视觉回声**：用户点完勾选框，彩带自己飘一次、自己消失，
 * 没有关闭按钮、没有文案、不需要点击，也不打断任何操作（整层 `pointer-events-none`）。
 * 任何"再来一次 / 查看成就"的入口都属于把用户拉回来 —— 那是本卡明确不做的事。
 *
 * ### 为什么不带文字（🔴 R5）
 * ADR-016 R5 禁的是**评价性**激励。一句「你真棒 / 继续保持」会把"记了一枚音符"
 * 变成"你在被评分"，而 Tempo 的信任建立在"它不评价我"之上。
 * 中性数字「+1」卡面是允许的，但仍然**没写**：数字会把注意力从"做完了"
 * 挪到"攒了多少"，那是储值化的第一步。视觉上只留颜色与运动。
 * 屏幕阅读器拿不到运动，所以另给一句**陈述事实**的 `sr-only`（「XX」已完成）。
 *
 * ### 为什么是**确定性**的碎片参数（不用 `Math.random()`）
 * 随机值在服务端渲染与客户端首帧之间必然不同 → hydration mismatch。
 * 而彩带是纯客户端触发的，本来不会走 SSR —— 但"本来不会"不是论证：
 * 将来有人把它挪进服务端渲染的分支，mismatch 会以最难查的形式出现。
 * 用下标算出来的固定参数，两边永远一致。
 */

/** 碎片的**数量**。18 片 = "看得见是彩带"，又不至于糊住页面。 */
const PIECE_COUNT = 18

/** 一次彩带的生命周期（毫秒）：动画最长 1.7s，之后整层卸载。 */
const BURST_MS = 1800

const COLORS = [
  'var(--lime)',
  'var(--purple)',
  'var(--blue)',
  'var(--green)',
  'var(--amber)',
] as const

interface Piece {
  left: number
  delay: number
  duration: number
  rotate: number
  width: number
  height: number
  color: string
}

const PIECES: readonly Piece[] = Array.from({ length: PIECE_COUNT }, (_, i) => ({
  // 37 与 92 互质 → 18 片均匀铺开，不会挤成一列。
  left: 4 + ((i * 37) % 92),
  delay: (i % 6) * 90,
  duration: 1150 + ((i * 53) % 600),
  rotate: (i * 47) % 360,
  width: 6 + (i % 3) * 2,
  height: 8 + (i % 4) * 3,
  color: COLORS[i % COLORS.length],
}))

interface Burst {
  /** React key + 清理计时器的凭据：连续完成两件事要各放一次。 */
  id: number
  title: string
  /** 本次完成几件：手勾 = 1；总览页懒补（Canvas 代判）可能一批多件。 */
  count: number
  animate: boolean
}

export function ConfettiLayer() {
  const t = useT()
  const [burst, setBurst] = useState<Burst | null>(null)

  useEffect(() => {
    function onNotesUpdated(event: Event) {
      const detail = (event as CustomEvent<NotesUpdatedDetail>).detail
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      setBurst({
        id: Date.now(),
        title: detail?.title ?? '',
        count: Math.max(1, detail?.count ?? 1),
        animate: !reduced,
      })
    }

    window.addEventListener(NOTES_UPDATED_EVENT, onNotesUpdated)
    return () => window.removeEventListener(NOTES_UPDATED_EVENT, onNotesUpdated)
  }, [])

  // 动画放完就把整层卸掉 —— 不留 18 个绝对定位的空节点在 DOM 里。
  useEffect(() => {
    if (burst === null) return
    const timer = window.setTimeout(() => setBurst(null), BURST_MS)
    return () => window.clearTimeout(timer)
  }, [burst])

  if (burst === null) return null

  return (
    <>
      {burst.animate ? (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
          {PIECES.map((piece, index) => (
            <span
              key={index}
              className="note-confetti"
              style={
                {
                  left: `${piece.left}%`,
                  width: `${piece.width}px`,
                  height: `${piece.height}px`,
                  background: piece.color,
                  animationDelay: `${piece.delay}ms`,
                  animationDuration: `${piece.duration}ms`,
                  '--nc-rot': `${piece.rotate}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      ) : null}
      {/* 彩带没有文字，读屏用户拿不到这个信号 —— 用一句中性陈述补上（不评价、不祝贺）。
          两条路径各有一句：手勾带标题（完成的是这一件）；懒补（Canvas 代判，
          可能一批几件、没有单条标题）只报数量 —— 都是事实陈述，不是祝贺。 */}
      <p role="status" className="sr-only">
        {burst.title !== ''
          ? t('notes.awardedSr', { title: burst.title })
          : t('notes.catchupSr', { count: burst.count })}
      </p>
    </>
  )
}
