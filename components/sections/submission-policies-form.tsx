'use client'

import type { SaveSubmissionPolicyItem, StoredSubmissionPolicy } from '@/types/sections'

import {
  INPUT_CLASS,
  ManualBadge,
  SectionFooter,
  excerptTitle,
  useSectionForm,
} from './shared'

/** 提交政策：description 必填（textarea），platformName 可空。 */

type PolicyDraft = SaveSubmissionPolicyItem & {
  _source?: string | null
  _sourceExcerpt?: string | null
}

export function SubmissionPoliciesForm({
  courseId,
  items,
}: {
  courseId: string
  items: StoredSubmissionPolicy[]
}) {
  const form = useSectionForm<StoredSubmissionPolicy, PolicyDraft>({
    endpoint: `/api/v1/courses/${courseId}/submission-policies`,
    initial: items,
    toDraft: (s) => ({
      id: s.id,
      description: s.description,
      platformName: s.platformName,
      _source: s.source,
      _sourceExcerpt: s.sourceExcerpt,
    }),
    blank: () => ({ description: '', platformName: null }),
  })

  return (
    <div className="space-y-3">
      {form.rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            {row._source === 'manual' ? <ManualBadge /> : null}
            <button
              type="button"
              onClick={() => form.removeRow(index)}
              disabled={form.saving}
              title="删除这条"
              className="ml-auto shrink-0 text-xs text-muted-foreground hover:text-destructive"
            >
              删除
            </button>
          </div>
          <textarea
            value={row.description}
            onChange={(e) => form.updateRow(index, { description: e.target.value })}
            placeholder="政策描述，如 Homework submitted via Gradescope, no late days"
            maxLength={500}
            rows={3}
            title={excerptTitle(row._sourceExcerpt)}
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <input
            value={row.platformName ?? ''}
            onChange={(e) => form.updateRow(index, { platformName: e.target.value || null })}
            placeholder="平台（可空），如 Gradescope"
            maxLength={100}
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
