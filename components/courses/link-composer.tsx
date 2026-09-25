'use client'

/**
 * 全局浮窗里的「添加监控链接」面板（P0-5-3 补充入口）。
 *
 * 课程详情页课程大纲 tab 已经有完整的 `CourseLinks`（列表 + 删除 + 可见状态；
 * 2026-09-25 从资料 tab 挪过来 —— 它盯的是大纲外的信息源，与资料 tab 不是一类）；
 * 这里只补**「随手加一条」**这一件事 —— 浮窗的价值是「不用跳到课程页也能加」
 * （ADR-016：入口随手可达）。列表与删除**不在这里重复**，避免同一个功能两份实现。
 *
 * ### 为什么不直接复用 `CourseLinks`
 * 那个组件要服务端预取 `links`（详情页是服务端组件，首屏就有数据）；
 * 浮窗是纯客户端、点开才渲染，没有服务端取数这一步。把列表逻辑搬进来
 * 等于给「已监控链接」造第二个真相源 —— 所以本组件只写不列。
 *
 * ### 文案
 * ⚠️ 与浮窗其余部分一致用**中文硬编码**：`course-update-fab.tsx` /
 * `update-flow-parts.tsx` 目前都还是 zh，i18n 统一已拍板并入 **P0-5-5**。
 * 这里单独引 i18n 会造成「浮窗里一半翻译一半没翻译」。
 */

import { useState } from 'react'

import { isHttpUrl } from '@/lib/course-links/url'
import type { CourseLinkView } from '@/lib/course-links/store'

type CourseOption = { id: string; courseName: string }

type LinkComposerProps = {
  /** 浮窗共享的课程列表（`useCourseUpdateFlow` 已经拉过，不重复拉）。 */
  courses: CourseOption[]
  courseId: string
  onCourseChange: (id: string) => void
  loadingCourses: boolean
}

export function LinkComposer({
  courses,
  courseId,
  onCourseChange,
  loadingCourses,
}: LinkComposerProps) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<CourseLinkView | null>(null)

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setAdded(null)
    const raw = url.trim()
    if (!courseId) {
      setError('先选一门课 —— Tempo 要知道这条链接属于哪门课。')
      return
    }
    // 判据与课程详情页共用 `isHttpUrl()`；权威校验在服务端。
    if (!isHttpUrl(raw)) {
      setError('请填 http(s) 开头的网址。')
      return
    }
    setAdding(true)
    try {
      const res = await fetch(`/api/v1/courses/${courseId}/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: raw, label: label.trim() || null }),
      })
      const data = (await res.json().catch(() => null)) as { link?: CourseLinkView } | null
      if (!res.ok) {
        setError(res.status === 409 ? '这门课已经监控过这个链接了。' : `添加失败（${res.status}）`)
        return
      }
      setAdded(data?.link ?? null)
      setUrl('')
      setLabel('')
    } catch {
      setError('网络异常，添加失败。')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        贴上课程网页链接，Tempo 每天自动检查一次；内容有变化时进消息栏提醒你。
      </p>

      <div>
        <label className="mb-1 block text-sm text-muted-foreground">课程</label>
        <select
          value={courseId}
          onChange={(e) => onCourseChange(e.target.value)}
          disabled={loadingCourses}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">
            {loadingCourses ? '加载中…' : courses.length === 0 ? '还没有课程' : '选择课程'}
          </option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.courseName}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={handleAdd} className="space-y-2">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://inst.eecs.berkeley.edu/~cs61c/"
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="备注（可选，如「课程主页」）"
            className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <button
            type="submit"
            disabled={adding || url.trim() === ''}
            className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {adding ? '添加中…' : '添加监控'}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {/* R3：成功也要看得见 —— 否则用户不知道到底加没加上。 */}
      {added && (
        <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
          已添加「{added.label ?? added.url}」—— 每天自动检查，有变化会进消息栏。
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        已监控的链接（查看状态 / 删除）在课程详情页的「资料」tab。
      </p>
    </div>
  )
}
