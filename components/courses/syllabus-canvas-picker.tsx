'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { readApiErrorMessage } from '@/lib/api/client-error'
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import { readInternalPath } from '@/lib/internal-path'
import { Button } from '@/components/ui/button'
import type { SyllabusImportCandidate } from '@/lib/syllabus-import/candidates'

/**
 * 「从 Canvas 资料选一份」（P0-3-30 的第二个 syllabus 来源）。
 *
 * ### 为什么不替换掉上传按钮
 * 老师把 syllabus 传到 Canvas 上时，用户不必再找一遍本地文件；
 * 但老师只发纸质版 / 发在别处时，上传那条路还得在。所以这里是**并列第二个入口**，
 * 上传按钮的行为一字未改。
 *
 * ### 三条纪律
 * 1. **抽不动的文件照样列出来**，只是灰掉 + 原因 —— 不显示会被读成
 *    "Canvas 上没传大纲"（诬告）。原因一律是「Tempo 读不了」，不是"这份文件没内容"。
 * 2. **点一下才下载**：列清单只拿元数据（ADR-026 的红线：同步路径零下载）。
 * 3. **已有 syllabus 时先确认**：替换会覆盖 syllabus 来源的条目，必须用户点头
 *    （服务端还会再挡一次 `409 syllabus_exists` —— 两道防线，不靠前端自觉）。
 */

type PickerProps = {
  courseId: string
  lang: Lang
  /** 这门课当前有没有 syllabus（有 → 导入前必须确认）。 */
  hasSyllabus: boolean
}

type State =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'list'; candidates: SyllabusImportCandidate[] }

export function SyllabusCanvasPicker({ courseId, lang, hasSyllabus }: PickerProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>({ kind: 'closed' })
  /** 正在导入的文件（防止连点）。 */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 待确认的文件：这门课已有 syllabus，替换要用户点头。 */
  const [pending, setPending] = useState<SyllabusImportCandidate | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openPanel() {
    setOpen(true)
    setError(null)
    setNotice(null)
    setPending(null)
    setState({ kind: 'loading' })
    try {
      const response = await fetch(
        `/api/v1/courses/${encodeURIComponent(courseId)}/syllabus/candidates`,
      )
      if (!response.ok) {
        setState({ kind: 'error', message: await readApiErrorMessage(response, t(lang, 'action.listFiles'), lang) })
        return
      }
      const payload = (await response.json()) as { candidates?: SyllabusImportCandidate[] }
      setState({ kind: 'list', candidates: Array.isArray(payload.candidates) ? payload.candidates : [] })
    } catch {
      setState({ kind: 'error', message: t(lang, 'common.networkError') })
    }
  }

  function closePanel() {
    setOpen(false)
    setState({ kind: 'closed' })
    setPending(null)
  }

  async function runImport(candidate: SyllabusImportCandidate, replace: boolean) {
    setBusyId(candidate.id)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(
        `/api/v1/courses/${encodeURIComponent(courseId)}/syllabus/import`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ courseFileId: candidate.id, replace }),
        },
      )

      if (!response.ok) {
        const message = await readApiErrorMessage(response, t(lang, 'action.import'), lang)
        // 409 = 服务端的第二道防线：已有 syllabus 且没说要替换（前端不拦也不会写坏）。
        if (response.status === 409) {
          setPending(candidate)
          setError(message)
        } else {
          setError(message)
        }
        return
      }

      const result = (await response.json()) as {
        cached?: boolean
        counts?: { exams: number; gradeComponents: number }
        failedSections?: { section: string }[]
      }
      const counts = result.counts ?? { exams: 0, gradeComponents: 0 }
      const failed = result.failedSections ?? []
      setPending(null)
      setNotice(
        result.cached
          ? t(lang, 'picker.cached', { exams: counts.exams, gc: counts.gradeComponents })
          : t(lang, 'picker.imported', { name: candidate.displayName, exams: counts.exams, gc: counts.gradeComponents }) +
              (failed.length > 0 ? ' ' + t(lang, 'picker.failedSections', { n: failed.length }) : ''),
      )
      setState({ kind: 'closed' })
      setOpen(false)
      router.refresh()
    } catch {
      setError(t(lang, 'common.networkError'))
    } finally {
      setBusyId(null)
    }
  }

  function pick(candidate: SyllabusImportCandidate) {
    if (!candidate.supported) return
    // 已有 syllabus → 先确认（服务端还会再挡一次）。
    if (hasSyllabus) {
      setPending(candidate)
      return
    }
    void runImport(candidate, false)
  }

  return (
    <div className="mt-3">
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => void openPanel()}>
          {t(lang, 'picker.cta')}
        </Button>
      ) : (
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">{t(lang, 'picker.pickTitle')}</p>
            <Button variant="ghost" size="sm" onClick={closePanel} disabled={busyId !== null}>
              {t(lang, 'canvas.collapse')}
            </Button>
          </div>

          {state.kind === 'loading' ? (
            <p className="mt-2 text-xs text-muted-foreground">{t(lang, 'picker.loading')}</p>
          ) : null}

          {state.kind === 'error' ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {state.message}
            </p>
          ) : null}

          {state.kind === 'list' && state.candidates.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(lang, 'picker.empty')}
            </p>
          ) : null}

          {state.kind === 'list' && state.candidates.length > 0 ? (
            <ul className="mt-2 max-h-64 space-y-1 overflow-auto">
              {state.candidates.map((candidate) => {
                const disabled = !candidate.supported || busyId !== null
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => pick(candidate)}
                      className={[
                        'flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left text-xs',
                        candidate.supported
                          ? 'border-border hover:bg-muted'
                          : 'cursor-not-allowed border-border/50 bg-muted/30 text-muted-foreground',
                      ].join(' ')}
                    >
                      <span className="min-w-0 flex-1 truncate">{candidate.displayName}</span>
                      {candidate.looksLikeSyllabus ? (
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {t(lang, 'picker.syllabusChip')}
                        </span>
                      ) : null}
                      {busyId === candidate.id ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {t(lang, 'picker.parsingFile')}
                        </span>
                      ) : null}
                    </button>
                    {!candidate.supported ? (
                      // 「Tempo 读不了」口径，不是"这份文件没内容"。
                      <p className="mt-0.5 pl-2 text-[10px] text-muted-foreground">
                        {candidate.reason}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}

          {pending ? (
            <div className="mt-3 rounded border border-border bg-muted/40 p-2">
              <p className="text-xs text-foreground">
                {t(lang, 'picker.replaceConfirm', { name: pending.displayName })}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void runImport(pending, true)}
                  disabled={busyId !== null}
                >
                  {t(lang, 'picker.confirmImport')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                  {t(lang, 'common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}

          {notice ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * syllabus 的「查看」入口。
 *
 * 手动上传的行 `filePath` 是 Storage 对象路径（要现签下载链）；
 * 本卡导入的行存的是**站内路径** `/courses/{cid}/files/{fid}` ——
 * 那里没有 Storage 对象，走下载端点必然失败，所以直接链到资料页。
 */
export function SyllabusFileLink({ filePath, lang }: { filePath: string; lang: Lang }): React.ReactElement | null {
  const internal = readInternalPath(filePath)
  if (!internal) return null
  return (
    <Link href={internal} className="text-xs text-muted-foreground underline">
      {t(lang, 'picker.openInFiles')}
    </Link>
  )
}
