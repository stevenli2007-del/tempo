'use client'

import type { SaveCourseOutlineItem, StoredCourseOutlineItem } from '@/types/sections'

import {
  INPUT_CLASS,
  ManualBadge,
  SectionFooter,
  excerptTitle,
  useSectionForm,
} from './shared'

/**
 * 课程大纲：weekLabel 可空，topic 必填。
 * 顺序 = 数组顺序（保存时服务端按位置派生 orderIndex，不从表单收）。
 * 上移/下移直接操作数组 —— 重排序不算解析错误，不进修正 diff。
 */

type OutlineDraft = SaveCourseOutlineItem & {
  _source?: string | null
  _sourceExcerpt?: string | null
}

export function OutlineItemsForm({
  courseId,
  items,
}: {
  courseId: string
  items: StoredCourseOutlineItem[]
}) {
  const form = useSectionForm<StoredCourseOutlineItem, OutlineDraft>({
    endpoint: `/api/v1/courses/${courseId}/outline-items`,
    initial: items,
    toDraft: (s) => ({
      id: s.id,
      weekLabel: s.weekLabel,
      topic: s.topic,
      _source: s.source,
      _sourceExcerpt: s.sourceExcerpt,
    }),
    blank: () => ({ weekLabel: null, topic: '' }),
  })

  return (
    <div className="space-y-3">
      {form.rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">
              {index + 1}
            </span>
            <input
              value={row.weekLabel ?? ''}
              onChange={(e) => form.updateRow(index, { weekLabel: e.target.value || null })}
              placeholder="周次（可空）"
              maxLength={50}
              className={`${INPUT_CLASS} w-32 shrink-0`}
            />
            <input
              value={row.topic}
              onChange={(e) => form.updateRow(index, { topic: e.target.value })}
              placeholder="主题"
              maxLength={200}
              title={excerptTitle(row._sourceExcerpt)}
              className={INPUT_CLASS}
            />
            {row._source === 'manual' ? <ManualBadge /> : null}
            <div className="flex shrink-0 flex-col">
              <button
                type="button"
                onClick={() => form.moveRow(index, -1)}
                disabled={form.saving || index === 0}
                title="上移"
                className="px-1 text-[10px] leading-3 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => form.moveRow(index, 1)}
                disabled={form.saving || index === form.rows.length - 1}
                title="下移"
                className="px-1 text-[10px] leading-3 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                ▼
              </button>
            </div>
            <button
              type="button"
              onClick={() => form.removeRow(index)}
              disabled={form.saving}
              title="删除这条"
              className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      <SectionFooter
        count={form.rows.length}
        addLabel="添加一周"
        onAdd={form.addRow}
        dirty={form.dirty}
        saving={form.saving}
        justSaved={form.justSaved}
        error={form.error}
        onSave={() => void form.save()}
        onReset={form.reset}
      />
    </div>
  )
}
