"use client"

/**
 * 全局课程更新浮窗（P0-3-8 文本档）。
 *
 * 一个常驻右下角的小圆圈 FAB，点开就是「更新课程」对话框：选课程 → 粘贴任意课程更新
 * 文字 → 解析 → 确认 → 写入手动任务。挂在 `AppShell` 里，所以**所有已登录页面都看得到**，
 * 符合 ADR-016「对话框是兜底不是入口」—— 随时能 update，但零操作成本。
 *
 * ### 流程红线
 * 解析（`/api/v1/tasks/parse`）**只产预览、不落库**；只有用户点「确认添加」才真正
 * `POST /api/v1/tasks`。AI 幻觉不会未经确认就进日程。
 *
 * ### 考试不在这里处理
 * 解析层把考试日期变更放进 warnings 提示「请到课程页更新」；本组件也把 `exam` 类型
 * 显式挡掉（理论上 parse 不会返回 exam，这是双保险）。
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"

type CourseOption = { id: string; courseName: string }
type ParsedTask = { title: string; taskType: string; dueDate: string | null; notes: string | null }
type ParseResult = { tasks: ParsedTask[]; warnings: string[] }

function taskTypeLabel(type: string): string {
  if (type === "assignment") return "作业"
  if (type === "reading") return "阅读"
  if (type === "exam") return "考试"
  return "其他"
}

export function CourseUpdateFab() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [courseId, setCourseId] = useState("")
  const [text, setText] = useState("")
  const [loadingCourses, setLoadingCourses] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneCount, setDoneCount] = useState<number | null>(null)

  // 打开时拉一次课程列表（已拉过就不再拉）。
  useEffect(() => {
    if (!open || courses.length > 0) return
    setLoadingCourses(true)
    fetch("/api/v1/courses")
      .then((r) => r.json())
      .then((d) => setCourses(d.data ?? []))
      .catch(() => setError("课程列表加载失败"))
      .finally(() => setLoadingCourses(false))
  }, [open, courses.length])

  function resetTransient() {
    setText("")
    setParsed(null)
    setError(null)
    setDoneCount(null)
  }

  async function handleParse() {
    setError(null)
    setParsed(null)
    if (!courseId) {
      setError("请先选择课程")
      return
    }
    if (text.trim() === "") {
      setError("请粘贴课程更新内容")
      return
    }
    setParsing(true)
    try {
      const res = await fetch("/api/v1/tasks/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), courseId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error?.message ?? "解析失败，请重试")
        return
      }
      const result = (data.data ?? { tasks: [], warnings: [] }) as ParseResult
      const safeTasks = result.tasks.filter((t) => t.taskType !== "exam")
      setParsed({ tasks: safeTasks, warnings: result.warnings ?? [] })
      if (safeTasks.length === 0 && (result.warnings ?? []).length === 0) {
        setError("没识别出可添加的任务，换个说法试试？")
      }
    } catch {
      setError("网络错误，请重试")
    } finally {
      setParsing(false)
    }
  }

  async function handleConfirm() {
    if (!parsed || parsed.tasks.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: parsed.tasks.map((t) => ({
            courseId,
            title: t.title,
            taskType: t.taskType,
            dueDate: t.dueDate,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error?.message ?? "保存失败，请重试")
        return
      }
      const count = data.data?.length ?? parsed.tasks.length
      setDoneCount(count)
      resetTransient()
      router.refresh()
      setTimeout(() => {
        setOpen(false)
      }, 1100)
    } catch {
      setError("网络错误，请重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="更新课程"
        title="更新课程"
        onClick={() => {
          setOpen(true)
          resetTransient()
        }}
        className="fixed bottom-6 right-6 z-50 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-105 active:scale-95"
      >
        <span className="text-2xl leading-none">＋</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink">更新课程</h2>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setOpen(false)}
                className="text-muted-foreground transition hover:text-ink"
              >
                ✕
              </button>
            </div>

            <label className="mb-1 block text-sm text-muted-foreground">课程</label>
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              disabled={loadingCourses}
              className="mb-3 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">{loadingCourses ? "加载中…" : "选择课程"}</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.courseName}
                </option>
              ))}
            </select>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="粘贴课程更新（作业、阅读、项目截止等）…"
              className="mb-3 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />

            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            {doneCount !== null && (
              <p className="mb-2 text-sm text-emerald-500">已添加 {doneCount} 条任务 ✓</p>
            )}

            {parsed && parsed.tasks.length > 0 && (
              <div className="mb-3 space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-xs font-medium text-muted-foreground">识别到的任务（确认后添加）</p>
                {parsed.tasks.map((t, i) => (
                  <div key={i} className="text-sm">
                    <p className="text-ink">{t.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {taskTypeLabel(t.taskType)}
                      {t.dueDate ? ` · 截止 ${t.dueDate.slice(0, 10)}` : " · 日期待定"}
                      {t.notes ? ` · ${t.notes}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {parsed && parsed.warnings.length > 0 && (
              <div className="mb-3 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
                {parsed.warnings.map((w, i) => (
                  <p key={i}>⚠ {w}</p>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {!parsed || parsed.tasks.length === 0 ? (
                <Button onClick={handleParse} disabled={parsing}>
                  {parsing ? "解析中…" : "解析"}
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setParsed(null)} disabled={saving}>
                    重新输入
                  </Button>
                  <Button onClick={handleConfirm} disabled={saving}>
                    {saving ? "保存中…" : `确认添加 ${parsed.tasks.length} 条`}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
