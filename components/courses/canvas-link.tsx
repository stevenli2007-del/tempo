'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { CanvasConnectForm } from '@/components/courses/canvas-connect-form'
import { groupCanvasCourses } from '@/lib/canvas/group-courses'
import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
import type { CanvasCourse } from '@/types/canvas'

/**
 * 课程 ↔ Canvas 关联控件（P0-2-4）。
 *
 * 三态：
 * - `collapsed`：默认视图。已关联显示关联到哪门课 + 更改 / 解除；未关联显示关联入口。
 *   底部另有「撤销 Canvas 授权」（P0-2-9，账号级操作，仅在已保存凭据时出现）。
 * - `picking`：从 Canvas 课程列表里选一门（`GET /api/v1/canvas/courses`）。
 * - `connecting`：还没连 Canvas 或 token 失效 → 内嵌连接表单。
 *
 * ### 关于「撤销授权」与「解除关联」是两件事
 * 解除关联 = 这一门课不再跟着某门 Canvas 课（`DELETE /courses/:id/canvas-link`）。
 * 撤销授权 = 整个 Canvas 连接断开（`DELETE /canvas/credentials`），删掉保存的 token，
 * **所有**课程停止同步。后者是账号级的，放在这里只是因为用户找 Canvas 操作时
 * 只会来这个区块（设置页属 P0-3-2，尚未建）。撤销后课程关联与已导入作业都保留。
 *
 * ### 为什么"关联"按钮不默认就把课程列表拉回来
 * 拉列表要打一次 Canvas（走限流额度）。用户可能只是打开详情页看看，
 * 为一次可能的点击预支上游请求不值得 —— 点开才拉。
 * 代价：已关联的课在没点开过之前只显示 Canvas 课程 ID，不显示课名。
 * 这是刻意的取舍：ID 足够用户确认"关联过"，想看课名点一下「更改」即可。
 *
 * ### 噪音课的处理（Steven 2026-09-04 拍板）
 * Canvas 的 active enrollment 里混着入学/培训类模块。规则分组见
 * `lib/canvas/group-courses.ts`：教学课正常列，**其他项单独一组 + 一句提示**，
 * 用户主动点才关联 —— 不静默过滤（防漏），也不混排（防淹没）。
 */
export function CanvasLink({
  courseId,
  lang,
  canvasCourseId,
  hasCredential,
}: {
  courseId: string
  /** 界面语言。 */
  lang: Lang
  /** 已关联的 Canvas 课程 ID；null = 未关联。 */
  canvasCourseId: string | null
  /**
   * 用户是否已保存 Canvas 凭据（P0-2-9）。
   *
   * 撤销授权是**账号级**操作（断的是整个 Canvas 连接，不是这一门课），
   * 但入口按 Steven 2026-09-05 的拍板放在本组件里 —— 用户找 Canvas 相关操作时
   * 只会来这个区块。因此它必须知道"当前到底连没连"，没有凭据时整个入口不渲染。
   * 由课程详情页服务端查一次传入，组件不自己发请求。
   */
  hasCredential: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'collapsed' | 'picking' | 'connecting'>('collapsed')
  const [courses, setCourses] = useState<CanvasCourse[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 正在提交关联/解除/撤销的按钮（用 externalId 或 'unlink' / 'revoke' 标记），用于禁用防重复点。 */
  const [pending, setPending] = useState<string | null>(null)
  const [isConfirmingUnlink, setIsConfirmingUnlink] = useState(false)
  const [isConfirmingRevoke, setIsConfirmingRevoke] = useState(false)

  /** 已关联那门课的展示信息。列表还没拉过时只知道 ID。 */
  const linked = courses?.find((course) => course.externalId === canvasCourseId) ?? null

  async function openPicker() {
    setError(null)
    setIsLoading(true)
    try {
      const response = await fetch('/api/v1/canvas/courses')

      if (response.status === 404 || response.status === 401) {
        // 404 = 还没连 Canvas；401 = token 被 Canvas 拒了（失效/被撤销）。
        // 两种情况的用户动作一样：重新粘一个 token。文案区分清楚。
        setError(
          response.status === 404
            ? t(lang, 'canvas.noToken')
            : t(lang, 'canvas.tokenRejected'),
        )
        setMode('connecting')
        return
      }

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : t(lang, 'canvas.fetchFailed', { status: response.status }))
        setMode('collapsed')
        return
      }

      const body = (await response.json()) as { data?: CanvasCourse[] }
      setCourses(body.data ?? [])
      setMode('picking')
    } catch {
      setError(t(lang, 'common.networkError'))
      setMode('collapsed')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleLink(externalId: string) {
    setError(null)
    setPending(externalId)
    try {
      const response = await fetch(`/api/v1/courses/${courseId}/canvas-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalCourseId: externalId }),
      })

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : t(lang, 'canvas.linkFailed', { status: response.status }))
        return
      }

      setMode('collapsed')
      router.refresh()
    } catch {
      setError(t(lang, 'common.networkError'))
    } finally {
      setPending(null)
    }
  }

  async function handleUnlink() {
    setError(null)
    setPending('unlink')
    try {
      const response = await fetch(`/api/v1/courses/${courseId}/canvas-link`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : t(lang, 'canvas.unlinkFailed', { status: response.status }))
        return
      }

      setIsConfirmingUnlink(false)
      setMode('collapsed')
      router.refresh()
    } catch {
      setError(t(lang, 'common.networkError'))
    } finally {
      setPending(null)
    }
  }

  /**
   * 撤销 Canvas 授权（P0-2-9）。
   *
   * 与「解除关联」的区别：解除只动**这一门课**（`canvas_course_id = null`），
   * 撤销动的是**整个连接** —— 删除已保存的 token，所有课程停止同步。
   * 已导入的作业（`tasks`）与各门课的关联关系**都保留**，重新连接后即可继续同步。
   *
   * 404 = 没有凭据，或已经撤销过了（端点幂等）。这不算失败 ——
   * 想达到的状态（没有有效凭据）本来就成立，刷新一下让服务端重算 `hasCredential` 即可。
   */
  async function handleRevoke() {
    setError(null)
    setPending('revoke')
    try {
      const response = await fetch('/api/v1/canvas/credentials', {
        method: 'DELETE',
      })

      if (!response.ok) {
        if (response.status === 404) {
          setIsConfirmingRevoke(false)
          router.refresh()
          return
        }

        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error?: { message?: unknown } }).error?.message
            : undefined
        setError(typeof message === 'string' ? message : t(lang, 'canvas.revokeFailed', { status: response.status }))
        return
      }

      setIsConfirmingRevoke(false)
      setMode('collapsed')
      router.refresh()
    } catch {
      setError(t(lang, 'common.networkError'))
    } finally {
      setPending(null)
    }
  }

  // ---------- 连接 Canvas ----------
  if (mode === 'connecting') {
    return (
      <Shell>
        <p className="text-sm text-foreground">{t(lang, 'canvas.connect')}</p>
        {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
        <CanvasConnectForm
          lang={lang}
          onConnected={() => void openPicker()}
          onCancel={() => {
            setError(null)
            setMode('collapsed')
          }}
        />
      </Shell>
    )
  }

  // ---------- 选择 Canvas 课程 ----------
  if (mode === 'picking') {
    const groups = groupCanvasCourses(courses ?? [])
    return (
      <Shell>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-foreground">{t(lang, 'canvas.pickingTitle')}</p>
          <button
            type="button"
            onClick={() => setMode('collapsed')}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t(lang, 'canvas.collapse')}
          </button>
        </div>

        {groups.courseLike.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t(lang, 'canvas.courses')}</p>
            <CourseList
              courses={groups.courseLike}
              lang={lang}
              linkedId={canvasCourseId}
              pending={pending}
              onLink={handleLink}
            />
          </div>
        ) : null}

        {groups.other.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t(lang, 'canvas.others')}</p>
            <p className="text-xs text-muted-foreground">
              {t(lang, 'canvas.othersNote')}
            </p>
            <CourseList
              courses={groups.other}
              lang={lang}
              linkedId={canvasCourseId}
              pending={pending}
              onLink={handleLink}
            />
          </div>
        ) : null}

        {courses !== null && courses.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t(lang, 'canvas.emptyList')}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </Shell>
    )
  }

  // ---------- 默认视图 ----------
  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {canvasCourseId ? (
            <>
              <p className="text-sm text-foreground">
                {t(lang, 'canvas.linked')}
                {linked ? (
                  <>
                    ：<span className="font-medium">{linked.name}</span>
                    {linked.term ? (
                      <span className="text-muted-foreground"> · {linked.term}</span>
                    ) : null}
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(lang, 'canvas.linkedId', { id: canvasCourseId })}
                {linked ? null : t(lang, 'canvas.linkedClickChange')}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-foreground">{t(lang, 'canvas.notLinked')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(lang, 'canvas.notLinkedHint')}
              </p>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void openPicker()}
            disabled={isLoading}
            className="h-8 rounded-md border border-border bg-card px-3 text-sm text-foreground disabled:opacity-50"
          >
            {isLoading ? t(lang, 'canvas.pulling') : canvasCourseId ? t(lang, 'canvas.change') : t(lang, 'canvas.linkCanvas')}
          </button>
          {canvasCourseId ? (
            <button
              type="button"
              onClick={() => {
                setError(null)
                setIsConfirmingUnlink(true)
              }}
              className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:text-destructive"
            >
              {t(lang, 'canvas.unlink')}
            </button>
          ) : null}
        </div>
      </div>

      {isConfirmingUnlink ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm text-foreground">
            {t(lang, 'canvas.unlinkConfirm', { id: canvasCourseId ?? '' })}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleUnlink()}
              disabled={pending !== null}
              className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
            >
              {pending === 'unlink' ? t(lang, 'canvas.unlinking') : t(lang, 'canvas.confirmUnlink')}
            </button>
            <button
              type="button"
              onClick={() => setIsConfirmingUnlink(false)}
              disabled={pending !== null}
              className="h-8 rounded-md px-3 text-xs text-muted-foreground"
            >
              {t(lang, 'common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------- 撤销授权：账号级操作（P0-2-9） ---------- */}
      {hasCredential ? (
        <div className="border-t border-border pt-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{t(lang, 'canvas.revokeTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(lang, 'canvas.revokeHint')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setError(null)
                // 两个确认框互斥：同时展开会让用户分不清现在点下去是解除还是撤销。
                setIsConfirmingUnlink(false)
                setIsConfirmingRevoke(true)
              }}
              className="h-8 shrink-0 rounded-md px-3 text-sm text-muted-foreground hover:text-destructive"
            >
              {t(lang, 'canvas.revoke')}
            </button>
          </div>

          {isConfirmingRevoke ? (
            <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-sm text-foreground">
                {t(lang, 'canvas.revokeConfirm')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(lang, 'canvas.revokeConfirmHint')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleRevoke()}
                  disabled={pending !== null}
                  className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                >
                  {pending === 'revoke' ? t(lang, 'canvas.revoking') : t(lang, 'canvas.confirmRevoke')}
                </button>
                <button
                  type="button"
                  onClick={() => setIsConfirmingRevoke(false)}
                  disabled={pending !== null}
                  className="h-8 rounded-md px-3 text-xs text-muted-foreground"
                >
                  {t(lang, 'common.cancel')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Shell>
  )
}

/** 三个态共用的外框，避免每处各写一遍卡片样式。 */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>
}

function CourseList({
  courses,
  lang,
  linkedId,
  pending,
  onLink,
}: {
  courses: CanvasCourse[]
  lang: Lang
  linkedId: string | null
  pending: string | null
  onLink: (externalId: string) => void
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {courses.map((course) => {
        const isCurrent = course.externalId === linkedId
        return (
          <li key={course.externalId} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{course.name}</p>
              <p className="text-xs text-muted-foreground">
                {course.term ?? t(lang, 'canvas.termMissing')} · ID {course.externalId}
              </p>
            </div>
            {isCurrent ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {t(lang, 'canvas.currentLink')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onLink(course.externalId)}
                disabled={pending !== null}
                className="h-7 shrink-0 rounded-md border border-border px-2 text-xs text-foreground disabled:opacity-50"
              >
                {pending === course.externalId ? t(lang, 'canvas.linking') : t(lang, 'canvas.linkCanvas')}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
