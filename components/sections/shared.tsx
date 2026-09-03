'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { readApiErrorMessage } from '@/lib/api/client-error'

/**
 * 五个板块编辑表单的共用件（P0-1-6）。
 *
 * 设计约束（来自 `types/sections.ts` 与契约 §4）：
 * - 保存是 **PUT 全量替换**：表单里有什么就提交什么（带 id 的更新 / 不带的插入 / 库里多的删除）。
 * - draft 里只放 `Save*Item` 的字段 + 以 `_` 开头的**客户端专用元数据**（`_source` /
 *   `_sourceExcerpt`，用于渲染「手动添加」标记和原文摘录提示）—— 提交前统一剥掉，
 *   服务端校验器永远只看到契约里的字段。
 * - `ExamDate.status` / 大纲 `orderIndex` 都不由表单提交（服务端派生）。
 */

/** 表单行上的客户端元数据（下划线开头，提交前剥掉）。 */
export type RowMeta = {
  _source?: string | null
  _sourceExcerpt?: string | null
}

/** 剥掉 `_` 开头的键，剩下的就是 PUT 的 items。 */
function stripRowMeta(rows: Array<Record<string, unknown>>): unknown[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_'))),
  )
}

export const INPUT_CLASS =
  'h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

/** 「手动添加」小标记：source='manual' 的行能被一眼认出来（开工提示要求）。 */
export function ManualBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      手动
    </span>
  )
}

/** 考试行「日期待定」标记（验收标准：TBD 状态可正常展示）。 */
export function TbdBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
      TBD
    </span>
  )
}

/** 原文摘录提示。`sourceExcerpt` 是抗幻觉的核心手段，编辑时要能核对依据。 */
export function excerptTitle(excerpt: string | null | undefined): string | undefined {
  return excerpt ? `原文摘录：${excerpt}` : undefined
}

export interface UseSectionFormOptions<TStored, TDraft extends { id?: string } & RowMeta> {
  /** PUT 端点，如 `/api/v1/courses/:id/grade-components`。 */
  endpoint: string
  /** 服务端读到的板块数据（初值，也是保存/刷新后同步的目标）。 */
  initial: TStored[]
  /** Stored → draft（含客户端元数据）。 */
  toDraft: (stored: TStored) => TDraft
  /** 新增一行的空白 draft。 */
  blank: () => TDraft
}

export interface SectionFormState<TDraft> {
  rows: TDraft[]
  updateRow: (index: number, patch: Partial<TDraft>) => void
  addRow: () => void
  removeRow: (index: number) => void
  /** 大纲专用：上下移动 = 改数组顺序（orderIndex 由服务端按位置派生）。 */
  moveRow: (index: number, delta: number) => void
  dirty: boolean
  saving: boolean
  error: string | null
  justSaved: boolean
  save: () => Promise<void>
  reset: () => void
}

/**
 * 一个板块的表单状态机（非受控 + 用完自己保存）。
 *
 * ⚠️ **服务端数据变了要重挂载，不要在这里同步 props**：
 * `SectionEditor` 给每个表单一个 `key`（板块数据的序列化），数据一变 React 直接重挂载，
 * 表单拿到新初值。这是 React 官方的「用 key 重置状态」模式 —— 比在 effect 里 setState 干净，
 * 也不会出现「props 每次渲染都是新数组 → 天天重置」的问题。
 *
 * 代价：服务端数据变化时（重新解析、别处刷新）未保存的编辑会丢。
 * Phase 0 接受 —— 重新解析有二次确认，且确认文案里写明了这一点。
 */
export function useSectionForm<TStored, TDraft extends { id?: string } & RowMeta>(
  options: UseSectionFormOptions<TStored, TDraft>,
): SectionFormState<TDraft> {
  const { endpoint, initial, toDraft, blank } = options
  const router = useRouter()

  const initialDrafts = useMemo(() => initial.map(toDraft), [initial, toDraft])
  const [rows, setRows] = useState<TDraft[]>(initialDrafts)
  /** 上一次保存成功（或同步）时的快照，dirty 以它为基准。 */
  const [snapshot, setSnapshot] = useState<TDraft[]>(initialDrafts)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dirty = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(snapshot),
    [rows, snapshot],
  )

  const updateRow = useCallback((index: number, patch: Partial<TDraft>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }, [])

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, blank()])
  }, [blank])

  const removeRow = useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const moveRow = useCallback((index: number, delta: number) => {
    setRows((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) {
        return prev
      }
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setRows(snapshot)
    setError(null)
  }, [snapshot])

  const save = useCallback(async () => {
    setError(null)
    setSaving(true)
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: stripRowMeta(rows as Array<Record<string, unknown>>) }),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, '保存'))
        return
      }
      const body = (await response.json()) as { data: TStored[] }
      // 以服务端返回为准重建 draft：新行拿到 id，后续再保存就是 update 而不是重复 insert。
      const next = body.data.map(toDraft)
      setRows(next)
      setSnapshot(next)
      setJustSaved(true)
      if (savedTimer.current) {
        clearTimeout(savedTimer.current)
      }
      savedTimer.current = setTimeout(() => setJustSaved(false), 2000)
      // 让 dashboard 的服务端数据（派生 task 等）跟上。
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setSaving(false)
    }
  }, [endpoint, rows, toDraft, router])

  useEffect(() => {
    return () => {
      if (savedTimer.current) {
        clearTimeout(savedTimer.current)
      }
    }
  }, [])

  return { rows, updateRow, addRow, removeRow, moveRow, dirty, saving, error, justSaved, save, reset }
}

/** 五个表单共用的操作条（添加 + 保存 + 状态）。 */
export function SectionFooter({
  count,
  addLabel,
  onAdd,
  dirty,
  saving,
  justSaved,
  error,
  onSave,
  onReset,
}: {
  count: number
  addLabel: string
  onAdd: () => void
  dirty: boolean
  saving: boolean
  justSaved: boolean
  error: string | null
  onSave: () => void
  onReset: () => void
}) {
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {count === 0 ? '这个板块还没有条目' : `共 ${count} 条`}
        </span>
        <div className="flex items-center gap-2">
          {justSaved ? (
            <span role="status" className="text-xs text-muted-foreground">
              已保存
            </span>
          ) : null}
          {dirty ? (
            <button
              type="button"
              onClick={onReset}
              disabled={saving}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              放弃更改
            </button>
          ) : null}
          <button
            type="button"
            onClick={onAdd}
            disabled={saving}
            className="text-xs text-foreground underline-offset-2 hover:underline"
          >
            {addLabel}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
