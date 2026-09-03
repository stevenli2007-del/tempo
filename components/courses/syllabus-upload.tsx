'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { readApiErrorMessage } from '@/lib/api/client-error'
import { syllabusStatusText } from '@/components/courses/syllabus-status'
import { createClient } from '@/lib/supabase/browser'
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES, extractExtension, isAllowedExtension } from '@/lib/syllabi'
import { Button } from '@/components/ui/button'
import type {
  CreateSyllabusResponse,
  Syllabus,
  SyllabusDownloadUrl,
  SyllabusExtractResponse,
  SyllabusParseResponse,
} from '@/types/syllabus'

/**
 * Syllabus 上传入口（ADR-009：浏览器直传 Storage，文件不经我们服务端）。
 *
 * 流程：
 *   1. 前端预校验扩展名与大小 —— **只为体验**，不是权威；
 *   2. `POST /api/v1/courses/:id/syllabus` 取上传票据（服务端再校验一遍）；
 *   3. `uploadToSignedUrl(path, token, file)` 直接传到 Storage；
 *   4. `POST /api/v1/syllabi/:id/extract` 提取文本（P0-1-2）；
 *   5. `router.refresh()` 让服务端组件重新取数。
 *
 * 第 2、3、4 步是三个独立的失败点，任一失败都给出明确提示（CodingRules 7）。
 *
 * ⚠️ **第 4 步失败不算上传失败** —— 文件已经存下来了，只是读不出文字。
 * 所以走 `notice`（提示色）而不是 `error`（错误色），文案也要说清「上传成功，但…」。
 *
 * P0-1-6 补齐第 5 拍的 UI 触发：「开始解析」（`POST /parse`，同步约 3-5 秒）。
 * `parseStatus` 已是 `completed` 时改走 `/reparse`，带二次确认 —— 重解析会整体替换
 * syllabus 来源的行（`is_confirmed` 不保护，5a 实测教训），用户必须知情。
 */

interface SyllabusUploadProps {
  courseId: string
  syllabus: Syllabus | null
}

type Pending = 'uploading' | 'extracting' | 'downloading' | 'parsing'

export function SyllabusUpload({ courseId, syllabus }: SyllabusUploadProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 非致命提示（如"上传成功但读不出文字"）。用提示色，跟真正的失败区分开。 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 提取到的文本预览，供用户立刻确认"抽出来的东西对不对"。 */
  const [preview, setPreview] = useState<string | null>(null)
  /** 重新解析的二次确认（和删除确认同一个模式）。 */
  const [isConfirmingReparse, setIsConfirmingReparse] = useState(false)

  const isBusy = pending !== null

  async function handleUpload(file: File) {
    setError(null)
    setNotice(null)
    setPreview(null)

    // 前端预校验：同样的规则服务端会再跑一遍，这里是让用户在上传前就看到原因。
    const ext = extractExtension(file.name)
    if (ext === null || !isAllowedExtension(ext)) {
      setError(`只支持 ${ALLOWED_EXTENSIONS.join(' / ')} 格式的文件`)
      return
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError(`文件不能超过 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`)
      return
    }

    setPending('uploading')
    try {
      const ticketResponse = await fetch(`/api/v1/courses/${courseId}/syllabus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
      })

      if (!ticketResponse.ok) {
        setError(await readApiErrorMessage(ticketResponse, '上传'))
        return
      }

      const { syllabus: created, upload } = (await ticketResponse.json()) as CreateSyllabusResponse

      const supabase = createClient()
      const { error: uploadError } = await supabase.storage
        .from(upload.bucket)
        .uploadToSignedUrl(upload.path, upload.token, file)

      if (uploadError) {
        setError('文件上传失败，请重试')
        return
      }

      // 第 4 拍：文件已在 Storage，现在才能提取文本。
      setPending('extracting')
      const extractResponse = await fetch(`/api/v1/syllabi/${created.id}/extract`, {
        method: 'POST',
      })

      if (!extractResponse.ok) {
        // 到不了这里基本只有 409（文件没传完）或网络问题。文件本身已经存下来了，
        // 所以也走 notice 而不是 error —— 用户不需要重新上传。
        setNotice(await readApiErrorMessage(extractResponse, '文本提取'))
      } else {
        const result = (await extractResponse.json()) as SyllabusExtractResponse
        setPreview(result.previewText)
        if (result.syllabus.extractStatus === 'failed') {
          setNotice(
            `上传成功，但这份文件读不出文字：${result.syllabus.extractError ?? '原因未知'}`,
          )
        }
      }

      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setPending(null)
      // 清空 input，否则连续选同一个文件不会再触发 change。
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    }
  }

  async function handleDownload() {
    if (!syllabus) return
    setError(null)
    setPending('downloading')
    try {
      const response = await fetch(`/api/v1/syllabi/${syllabus.id}/download`)
      if (!response.ok) {
        setError(await readApiErrorMessage(response, '获取下载链接'))
        return
      }
      const { downloadUrl } = (await response.json()) as SyllabusDownloadUrl
      window.open(downloadUrl, '_blank', 'noopener,noreferrer')
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setPending(null)
    }
  }

  /**
   * 触发解析（`/parse` 或 `/reparse`）。同步接口，实测 3-5 秒。
   *
   * `already_parsed` 的 409 不当错误处理：说明数据已经在库里，刷新即可 ——
   * 常见于双击或别处刚解析完。
   */
  async function handleParse(mode: 'parse' | 'reparse') {
    if (!syllabus) return
    setError(null)
    setNotice(null)
    setPending('parsing')
    try {
      const response = await fetch(`/api/v1/syllabi/${syllabus.id}/${mode}`, {
        method: 'POST',
      })
      if (!response.ok) {
        if (response.status === 409) {
          // already_parsed / text_not_ready 都不是「坏了」，刷新即可看到真实状态。
          router.refresh()
          return
        }
        setError(await readApiErrorMessage(response, mode === 'reparse' ? '重新解析' : '解析'))
        return
      }

      const result = (await response.json()) as SyllabusParseResponse
      // HTTP 200 不代表全成功（ADR-012）：部分失败要在界面上说出来，不能静默吞掉。
      if (result.failedSections.length > 0) {
        setNotice(
          `解析完成，但 ${result.failedSections.length} 个板块没解析出来（${result.failedSections
            .map((s) => s.section)
            .join('、')}）。可以点下方「五个板块」手动补。`,
        )
      }
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.pptx"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            void handleUpload(file)
          }
        }}
      />

      {syllabus ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={syllabus.fileName}>
              {syllabus.fileName}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {syllabusStatusText(syllabus)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* 第 5 拍：解析触发。没解析过 / 解析失败 → 开始（重试）；已完成 → 重新解析（带确认）。 */}
            {syllabus.extractStatus === 'extracted' && syllabus.parseStatus !== 'completed' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleParse('parse')}
                disabled={isBusy}
              >
                {pending === 'parsing'
                  ? '解析中…'
                  : syllabus.parseStatus === 'failed'
                    ? '重试解析'
                    : '开始解析'}
              </Button>
            ) : null}
            {syllabus.parseStatus === 'completed' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError(null)
                  setIsConfirmingReparse(true)
                }}
                disabled={isBusy}
              >
                重新解析
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleDownload()}
              disabled={isBusy}
            >
              {pending === 'downloading' ? '获取中…' : '查看'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={isBusy}
            >
              重新上传
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">还没有 syllabus</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={isBusy}
          >
            {pending === 'uploading'
              ? '上传中…'
              : pending === 'extracting'
                ? '提取中…'
                : '上传 syllabus'}
          </Button>
        </div>
      )}

      {/* 提取中给个明确反馈 —— 20MB 的 PDF 可能要好几秒，静默会让人以为卡死了。 */}
      {pending === 'extracting' ? (
        <p className="mt-3 text-xs text-muted-foreground">文件已上传，正在提取文本…</p>
      ) : null}
      {pending === 'parsing' ? (
        <p className="mt-3 text-xs text-muted-foreground">
          正在解析五个板块（约 3-5 秒），完成后数据会出现在下方「五个板块」里…
        </p>
      ) : null}

      {isConfirmingReparse ? (
        <div className="mt-3 rounded-lg border border-border bg-background p-3">
          <p className="text-sm text-foreground">
            重新解析会用当前文本整体替换解析来源的条目；手动添加的条目保留，
            但未保存的修改会丢失。确定重跑吗？
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setIsConfirmingReparse(false)
                void handleParse('reparse')
              }}
              disabled={isBusy}
            >
              确认重跑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsConfirmingReparse(false)}
              disabled={isBusy}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {preview ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            查看提取到的文本（前 {preview.length} 字符）
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 text-xs text-foreground">
            {preview}
          </pre>
        </details>
      ) : null}
    </div>
  )
}
