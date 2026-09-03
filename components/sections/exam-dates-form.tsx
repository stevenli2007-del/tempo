'use client'

import type { SaveExamDateItem, StoredExamDate } from '@/types/sections'

import {
  INPUT_CLASS,
  ManualBadge,
  SectionFooter,
  TbdBadge,
  excerptTitle,
  useSectionForm,
} from './shared'

/**
 * 考试日期：examName 必填；examDate 留空 = TBD（status 由服务端从日期派生，表单不提交）。
 * 保存后会同步派生 tasks 里的考试任务（ADR-004），总览页的截止日期以此为准。
 */

type ExamDraft = SaveExamDateItem & {
  _source?: string | null
  _sourceExcerpt?: string | null
}

export function ExamDatesForm({
  courseId,
  items,
}: {
  courseId: string
  items: StoredExamDate[]
}) {
  const form = useSectionForm<StoredExamDate, ExamDraft>({
    endpoint: `/api/v1/courses/${courseId}/exam-dates`,
    initial: items,
    toDraft: (s) => ({
      id: s.id,
      examName: s.examName,
      examDate: s.examDate,
      examTime: s.examTime,
      location: s.location,
      _source: s.source,
      _sourceExcerpt: s.sourceExcerpt,
    }),
    blank: () => ({ examName: '', examDate: null, examTime: null, location: null }),
  })

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        日期留空 = 待定（TBD）；有日期的考试会自动进任务列表，截止到当天 23:59。
      </p>

      {form.rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <input
              value={row.examName}
              onChange={(e) => form.updateRow(index, { examName: e.target.value })}
              placeholder="考试名称，如 Midterm 1"
              maxLength={120}
              title={excerptTitle(row._sourceExcerpt)}
              className={INPUT_CLASS}
            />
            {row.examDate === null ? <TbdBadge /> : null}
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
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="date"
              value={row.examDate ?? ''}
              onChange={(e) =>
                form.updateRow(index, { examDate: e.target.value === '' ? null : e.target.value })
              }
              title={row.examDate === null ? '留空 = 待定（TBD）' : undefined}
              className={INPUT_CLASS}
            />
            <input
              value={row.examTime ?? ''}
              onChange={(e) => form.updateRow(index, { examTime: e.target.value || null })}
              placeholder="时间（可空）"
              maxLength={100}
              className={INPUT_CLASS}
            />
            <input
              value={row.location ?? ''}
              onChange={(e) => form.updateRow(index, { location: e.target.value || null })}
              placeholder="地点（可空）"
              maxLength={200}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      ))}

      <SectionFooter
        count={form.rows.length}
        addLabel="添加一场考试"
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
