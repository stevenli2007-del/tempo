'use client'

/**
 * 课程详情页左侧目录（P0-5-2 修订版）。
 *
 * 现在是「标签页切换」：点某项目只显示对应面板，而不是整页滚动。
 * 不持有任何课程数据 —— items 由服务端把已翻译好的 label 传进来，本组件保持语言无关。
 * 桌面端竖向 sticky；移动端降级为顶部横向可滚动条。
 */

export interface NavItem {
  id: string
  label: string
}

export function CourseDetailNav({
  items,
  activeId,
  onSelect,
}: {
  items: NavItem[]
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <nav
      aria-label="课程详情目录"
      className="overflow-x-auto lg:sticky lg:top-20 lg:self-start"
    >
      <ul className="flex gap-1 lg:flex-col lg:gap-0.5 lg:overflow-visible">
        {items.map((it) => {
          const isActive = activeId === it.id
          return (
            <li key={it.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(it.id)}
                aria-current={isActive ? 'true' : undefined}
                className={[
                  'block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors lg:w-full lg:text-left',
                  isActive
                    ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
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
