'use client'

import type { SaveOfficeHourItem, StoredOfficeHour } from '@/types/sections'

import { useI18n, useT } from '@/lib/i18n/use-i18n'

import {
  INPUT_CLASS,
  ManualBadge,
  SectionFooter,
  excerptTitle,
  useSectionForm,
} from './shared'

/** Office Hour：personName 必填，其余可空（dayOfWeek 是自由文本，如 Tuesday）。 */

type OfficeHourDraft = SaveOfficeHourItem & {
  _source?: string | null
  _sourceExcerpt?: string | null
}

export function OfficeHoursForm({
  courseId,
  items,
}: {
  courseId: string
  items: StoredOfficeHour[]
}) {
  const t = useT()
  const { lang } = useI18n()
  const form = useSectionForm<StoredOfficeHour, OfficeHourDraft>({
    endpoint: `/api/v1/courses/${courseId}/office-hours`,
    initial: items,
    toDraft: (s) => ({
      id: s.id,
      personName: s.personName,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
      location: s.location,
      _source: s.source,
      _sourceExcerpt: s.sourceExcerpt,
    }),
    blank: () => ({ personName: '', dayOfWeek: null, startTime: null, endTime: null, location: null }),
  })

  return (
    <div className="space-y-3">
      {form.rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <input
              value={row.personName}
              onChange={(e) => form.updateRow(index, { personName: e.target.value })}
              placeholder={t('office.namePh')}
              maxLength={120}
              title={excerptTitle(row._sourceExcerpt, lang)}
              className={INPUT_CLASS}
            />
            {row._source === 'manual' ? <ManualBadge /> : null}
            <button
              type="button"
              onClick={() => form.removeRow(index)}
              disabled={form.saving}
              title={t('sections.deleteRow')}
              className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
            >
              {t('sections.delete')}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
            <input
              value={row.dayOfWeek ?? ''}
              onChange={(e) => form.updateRow(index, { dayOfWeek: e.target.value || null })}
              placeholder={t('office.dayPh')}
              maxLength={50}
              className={INPUT_CLASS}
            />
            <input
              value={row.startTime ?? ''}
              onChange={(e) => form.updateRow(index, { startTime: e.target.value || null })}
              placeholder={t('office.startPh')}
              maxLength={50}
              className={INPUT_CLASS}
            />
            <input
              value={row.endTime ?? ''}
              onChange={(e) => form.updateRow(index, { endTime: e.target.value || null })}
              placeholder={t('office.endPh')}
              maxLength={50}
              className={INPUT_CLASS}
            />
            <input
              value={row.location ?? ''}
              onChange={(e) => form.updateRow(index, { location: e.target.value || null })}
              placeholder={t('office.locPh')}
              maxLength={200}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      ))}

      <SectionFooter
        count={form.rows.length}
        addLabel={t('office.add')}
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
