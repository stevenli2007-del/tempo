'use client'

import type { SaveGradeComponentItem, StoredGradeComponent } from '@/types/sections'

import {
  INPUT_CLASS,
  ManualBadge,
  SectionFooter,
  excerptTitle,
  useSectionForm,
} from './shared'

/** 成绩构成：名称必填，权重 0-100 可空，备注可空。 */

type GradeDraft = SaveGradeComponentItem & {
  _source?: string | null
  _sourceExcerpt?: string | null
}

export function GradeComponentsForm({
  courseId,
  items,
}: {
  courseId: string
  items: StoredGradeComponent[]
}) {
  const form = useSectionForm<StoredGradeComponent, GradeDraft>({
    endpoint: `/api/v1/courses/${courseId}/grade-components`,
    initial: items,
    toDraft: (s) => ({
      id: s.id,
      name: s.name,
      weightPercent: s.weightPercent,
      notes: s.notes,
      _source: s.source,
      _sourceExcerpt: s.sourceExcerpt,
    }),
    blank: () => ({ name: '', weightPercent: null, notes: null }),
  })

  const total = form.rows.reduce((sum, row) => sum + (row.weightPercent ?? 0), 0)

  return (
    <div className="space-y-3">
      {form.rows.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          权重合计：
          <span className={total > 100 ? 'font-medium text-destructive' : 'font-medium'}>
            {formatNumber(total)}%
          </span>
          {total > 100 ? '（超过 100，请检查）' : ''}
        </p>
      )}

      {form.rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <input
              value={row.name}
              onChange={(e) => form.updateRow(index, { name: e.target.value })}
              placeholder="名称，如 Midterm"
              maxLength={120}
              title={excerptTitle(row._sourceExcerpt)}
              className={INPUT_CLASS}
            />
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={row.weightPercent ?? ''}
              onChange={(e) =>
                form.updateRow(index, {
                  weightPercent: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              placeholder="权重 %"
              className={`${INPUT_CLASS} w-24 shrink-0`}
            />
            {row._source === 'manual' ? <ManualBadge /> : null}
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
          <input
            value={row.notes ?? ''}
            onChange={(e) => form.updateRow(index, { notes: e.target.value || null })}
            placeholder="备注（可空）"
            maxLength={200}
            className={`${INPUT_CLASS} mt-2`}
          />
        </div>
      ))}

      <SectionFooter
        count={form.rows.length}
        addLabel="添加一条"
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

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
