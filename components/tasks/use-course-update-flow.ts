"use client"

/**
 * 「更新课程」流程的**唯一状态机**（P0-3-18 抽出）。
 *
 * ### 为什么必须抽出来
 * 这段逻辑原先只活在 `components/course-update-fab.tsx`（725 行）里。P0-3-18 要给
 * `/messages` 做一个全屏版 —— 若把浮窗那份复制过去，「解析 → 检索 → 消歧 → **确认才写**」
 * 就有了两份实现。那不是风格问题：两处各自都"没错"，错的是它们**说的不是同一件事**，
 * 而且 `tsc` / `eslint` / `next build` 全绿（P0-3-15 的 40/83 条渲染分叉就是这个形状，
 * 见 CodingRules §10.1 第 21 条）。
 *
 * ### 现在的分工
 * - **本文件**：状态 + 网络调用（解析 / 检索 / 确认写入）。
 * - `components/tasks/update-flow-parts.tsx`：这三步的**唯一一份**渲染。
 * - `course-update-fab.tsx` 与 `app/(routes)/messages/page.tsx` 都只是外壳。
 *
 * ### 🔴 两条红线（原样继承，不放松）
 * - **确认才写**：解析与检索都不落库，只有点「确认」才写。
 * - **只改手动任务**：Canvas 同步来的任务内容会被下次同步覆盖（`PATCH` 返回
 *   `source_not_editable`），考试归 `exam_dates`（ADR-004）。候选里只有 `source='manual'`
 *   可勾选更新；其余只展示并给出「去哪儿改」的提示。
 */

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"

export type CourseOption = { id: string; courseName: string }

export type ParsedTask = {
  title: string
  taskType: string
  dueDate: string | null
  notes: string | null
  /** P0-3-9 截图档：识别到「已提交 / 提交成功页」则为 true，驱动「标记完成」提示。 */
  submitted?: boolean | null
}

export type ParseResult = { tasks: ParsedTask[]; warnings: string[] }

export type Candidate = {
  id: string
  title: string
  dueDate: string | null
  taskType: string
  source: string
  isDerived: boolean
  score: number
}

export type Resolution = { mode: "create" } | { mode: "update"; candidate: Candidate }

export type Summary = { created: number; updated: number; skipped: number }

export function taskTypeLabel(type: string): string {
  if (type === "assignment") return "作业"
  if (type === "reading") return "阅读"
  if (type === "exam") return "考试"
  return "其他"
}

export function formatDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "日期待定"
}

/** 只有手动、非派生的任务允许在这里直接改内容（与 `PATCH` 的准入一致）。 */
export function isEditable(candidate: Candidate): boolean {
  return candidate.source === "manual" && !candidate.isDerived
}

/** 候选来源标签 + 不可编辑时的原因。 */
export function candidateHint(candidate: Candidate): { label: string; reason?: string } {
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

export function useCourseUpdateFlow() {
  const router = useRouter()
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

  // 打开时拉一次课程列表（已拉过就不再拉）。改用「打开」事件触发，避免 effect 内同步 setState（react-hooks/set-state-in-effect）。
  function loadCourses() {
    if (courses.length > 0) return
    setLoadingCourses(true)
    fetch("/api/v1/courses")
      .then((r) => r.json())
      .then((d) => setCourses(d.data ?? []))
      .catch(() => setError("课程列表加载失败"))
      .finally(() => setLoadingCourses(false))
  }

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

  /**
   * 打开一次会话时的起步动作（浮窗点开 / 整页首次挂载都调它）：
   * 拉课程 + 清输入 + 清回执，避免上一次的残留串进这一次。
   */
  function startSession() {
    loadCourses()
    resetInput()
    setSummary(null)
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

  /** 移除已选的截图（预览 URL 必须 revoke，否则整页会话里会一直占着内存）。 */
  function removeImage() {
    setImage(null)
    if (imagePreview) URL.revokeObjectURL(imagePreview)
    setImagePreview(null)
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

  /**
   * 确认（**唯一的写入点**）。
   *
   * `onSuccess` 由外壳决定成功后做什么：浮窗是"延迟 1.2s 收起"，
   * 整页是"让服务端重新拉一次消息与任务"。**状态机本身不关心 UI**。
   */
  async function handleConfirm(onSuccess?: () => void) {
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
      onSuccess?.()
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

  return {
    // 状态
    courses,
    courseId,
    text,
    image,
    imagePreview,
    fileInputRef,
    loadingCourses,
    parsing,
    searching,
    parsed,
    candidatesFor,
    resolutions,
    saving,
    error,
    summary,
    openReadonly,
    createCount,
    updateCount,
    // 动作
    setCourseId,
    setText,
    setOpenReadonly,
    startSession,
    loadCourses,
    resetInput,
    handleFile,
    removeImage,
    handlePaste,
    handleParse,
    chooseCreate,
    chooseCandidate,
    handleConfirm,
  }
}

/** 浮窗 / 整页共用的流程类型（外壳只依赖它，不重复声明）。 */
export type CourseUpdateFlow = ReturnType<typeof useCourseUpdateFlow>
