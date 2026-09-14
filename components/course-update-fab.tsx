"use client"

/**
 * 全局课程更新浮窗（P0-3-8 文本档 + P0-3-8b 检索/更新）。
 *
 * 一个常驻右下角的小圆圈 FAB，点开就是「更新课程」对话框。挂在 `AppShell` 里，
 * 所以**所有已登录页面都看得到**（ADR-016：对话框是兜底不是入口 —— 随时能 update，
 * 但零操作成本）。
 *
 * ### 两步流程
 * 1. **解析**（`POST /api/v1/tasks/parse`）：LLM 把自由文本抽成结构化任务参考。
 *    **只产预览、不落库。**
 * 2. **检索 + 消歧**（P0-3-8b，`GET /api/v1/tasks/search`）：对每个参考，在该课里
 *    确定性检索最像的现有任务 → 0 命中直接新增 / 有命中列举让用户选改哪条。
 *    最后 `POST /api/v1/tasks`（新建）或 `PATCH /api/v1/tasks/:id`（更新手动任务）。
 *
 * ### 🔴 两条红线
 * - **确认才写**：解析与原样检索都不落库，只有点「确认」才写。
 * - **只改手动任务**：Canvas 同步来的任务内容会被下次同步覆盖（`PATCH` 会返回
 *   `source_not_editable`），考试归 `exam_dates`（ADR-004）。所以候选里只有
 *   `source='manual'` 可勾选更新；其余只展示并给出「去哪儿改」的提示。
 */

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"

type CourseOption = { id: string; courseName: string }
type ParsedTask = {
  title: string
  taskType: string
  dueDate: string | null
  notes: string | null
  /** P0-3-9 截图档：识别到「已提交 / 提交成功页」则为 true，驱动「标记完成」提示。 */
  submitted?: boolean | null
}
type ParseResult = { tasks: ParsedTask[]; warnings: string[] }
type Candidate = {
  id: string
  title: string
  dueDate: string | null
  taskType: string
  source: string
  isDerived: boolean
  score: number
}
type Resolution = { mode: "create" } | { mode: "update"; candidate: Candidate }
type Summary = { created: number; updated: number; skipped: number }

function taskTypeLabel(type: string): string {
  if (type === "assignment") return "作业"
  if (type === "reading") return "阅读"
  if (type === "exam") return "考试"
  return "其他"
}

function formatDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "日期待定"
}

/** 只有手动、非派生的任务允许在这里直接改内容（与 `PATCH` 的准入一致）。 */
function isEditable(candidate: Candidate): boolean {
  return candidate.source === "manual" && !candidate.isDerived
}

/** 候选来源标签 + 不可编辑时的原因。 */
function candidateHint(candidate: Candidate): { label: string; reason?: string } {
  if (candidate.isDerived || candidate.taskType === "exam") {
    return { label: "考试", reason: "考试日期由课程页管理，请到课程页修改" }
  }
  if (candidate.source === "canvas") {
    return { label: "Canvas", reason: "Canvas 同步 · 改了会被下次同步覆盖，请去 Canvas 改或等同步" }
  }
  if (candidate.source === "manual") {
    return { label: "手动", reason: undefined }
  }
  return { label: candidate.source, reason: "该来源任务不支持在对话框直接编辑" }
}

export function CourseUpdateFab() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [courseId, setCourseId] = useState("")
  const [text, setText] = useState("")
  // P0-3-9 截图档：图片状态（base64 / 预览 URL / 媒体类型）。与 text 二选一。
  const [image, setImage] = useState<{ dataBase64: string; mediaType: string } | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [loadingCourses, setLoadingCourses] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [searching, setSearching] = useState(false)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [candidatesFor, setCandidatesFor] = useState<Record<number, Candidate[]>>({})
  const [resolutions, setResolutions] = useState<Record<number, Resolution>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  // Canvas / 考试等只读候选默认折叠，避免淹没可编辑的手动任务（P0-3-8b follow-up）。
  const [openReadonly, setOpenReadonly] = useState<Record<number, boolean>>({})

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

  /** 清空一次输入的中间态（成功的 summary 单独保留，用于短暂回显）。 */
  function resetInput() {
    setText("")
    setImage(null)
    if (imagePreview) {
      URL.revokeObjectURL(imagePreview)
      setImagePreview(null)
    }
    setParsed(null)
    setCandidatesFor({})
    setResolutions({})
    setError(null)
  }

  // ---------------------------------------------------------------
  // P0-3-9 截图档：图片压缩 + 粘贴 / 选择
  // ---------------------------------------------------------------

  /**
   * 客户端压缩：长边 ≤1600px、转 JPEG q≈0.8、目标 ≤1MB。
   * 截图不落库（即传即弃），压缩只为控制请求体积与避免 HEIC 等不可直传格式。
   */
  async function compressImage(file: File): Promise<{ dataBase64: string; mediaType: string }> {
    const bitmap = await createImageBitmap(file)
    const maxEdge = 1600
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)

    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("无法读取图片")
    ctx.drawImage(bitmap, 0, 0, w, h)

    // 先试 JPEG（通用、体积小）；体积仍超 1MB 再降质。
    let dataUrl = canvas.toDataURL("image/jpeg", 0.8)
    if (dataUrl.length > 1_400_000) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.6)
    }
    // dataUrl: "data:image/jpeg;base64,...."
    const comma = dataUrl.indexOf(",")
    const dataBase64 = dataUrl.slice(comma + 1)
    bitmap.close?.()
    return { dataBase64, mediaType: "image/jpeg" }
  }

  async function handleFile(file: File | undefined | null) {
    if (!file) return
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件（PNG / JPEG / WebP）")
      return
    }
    // HEIC 等浏览器 createImageBitmap 不支持的格式：明确引导转格式，不引转码依赖。
    try {
      const compressed = await compressImage(file)
      setImage(compressed)
      setImagePreview(URL.createObjectURL(file))
      setText("")
      setError(null)
    } catch {
      setError("这张图片无法读取（HEIC 等格式请先转成 PNG/JPEG 再上传）")
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"))
    if (!item) return
    const file = item.getAsFile()
    if (file) {
      e.preventDefault()
      void handleFile(file)
    }
  }

  /** 对该课现有任务做确定性检索，并给出默认选择（有可改的手动匹配则默认选中它）。 */
  async function loadCandidates(tasks: ParsedTask[], cid: string) {
    const results = await Promise.all(
      tasks.map(async (task, index) => {
        try {
          const res = await fetch(
            `/api/v1/tasks/search?courseId=${encodeURIComponent(cid)}&q=${encodeURIComponent(task.title)}`,
          )
          const data = await res.json()
          return [index, res.ok ? ((data.data ?? []) as Candidate[]) : []] as const
        } catch {
          return [index, [] as Candidate[]] as const
        }
      }),
    )

    const nextCandidates: Record<number, Candidate[]> = {}
    const nextResolutions: Record<number, Resolution> = {}
    for (const [index, list] of results) {
      nextCandidates[index] = list
      const auto = list.find(isEditable)
      nextResolutions[index] = auto ? { mode: "update", candidate: auto } : { mode: "create" }
    }
    setCandidatesFor(nextCandidates)
    setResolutions(nextResolutions)
  }

  async function handleParse() {
    setError(null)
    setParsed(null)
    setCandidatesFor({})
    setResolutions({})
    setSummary(null)
    if (!courseId) {
      setError("请先选择课程")
      return
    }
    // 截图档与文本档二选一。
    if (image) {
      await handleParseImage()
      return
    }
    if (text.trim() === "") {
      setError("请粘贴课程更新内容，或粘贴 / 选择一张截图")
      return
    }

    let safeTasks: ParsedTask[] = []
    let warnings: string[] = []
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
      safeTasks = result.tasks.filter((t) => t.taskType !== "exam")
      warnings = result.warnings ?? []
      if (safeTasks.length === 0 && warnings.length === 0) {
        setError("没识别出可添加的任务，换个说法试试？")
        return
      }
      setParsed({ tasks: safeTasks, warnings })
    } catch {
      setError("网络错误，请重试")
      return
    } finally {
      setParsing(false)
    }

    if (safeTasks.length > 0) {
      setSearching(true)
      try {
        await loadCandidates(safeTasks, courseId)
      } finally {
        setSearching(false)
      }
    }
  }

  /** 截图档解析分支（P0-3-9）。 */
  async function handleParseImage() {
    if (!image) return
    let safeTasks: ParsedTask[] = []
    let warnings: string[] = []
    setParsing(true)
    try {
      const res = await fetch("/api/v1/tasks/parse-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, image }),
      })
      const data = await res.json()
      if (!res.ok) {
        // 服务端已 fail closed：明确提示「识别服务不可用」，不伪装成"没识别出任务"。
        setError(data?.error?.message ?? "截图识别失败，请改用文字输入")
        return
      }
      const result = (data.data ?? { tasks: [], warnings: [] }) as ParseResult
      safeTasks = result.tasks.filter((t) => t.taskType !== "exam")
      warnings = result.warnings ?? []
      if (safeTasks.length === 0 && warnings.length === 0) {
        setError("这张截图里没识别出可添加的任务，换个角度或改用文字试试？")
        return
      }
      setParsed({ tasks: safeTasks, warnings })
    } catch {
      setError("网络错误，请重试")
      return
    } finally {
      setParsing(false)
    }

    if (safeTasks.length > 0) {
      setSearching(true)
      try {
        await loadCandidates(safeTasks, courseId)
      } finally {
        setSearching(false)
      }
    }
  }

  function chooseCreate(index: number) {
    setResolutions((prev) => ({ ...prev, [index]: { mode: "create" } }))
  }

  function chooseCandidate(index: number, candidate: Candidate) {
    setResolutions((prev) => ({ ...prev, [index]: { mode: "update", candidate } }))
  }

  async function handleConfirm() {
    if (!parsed || parsed.tasks.length === 0) return
    setSaving(true)
    setError(null)
    try {
      // 收集「新建」任务，并记录其中哪些是「已提交」（按创建顺序）。POST 后按返回顺序配对，
      // 给新建且 submitted 的任务后置 PATCH status=done（POST 闭环固定 pending，不收 status）。
      const createItems: ParsedTask[] = []
      const newSubmittedSeq: number[] = []
      // 其余动作（改日期 / 标记已有任务完成 / 跳过）按序执行。
      type Action =
        | { kind: "updateDue"; id: string; dueDate: string }
        | { kind: "markDone"; id: string }
        | { kind: "skip" }
      const actions: Action[] = []

      parsed.tasks.forEach((task, index) => {
        const resolution = resolutions[index] ?? { mode: "create" as const }
        const isSubmitted = task.submitted === true
        if (resolution.mode === "create") {
          createItems.push(task)
          if (isSubmitted) newSubmittedSeq.push(createItems.length - 1)
        } else {
          const candidateId = resolution.candidate.id
          if (task.dueDate) actions.push({ kind: "updateDue", id: candidateId, dueDate: task.dueDate })
          // 🔴 红线：截图只写 status（用户主权）。仅当识别为「已提交」才标记完成；
          // 绝不写 submission_state / submitted_at（那是 Canvas 真相、仅同步可写，ADR-015）。
          if (isSubmitted) actions.push({ kind: "markDone", id: candidateId })
          else if (!task.dueDate) actions.push({ kind: "skip" })
        }
      })

      let created = 0
      const createdIds: string[] = []
      if (createItems.length > 0) {
        const res = await fetch("/api/v1/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tasks: createItems.map((t) => ({
              courseId,
              title: t.title,
              taskType: t.taskType,
              dueDate: t.dueDate,
            })),
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data?.error?.message ?? "新增失败，请重试")
          return
        }
        const createdList = (data.data ?? []) as { id: string }[]
        createdIds.push(...createdList.map((t) => t.id))
        created = createdList.length
      }

      // 新建且 submitted 的任务：按创建顺序置 done（POST 固定 pending，后置 PATCH）。
      let newMarkedDone = 0
      for (const idx of newSubmittedSeq) {
        const id = createdIds[idx]
        if (!id) continue
        const res = await fetch(`/api/v1/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        })
        if (res.ok) newMarkedDone += 1
      }

      // 其余动作：改日期 / 标记已有任务完成 / 跳过。
      let updated = 0
      let skipped = 0
      for (const act of actions) {
        if (act.kind === "updateDue") {
          const res = await fetch(`/api/v1/tasks/${act.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dueDate: act.dueDate }),
          })
          const data = await res.json()
          if (!res.ok) {
            setError(data?.error?.message ?? "更新失败，请重试")
            return
          }
          updated += 1
        } else if (act.kind === "markDone") {
          const res = await fetch(`/api/v1/tasks/${act.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done" }),
          })
          if (res.ok) updated += 1
        } else if (act.kind === "skip") {
          skipped += 1
        }
      }

      setSummary({ created, updated: updated + newMarkedDone, skipped })
      resetInput()
      router.refresh()
      setTimeout(() => {
        setOpen(false)
      }, 1200)
    } catch {
      setError("网络错误，请重试")
    } finally {
      setSaving(false)
    }
  }

  const createCount = parsed
    ? parsed.tasks.filter((_, i) => (resolutions[i] ?? { mode: "create" }).mode === "create").length
    : 0
  const updateCount = parsed ? parsed.tasks.length - createCount : 0

  return (
    <>
      <button
        type="button"
        aria-label="更新课程"
        title="更新课程"
        onClick={() => {
          setOpen(true)
          resetInput()
          setSummary(null)
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
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl"
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
              onPaste={handlePaste}
              rows={4}
              placeholder="粘贴课程更新（作业、阅读、项目截止等），例如：Homework 7 截止改到 9/20；也可直接 Cmd+V 粘贴截图"
              disabled={!!image}
              className="mb-2 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />

            {/* P0-3-9 截图档：选图 / 粘贴入口（与文字互斥）。 */}
            <div className="mb-3 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!!image}
                onClick={() => fileInputRef.current?.click()}
              >
                选择图片
              </Button>
              <span className="text-xs text-muted-foreground">或在此框内 Cmd+V 粘贴截图</span>
            </div>

            {image && imagePreview && (
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="待识别截图"
                  className="h-20 w-20 rounded object-cover"
                />
                <div className="flex flex-1 flex-col gap-1">
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                    截图已就绪，点「解析」识别更新（将发送给视觉模型）
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setImage(null)
                      if (imagePreview) URL.revokeObjectURL(imagePreview)
                      setImagePreview(null)
                    }}
                    className="w-fit text-xs text-muted-foreground underline transition hover:text-ink"
                  >
                    移除截图
                  </button>
                </div>
              </div>
            )}

            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            {summary && (
              <p className="mb-2 text-sm text-emerald-500">
                已新增 {summary.created} 条 · 已更新 {summary.updated} 条
                {summary.skipped > 0 ? ` · 跳过 ${summary.skipped} 条` : ""} ✓
              </p>
            )}

            {parsed && parsed.tasks.length > 0 && (
              <div className="mb-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">
                  识别到的更新（确认后写入）
                </p>
                {parsed.tasks.map((task, index) => {
                  const candidates = candidatesFor[index] ?? []
                  const resolution = resolutions[index] ?? { mode: "create" as const }
                  return (
                    <div key={index} className="rounded-lg border border-border bg-muted/40 p-3">
                      <p className="text-sm text-ink">{task.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {taskTypeLabel(task.taskType)}
                        {task.dueDate ? ` · 截止 ${formatDay(task.dueDate)}` : " · 日期待定"}
                        {task.notes ? ` · ${task.notes}` : ""}
                        {task.submitted === true ? (
                          <span className="ml-1 rounded bg-emerald-500/15 px-1 text-emerald-600 dark:text-emerald-400">
                            已提交
                          </span>
                        ) : null}
                      </p>

                      {searching ? (
                        <p className="mt-2 text-xs text-muted-foreground">正在匹配现有任务…</p>
                      ) : (() => {
                        const editableCandidates = candidates.filter(isEditable)
                        const readonlyCandidates = candidates.filter((c) => !isEditable(c))
                        return (
                        <div className="mt-2 space-y-2">
                          {editableCandidates.length > 0 ? (
                            <div className="space-y-1">
                              <p className="text-xs text-muted-foreground">
                                检测到 {editableCandidates.length} 个可能匹配的现有任务，选择要更新的那条：
                              </p>
                              <label className="flex cursor-pointer items-start gap-2 text-sm">
                                <input
                                  type="radio"
                                  name={`resolution-${index}`}
                                  checked={resolution.mode === "create"}
                                  onChange={() => chooseCreate(index)}
                                  className="mt-1"
                                />
                                <span className="text-ink">都不是，新建一条</span>
                              </label>
                              {editableCandidates.map((candidate) => {
                                const hint = candidateHint(candidate)
                                const selected =
                                  resolution.mode === "update" &&
                                  resolution.candidate.id === candidate.id
                                return (
                                  <label
                                    key={candidate.id}
                                    className="flex cursor-pointer items-start gap-2 text-sm"
                                  >
                                    <input
                                      type="radio"
                                      name={`resolution-${index}`}
                                      checked={selected}
                                      onChange={() => chooseCandidate(index, candidate)}
                                      className="mt-1"
                                    />
                                    <span>
                                      <span className="text-ink">{candidate.title}</span>
                                      <span className="text-xs text-muted-foreground">
                                        {" "}
                                        · 截止 {formatDay(candidate.dueDate)} · {hint.label}
                                      </span>
                                      {selected && (
                                        <span className="block text-xs text-emerald-600 dark:text-emerald-400">
                                          将改为截止{" "}
                                          {task.dueDate ? formatDay(task.dueDate) : "（未提供新日期）"}
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              未找到可更新的手动任务，将新建一条。
                            </p>
                          )}

                          {readonlyCandidates.length > 0 && (
                            <div className="rounded-lg border border-border bg-muted/30 p-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setOpenReadonly((p) => ({ ...p, [index]: !p[index] }))
                                }
                                className="flex w-full items-center justify-between text-xs text-muted-foreground transition hover:text-ink"
                              >
                                <span>只读任务（Canvas / 考试）— {readonlyCandidates.length} 项</span>
                                <span>{openReadonly[index] ? "▾" : "▸"}</span>
                              </button>
                              {openReadonly[index] && (
                                <div className="mt-2 space-y-1">
                                  {readonlyCandidates.map((candidate) => {
                                    const hint = candidateHint(candidate)
                                    return (
                                      <div
                                        key={candidate.id}
                                        className="flex items-start gap-2 text-sm opacity-70"
                                      >
                                        <input type="radio" disabled className="mt-1" />
                                        <span>
                                          <span className="text-ink">{candidate.title}</span>
                                          <span className="text-xs text-muted-foreground">
                                            {" "}
                                            · 截止 {formatDay(candidate.dueDate)} · {hint.label}
                                          </span>
                                          {hint.reason && (
                                            <span className="block text-xs text-amber-600 dark:text-amber-400">
                                              {hint.reason}
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        )
                      })()}
                    </div>
                  )
                })}
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
                  <Button variant="outline" onClick={resetInput} disabled={saving}>
                    重新输入
                  </Button>
                  <Button onClick={handleConfirm} disabled={saving || searching}>
                    {saving ? "保存中…" : `确认（新增 ${createCount} · 更新 ${updateCount}）`}
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
