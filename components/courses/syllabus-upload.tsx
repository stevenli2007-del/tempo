'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { readApiErrorMessage } from '@/lib/api/client-error'
import { createClient } from '@/lib/supabase/browser'
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES, extractExtension, isAllowedExtension } from '@/lib/syllabi'
import { Button } from '@/components/ui/button'
import type { CreateSyllabusResponse, Syllabus, SyllabusDownloadUrl } from '@/types/syllabus'

/**
 * Syllabus 上传入口（ADR-009：浏览器直传 Storage，文件不经我们服务端）。
 *
 * 流程：
 *   1. 前端预校验扩展名与大小 —— **只为体验**，不是权威；
 *   2. `POST /api/v1/courses/:id/syllabus` 取上传票据（服务端再校验一遍）；
 *   3. `uploadToSignedUrl(path, token, file)` 直接传到 Storage；
 *   4. `router.refresh()` 让服务端组件重新取数。
 *
 * 第 2、3 步是两个独立的失败点，任一失败都给出明确提示（CodingRules 7）。
 */

interface SyllabusUploadProps {
  courseId: string
  syllabus: Syllabus | null
}

type Pending = 'uploading' | 'downloading'

export function SyllabusUpload({ courseId, syllabus }: SyllabusUploadProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isBusy = pending !== null

  async function handleUpload(file: File) {
    setError(null)

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

      const { upload } = (await ticketResponse.json()) as CreateSyllabusResponse

      const supabase = createClient()
      const { error: uploadError } = await supabase.storage
        .from(upload.bucket)
        .uploadToSignedUrl(upload.path, upload.token, file)

      if (uploadError) {
        setError('文件上传失败，请重试')
        return
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
              {syllabus.extractStatus === 'extracted'
                ? '已提取文本，等待解析'
                : syllabus.extractStatus === 'failed'
                  ? (syllabus.extractError ?? '文本提取失败，可手动补充')
                  : '已上传，等待文本提取'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
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
            {pending === 'uploading' ? '上传中…' : '上传 syllabus'}
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
