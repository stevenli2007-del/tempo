'use client'

/**
 * 课程详情页左侧目录（P0-5-2）。
 *
 * 只做「导航」：点某项平滑滚到对应 section；滚动时高亮当前所在 section（IntersectionObserver）。
 * 不持有任何课程数据 —— items 由服务端把已翻译好的 label 传进来，本组件保持语言无关。
 * 桌面端竖向 sticky；移动端降级为顶部横向可滚动条。
 */
import { useEffect, useState } from 'react'

interface NavItem {
  id: string
  label: string
}

export function CourseDetailNav({ items }: { items: NavItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? '')

  useEffect(() => {
    const sections = items
      .map((it) => document.getElementById(it.id))
      .filter((el): el is HTMLElement => el !== null)
    if (sections.length === 0) return

    // 上下留出余量：section 顶部进入视口上 40% 区域时算「当前」。
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 },
    )

    sections.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [items])

  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <nav
      aria-label="课程详情目录"
      className="lg:sticky lg:top-20 lg:self-start overflow-x-auto"
    >
      <ul className="flex gap-1 lg:flex-col lg:gap-0.5 lg:overflow-visible">
        {items.map((it) => {
          const isActive = active === it.id
          return (
            <li key={it.id} className="shrink-0">
              <button
                type="button"
                onClick={() => go(it.id)}
                aria-current={isActive ? 'true' : undefined}
                className={[
                  'block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors lg:w-full lg:text-left',
                  isActive
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-ink-muted hover:bg-muted hover:text-ink',
                ].join(' ')}
              >
                {it.label}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
