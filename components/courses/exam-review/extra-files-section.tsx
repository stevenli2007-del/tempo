'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { readApiErrorMessage } from '@/lib/api/client-error'
import { createClient } from '@/lib/supabase/browser'
import {
  REVIEW_ALLOWED_EXTENSIONS,
  REVIEW_MAX_FILE_SIZE_BYTES,
  extractExtension,
  isAllowedReviewExtension,
} from '@/lib/review/storage'
import type { ReviewExtraFile } from '@/lib/review/store'
import type { CreateReviewFileResponse } from '@/types/review'

/**
 * 「上传额外文件」区（P0-3-31）—— 唯一的客户端组件。
 *
 * ### 为什么它必须是客户端
 * 上传要读用户选的文件并直传 Storage（ADR-009），这只能在浏览器里做。
 * 其余的勾选/提交都是服务端表单（见 `review-source-form.tsx`）。
 *
 * ### 流程（与 syllabus 上传同一形态，四个独立失败点）
 *   1. 前端预校验扩展名与大小 —— **只为体验**，不是权威；
 *   2. `POST …/review/files` 取上传票据（服务端再校验一遍，并建元数据行）；
 *   3. `uploadToSignedUrl(path, token, file)` 直接传到 Storage；
 *   4. `router.refresh()` 让服务端组件重新取数。
 *
 * ⚠️ **第 3 步失败时主动 DELETE 掉刚建的行** —— 否则会留下一条"有元数据、无对象"的
 * 悬挂行，用户会在清单里看到一个点开就报错的文件。这是刻意的清理。
 *
 * ⚠️ 本组件渲染的 checkbox 属于**外层服务端表单**（`name="extra"`），点它不会触发本组件的
 * 状态；而「移除」按钮必须显式 `type="button"` —— 表单里的按钮默认是 `submit`，
 * 不加会把"移除"点成"生成复习总结"。
 */
export function ExtraFilesSection({
  courseId,
  examId,
  extras,
  selectedExtraIds,
}: {
  courseId: string
  examId: string
  extras: ReviewExtraFile[]
  selectedExtraIds: readonly string[]
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = new Set(selectedExtraIds)
  const isBusy = pending || removing !== null

  async function handleUpload(file: File) {
    setError(null)

    // 前端预校验：同样的规则服务端会再跑一遍，这里是让用户在上传前就看到原因。
    const ext = extractExtension(file.name)
    if (ext === null || !isAllowedReviewExtension(ext)) {
      setError(`只支持 ${REVIEW_ALLOWED_EXTENSIONS.join(' / ')} 格式的文件`)
      return
    }
    if (file.size > REVIEW_MAX_FILE_SIZE_BYTES) {
      setError(`文件不能超过 ${REVIEW_MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`)
      return
    }

    setPending(true)
    try {
      const ticketResponse = await fetch(`/api/v1/courses/${courseId}/exams/${examId}/review/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          contentType: file.type === '' ? null : file.type,
        }),
      })

      if (!ticketResponse.ok) {
        setError(await readApiErrorMessage(ticketResponse, '上传'))
        return
      }

      const { file: created, upload } = (await ticketResponse.json()) as CreateReviewFileResponse

      const supabase = createClient()
      const { error: uploadError } = await supabase.storage
        .from(upload.bucket)
        .uploadToSignedUrl(upload.path, upload.token, file)

      if (uploadError) {
        setError('文件上传失败，请重试')
        // 清掉刚建的悬挂行（见文件头）。
        await fetch(`/api/v1/courses/${courseId}/exams/${examId}/review/files/${created.id}`, {
          method: 'DELETE',
        })
        return
      }

      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setPending(false)
      // 清空 input，否则连续选同一个文件不会再触发 change。
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleRemove(fileId: string) {
    setError(null)
    setRemoving(fileId)
    try {
      const response = await fetch(
        `/api/v1/courses/${courseId}/exams/${examId}/review/files/${fileId}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        setError(await readApiErrorMessage(response, '移除'))
        return
      }
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4" data-review-extras>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">上传额外文件</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            Tempo 没抓到的材料（老师发的纸质卷、截图整理的笔记）传上来一起总结。
            支持 {REVIEW_ALLOWED_EXTENSIONS.join(' / ')}，单个不超过{' '}
            {REVIEW_MAX_FILE_SIZE_BYTES / 1024 / 1024}MB。
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.pptx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void handleUpload(file)
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isBusy}
          className="h-8 shrink-0 rounded-md border border-border bg-background px-3 text-xs text-foreground disabled:opacity-50"
        >
          {pending ? '上传中…' : '上传文件'}
        </button>
      </div>

      {extras.length > 0 && (
        <ul className="mt-3 space-y-1" data-review-extra-list>
          {extras.map((extra) => (
            <li key={extra.id} className="flex items-center gap-2.5">
              <input
                type="checkbox"
                id={`extra-${extra.id}`}
                name="extra"
                value={extra.id}
                defaultChecked={selected.has(extra.id)}
              />
              <label
                htmlFor={`extra-${extra.id}`}
                className="min-w-0 flex-1 cursor-pointer truncate text-sm text-foreground"
                title={extra.displayName}
              >
                {extra.displayName}
              </label>
              <button
                type="button"
                onClick={() => void handleRemove(extra.id)}
                disabled={isBusy}
                className="shrink-0 text-xs text-ink-faint hover:text-destructive disabled:opacity-50"
              >
                {removing === extra.id ? '移除中…' : '移除'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
