import {
  ManualBadge,
  TbdBadge,
} from '@/components/sections/shared'
import type {
  StoredCourseOutlineItem,
  StoredExamDate,
  StoredGradeComponent,
  StoredOfficeHour,
  StoredSubmissionPolicy,
} from '@/types/sections'

/**
 * 五板块的**只读展示**（P0-1-8）。
 *
 * 验收标准要求：缺失项显示 TBD 而不是空白 —— 空白会让用户分不清
 * 「syllabus 里没写」和「还没解析」。这一层就是干这个的：
 * 值为 null → 显示 TBD chip；整个板块为空 → 显示「还没有内容」。
 *
 * 只做展示，不含交互（导入到 SectionEditor 里，与编辑表单共用同一批 `Stored*` 类型）。
 */

const ROW_CLASS = 'rounded-md border border-border bg-card/60 px-3 py-2'

function EmptySection({ hint }: { hint: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      这个板块还没有内容<span className="ml-1 text-muted-foreground/70">（{hint}）</span>
    </p>
  )
}

/** 原文摘录：抗幻觉的核对依据，展示层要给得出来（CodingRules 7）。 */
function Excerpt({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/70" title={text}>
      {text}
    </p>
  )
}

export function GradeComponentsView({ items }: { items: StoredGradeComponent[] }) {
  if (items.length === 0) {
    return <EmptySection hint="解析后自动填入，或点「编辑」手动补" />
  }

  const total = items.reduce((sum, item) => sum + (item.weightPercent ?? 0), 0)
  const knownCount = items.filter((item) => item.weightPercent !== null).length

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className={ROW_CLASS}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{item.name}</span>
              {item.weightPercent !== null ? (
                <span className="text-xs text-muted-foreground">{item.weightPercent}%</span>
              ) : (
                <TbdBadge />
              )}
              {item.source === 'manual' ? <ManualBadge /> : null}
            </div>
            {item.notes ? (
              <p className="mt-1 text-xs text-muted-foreground">{item.notes}</p>
            ) : null}
            <Excerpt text={item.sourceExcerpt} />
          </div>
        ))}
      </div>
      {/* 权重加起来不是 100% 是常见的数据问题，明确说出来比让用户自己算好。 */}
      {knownCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          已知权重合计 {total}%
          {total !== 100 ? '（不是 100%，可能有缺失或 syllabus 本身没写全）' : ''}
        </p>
      ) : null}
    </div>
  )
}

export function OutlineItemsView({ items }: { items: StoredCourseOutlineItem[] }) {
  if (items.length === 0) {
    return <EmptySection hint="解析后自动填入，或点「编辑」手动补" />
  }
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className={`${ROW_CLASS} flex items-baseline gap-2`}>
          <span className="w-6 shrink-0 text-xs text-muted-foreground">{item.orderIndex}</span>
          {item.weekLabel ? (
            <span className="shrink-0 text-xs text-muted-foreground">{item.weekLabel}</span>
          ) : null}
          <span className="text-sm text-foreground">{item.topic}</span>
          {item.source === 'manual' ? <ManualBadge /> : null}
        </div>
      ))}
    </div>
  )
}

export function ExamDatesView({ items }: { items: StoredExamDate[] }) {
  if (items.length === 0) {
    return <EmptySection hint="解析后自动填入，或点「编辑」手动补" />
  }
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className={ROW_CLASS}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{item.examName}</span>
            {item.examDate ? (
              <span className="text-xs text-muted-foreground">{item.examDate}</span>
            ) : (
              <TbdBadge />
            )}
            {item.examTime ? (
              <span className="text-xs text-muted-foreground">{item.examTime}</span>
            ) : null}
            {item.location ? (
              <span className="text-xs text-muted-foreground">{item.location}</span>
            ) : null}
            {item.source === 'manual' ? <ManualBadge /> : null}
          </div>
          <Excerpt text={item.sourceExcerpt} />
        </div>
      ))}
    </div>
  )
}

export function OfficeHoursView({ items }: { items: StoredOfficeHour[] }) {
  if (items.length === 0) {
    return <EmptySection hint="解析后自动填入，或点「编辑」手动补" />
  }
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className={ROW_CLASS}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{item.personName}</span>
            {item.dayOfWeek ? (
              <span className="text-xs text-muted-foreground">{item.dayOfWeek}</span>
            ) : (
              <TbdBadge />
            )}
            {item.startTime || item.endTime ? (
              <span className="text-xs text-muted-foreground">
                {[item.startTime, item.endTime].filter(Boolean).join(' – ')}
              </span>
            ) : null}
            {item.location ? (
              <span className="text-xs text-muted-foreground">{item.location}</span>
            ) : null}
            {item.source === 'manual' ? <ManualBadge /> : null}
          </div>
          <Excerpt text={item.sourceExcerpt} />
        </div>
      ))}
    </div>
  )
}

export function SubmissionPoliciesView({ items }: { items: StoredSubmissionPolicy[] }) {
  if (items.length === 0) {
    return <EmptySection hint="解析后自动填入，或点「编辑」手动补" />
  }
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className={ROW_CLASS}>
          <div className="flex flex-wrap items-center gap-2">
            {item.platformName ? (
              <span className="text-xs font-medium text-foreground">{item.platformName}</span>
            ) : (
              <TbdBadge />
            )}
            {item.source === 'manual' ? <ManualBadge /> : null}
          </div>
          <p className="mt-1 text-sm text-foreground">{item.description}</p>
          <Excerpt text={item.sourceExcerpt} />
        </div>
      ))}
    </div>
  )
}
