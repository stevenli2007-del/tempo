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

import { useState } from "react"
import { useRouter } from "next/navigation"

import {
  summarizeWeightTotals,
  weightWarnings,
  type WeightedItem,
} from "@/lib/course-update/weights"
import { looksLikeUrl } from "@/lib/ingest/detect"

export type CourseOption = { id: string; courseName: string }

export type ParsedTask = {
  title: string
  taskType: string
  dueDate: string | null
  notes: string | null
  /** P0-3-9 截图档：识别到「已提交 / 提交成功页」则为 true，驱动「标记完成」提示。 */
  submitted?: boolean | null
}

/** P0-3-24：解析出来的考试（走 `exam_dates`，不是 tasks）。 */
export type ParsedExam = {
  examName: string
  examDate: string | null
  examTime: string | null
  location: string | null
  /** 逐字原文摘录。服务端校验器**拒收**没有摘录的考试，所以这里非空。 */
  sourceExcerpt: string
}

/** P0-3-24：解析出来的成绩构成（走 `grade_components`）。 */
export type ParsedGradeComponent = {
  name: string
  weightPercent: number | null
  notes: string | null
  sourceExcerpt: string
}

/**
 * 解析结果。**四个数组一个都不能省** —— 与服务端 `COURSE_UPDATE_PARSE_SCHEMA`
 * 的 `required` 一一对应（schema 由 `lib/llm/schema.ts` 强校验，缺字段整个调用失败）。
 */
export type ParseResult = {
  tasks: ParsedTask[]
  exams: ParsedExam[]
  gradeComponents: ParsedGradeComponent[]
  warnings: string[]
}

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

export type Summary = {
  created: number
  updated: number
  skipped: number
  /** P0-3-24：考试 / 成绩构成的写入回执（本次没写就是 null）。 */
  apply?: ApplySummary | null
}

/** P0-3-24：确认写入后的回执（考试 / 成绩构成与权重校验）。 */
export type ApplySummary = {
  exams: number
  gradeComponents: number
  /** 写入后按 source 分组的合计校验（≠100% 时带人话说明）。 */
  weightWarnings: string[]
  /** 服务端拼的一句话回执（消息栏与对话框共用同一份文案）。 */
  text: string
}

/**
 * 去重键（考试：名称 + 日期；构成：名称 + 占比）。导出给渲染层判断"这条已存在"。
 *
 * 为什么需要：本通道是**只追加**（不是 PUT 全量替换），把同一条公告粘第二遍就会写出
 * 重复行。这里不"静默跳过"（那是 ADR-016 R3 的静默失败），而是**把默认勾选取消**——
 * 用户看得见那个空勾选框、也看得见旁边写的"已存在"，想再写一条可以自己勾回来。
 */
export function examKey(name: string, date: string | null): string {
  return `${name.trim().toLowerCase()}|${date ?? ''}`
}

export function gradeKey(name: string, weightPercent: number | null): string {
  return `${name.trim().toLowerCase()}|${weightPercent ?? ''}`
}

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

/**
 * @param options.initialCourses 服务端预取好的课程下拉项（可省略）。
 *
 * 🔴 整页 `/messages` 的输入区是**常驻**的 —— 那里没有"点开浮窗"这个动作去触发
 * `loadCourses()`，所以课程列表必须由外壳预取好传进来。不传的话 `courses` 恒为 `[]`，
 * 下拉里只剩占位项，用户点开是空的（2026-09-17 验收实测：「选择课程」选不了）。
 * 浮窗是点开才渲染、点开时调 `startSession()` 拉列表，所以不传，行为不变。
 */
export function useCourseUpdateFlow(options: { initialCourses?: CourseOption[] } = {}) {
  const router = useRouter()
  const [courses, setCourses] = useState<CourseOption[]>(options.initialCourses ?? [])
  const [courseId, setCourseId] = useState("")
  const [text, setText] = useState("")
  // P0-3-9 截图档：图片状态（base64 / 预览 URL / 媒体类型）。与 text 二选一。
  const [image, setImage] = useState<{ dataBase64: string; mediaType: string } | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  // 🔴 这里**刻意不放 DOM ref**（选文件的 `<input>` 归渲染层自己持有，见 update-flow-parts）。
  // 曾经把 `fileInputRef` 挂在返回对象上，结果 eslint 的 react-hooks/refs 把整个 `flow`
  // 判成"含 ref 的对象"，渲染期读 `flow.summary` 这类纯数据也被报错（15 处）。
  // DOM 引用属于视图，不属于状态机。
  const [loadingCourses, setLoadingCourses] = useState(false)
  const [parsing, setParsing] = useState(false)
  /** P0-3-27：正在抓取链接（供按钮显示「抓取链接中…」，与「解析中…」区分开）。 */
  const [ingesting, setIngesting] = useState(false)
  const [searching, setSearching] = useState(false)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [candidatesFor, setCandidatesFor] = useState<Record<number, Candidate[]>>({})
  const [resolutions, setResolutions] = useState<Record<number, Resolution>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  // Canvas / 考试等只读候选默认折叠，避免淹没可编辑的手动任务（P0-3-8b follow-up）。
  const [openReadonly, setOpenReadonly] = useState<Record<number, boolean>>({})

  // ---------------------------------------------------------------
  // P0-3-24：考试 / 成绩构成的勾选与「现有构成」预览上下文
  // ---------------------------------------------------------------

  // 默认全选 —— 用户说的是"这些都要"，勾选框的作用是**排除**个别项，不是逐条批准。
  const [examPicked, setExamPicked] = useState<Record<number, boolean>>({})
  const [gradePicked, setGradePicked] = useState<Record<number, boolean>>({})
  /**
   * 该课**已存在**的成绩构成（写入前用于合计校验）。
   *
   * 为什么必须拉一次现有的：用户贴了"两个期中各 30%"，若只看本次条目会算出"合计 60%，缺 40%"——
   * 而真相可能是这门课 syllabus 里另有 40% 的 Final。合计校验必须按**整门课**算，
   * 只看本次输入就是在制造假警报（与 `lib/course-update/weights.ts` 里"按 source 分组"同一条纪律）。
   */
  const [existingWeights, setExistingWeights] = useState<WeightedItem[]>([])
  /** 现有考试名（用于提示"这条会和已有考试重名"，因为本通道是追加、不覆盖）。 */
  const [existingExamNames, setExistingExamNames] = useState<string[]>([])
  /** 现有考试 / 构成的**精确去重键**（同名 + 同日期 / 同名 + 同占比）→ "已存在"提示与默认不勾选。 */
  const [existingExamKeys, setExistingExamKeys] = useState<string[]>([])
  const [existingGradeKeys, setExistingGradeKeys] = useState<string[]>([])
  /** 现有构成没取到（网络/接口问题）→ 合计预览不可信，如实说明而不是装作算过。 */
  const [weightPreviewUnavailable, setWeightPreviewUnavailable] = useState(false)

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
    setExamPicked({})
    setGradePicked({})
    setExistingExamKeys([])
    setExistingGradeKeys([])
    setError(null)
  }

  /**
   * 拉该课**已存在**的成绩构成 / 考试（仅供写入前的预览校验与重复提示，不参与写入）。
   *
   * ⚠️ `GET /api/v1/courses/:id` 的响应**没有 `data` 包装**（直接返回课程详情对象），
   * 与列表端点 `{ data, meta }` 不一致 —— 这是项目里已知的包装不统一（见 MEMORY）。
   * 所以这里按裸对象读，别照抄别处的 `d.data`。
   *
   * @returns 现有考试 / 构成的去重键（调用方用它决定默认勾选）。
   */
  async function loadExistingContext(
    cid: string,
  ): Promise<{ examKeys: string[]; gradeKeys: string[] }> {
    setWeightPreviewUnavailable(false)
    try {
      const res = await fetch(`/api/v1/courses/${encodeURIComponent(cid)}`)
      if (!res.ok) {
        setWeightPreviewUnavailable(true)
        return { examKeys: [], gradeKeys: [] }
      }
      const detail = (await res.json()) as {
        gradeComponents?: { name?: string | null; source?: string | null; weightPercent?: number | null }[]
        examDates?: { examName?: string | null; examDate?: string | null }[]
      }
      const grades = Array.isArray(detail.gradeComponents) ? detail.gradeComponents : []
      setExistingWeights(
        grades.map((row) => ({
          source: row.source ?? "manual",
          weightPercent: typeof row.weightPercent === "number" ? row.weightPercent : null,
        })),
      )
      const exams = Array.isArray(detail.examDates) ? detail.examDates : []
      const examKeys = exams
        .map((row) => examKey(String(row.examName ?? ""), row.examDate ?? null))
        .filter((key) => key !== "|")
      setExistingExamNames(exams.map((row) => String(row.examName ?? "")).filter((n) => n !== ""))
      return {
        examKeys,
        gradeKeys: grades.map((row) =>
          gradeKey(String(row.name ?? ""), typeof row.weightPercent === "number" ? row.weightPercent : null),
        ),
      }
    } catch {
      // 取不到就**如实标记**（渲染层会说"合计校验将在写入后给出"），
      // 不能默默按"零条现有构成"算 —— 那会报一个不存在的缺口。
      setWeightPreviewUnavailable(true)
      return { examKeys: [], gradeKeys: [] }
    }
  }

  /**
   * 打开一次会话时的起步动作（浮窗点开 / 整页首次挂载都调它）：
   * 拉课程 + 清输入 + 清回执，避免上一次的残留串进这一次。
   */
  function startSession() {
    loadCourses()
    resetInput()
    setSummary(null)
    setExistingWeights([])
    setExistingExamNames([])
    setExistingExamKeys([])
    setExistingGradeKeys([])
    setWeightPreviewUnavailable(false)
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

  /**
   * 把解析结果收进状态前的**统一整形**（文本档与截图档共用一份）。
   *
   * 为什么要在这里再兜一层：schema 已经把考试拆到 `exams` 字段了，但模型偶尔仍会把
   * 考试塞进 `tasks`（taskType='exam'）。**静默丢掉是 R3 的静默失败** —— 用户看到
   * "识别到 6 个考试日期"，结果一条都没出现。所以丢掉的同时补一条 warning 说清楚。
   */
  function acceptParseResult(result: ParseResult) {
    const allTasks = Array.isArray(result.tasks) ? result.tasks : []
    const dropped = allTasks.filter((t) => t.taskType === "exam")
    const warnings = [...(Array.isArray(result.warnings) ? result.warnings : [])]
    if (dropped.length > 0) {
      warnings.push(
        `有 ${dropped.length} 条被识别成考试却混在任务里，已跳过 —— 考试请按「考试」区展示（本条不该出现，请反馈）`,
      )
    }
    return {
      safeTasks: allTasks.filter((t) => t.taskType !== "exam"),
      exams: Array.isArray(result.exams) ? result.exams : [],
      gradeComponents: Array.isArray(result.gradeComponents) ? result.gradeComponents : [],
      warnings,
    }
  }

  async function handleParse() {
    setError(null)
    setParsed(null)
    setCandidatesFor({})
    setResolutions({})
    setExamPicked({})
    setGradePicked({})
    setExistingWeights([])
    setExistingExamNames([])
    setWeightPreviewUnavailable(false)
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

    // P0-3-27：粘贴的是链接 → 先抓成文本，再走**同一条**解析通道（不新开解析路径）。
    let sourceText = text.trim()
    if (looksLikeUrl(sourceText)) {
      setIngesting(true)
      try {
        const res = await fetch("/api/v1/ingest/url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: sourceText }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data?.error?.message ?? "链接抓取失败，请稍后重试")
          return
        }
        const fetched = typeof data?.data?.text === "string" ? data.data.text : ""
        if (fetched.trim() === "") {
          setError("这个链接里没抓到可读内容，换个页面试试？")
          return
        }
        sourceText = fetched
        // 把抓回来的文本填回输入框：用户看得见 Tempo 到底读了什么（原文可核对）。
        setText(fetched)
      } catch {
        setError("链接抓取失败，请检查网络后重试")
        return
      } finally {
        setIngesting(false)
      }
    }

    let accepted = {
      safeTasks: [] as ParsedTask[],
      exams: [] as ParsedExam[],
      gradeComponents: [] as ParsedGradeComponent[],
      warnings: [] as string[],
    }
    setParsing(true)
    try {
      const res = await fetch("/api/v1/tasks/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceText, courseId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error?.message ?? "解析失败，请重试")
        return
      }
      accepted = acceptParseResult(
        (data.data ?? {
          tasks: [],
          exams: [],
          gradeComponents: [],
          warnings: [],
        }) as ParseResult,
      )
    } catch {
      setError("网络错误，请重试")
      return
    } finally {
      setParsing(false)
    }

    if (!commitParseResult(accepted, courseId)) return

    if (accepted.safeTasks.length > 0) {
      setSearching(true)
      try {
        await loadCandidates(accepted.safeTasks, courseId)
      } finally {
        setSearching(false)
      }
    }
  }

  /**
   * 落地一次解析结果：写入 `parsed`、默认全选考试/构成、必要时拉现有构成做合计预览。
   * @returns 有内容可确认 → true；完全空 → false（调用方给「没识别出内容」提示）。
   */
  async function commitParseResult(
    accepted: {
      safeTasks: ParsedTask[]
      exams: ParsedExam[]
      gradeComponents: ParsedGradeComponent[]
      warnings: string[]
    },
    cid: string,
  ): Promise<boolean> {
    const { safeTasks, exams, gradeComponents, warnings } = accepted
    if (
      safeTasks.length === 0 &&
      exams.length === 0 &&
      gradeComponents.length === 0 &&
      warnings.length === 0
    ) {
      setError("没识别出可添加的内容，换个说法试试？")
      return false
    }

    setParsed({ tasks: safeTasks, exams, gradeComponents, warnings })

    // 先取现有数据、再定默认勾选：已存在（同名 + 同日期 / 同名 + 同占比）的条目
    // **默认不勾选**。注意这不是"静默跳过"——空勾选框 + 旁边的「已存在」说明就是给用户看的
    // （静默跳过等于假装成功，是 R3 红线）。
    let examKeys: string[] = []
    let gradeKeys: string[] = []
    if (exams.length > 0 || gradeComponents.length > 0) {
      const existing = await loadExistingContext(cid)
      examKeys = existing.examKeys
      gradeKeys = existing.gradeKeys
    }

    const nextExamPicks: Record<number, boolean> = {}
    exams.forEach((exam, index) => {
      nextExamPicks[index] = !examKeys.includes(examKey(exam.examName, exam.examDate))
    })
    const nextGradePicks: Record<number, boolean> = {}
    gradeComponents.forEach((item, index) => {
      nextGradePicks[index] = !gradeKeys.includes(gradeKey(item.name, item.weightPercent))
    })
    setExistingExamKeys(examKeys)
    setExistingGradeKeys(gradeKeys)
    setExamPicked(nextExamPicks)
    setGradePicked(nextGradePicks)
    return true
  }

  /** 截图档解析分支（P0-3-9）。 */
  async function handleParseImage() {
    if (!image) return
    let accepted = {
      safeTasks: [] as ParsedTask[],
      exams: [] as ParsedExam[],
      gradeComponents: [] as ParsedGradeComponent[],
      warnings: [] as string[],
    }
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
      accepted = acceptParseResult(
        (data.data ?? {
          tasks: [],
          exams: [],
          gradeComponents: [],
          warnings: [],
        }) as ParseResult,
      )
    } catch {
      setError("网络错误，请重试")
      return
    } finally {
      setParsing(false)
    }

    if (!commitParseResult(accepted, courseId)) return

    if (accepted.safeTasks.length > 0) {
      setSearching(true)
      try {
        await loadCandidates(accepted.safeTasks, courseId)
      } finally {
        setSearching(false)
      }
    }
  }

  /** 考试 / 成绩构成的勾选（默认全选，这里只做取消/恢复）。 */
  function toggleExam(index: number) {
    setExamPicked((prev) => ({ ...prev, [index]: prev[index] === false }))
  }

  function toggleGrade(index: number) {
    setGradePicked((prev) => ({ ...prev, [index]: prev[index] === false }))
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
    if (!parsed) return
    const pickedExams = (parsed.exams ?? []).filter((_, i) => examPicked[i] !== false)
    const pickedGrades = (parsed.gradeComponents ?? []).filter((_, i) => gradePicked[i] !== false)
    if (parsed.tasks.length === 0 && pickedExams.length === 0 && pickedGrades.length === 0) return
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

      // ---------------------------------------------------------------
      // P0-3-24：考试 / 成绩构成（走独立端点，**只追加**）
      // ---------------------------------------------------------------
      // 为什么不复用 `PUT /courses/:id/exam-dates`：那个是全量替换，会把已有条目删掉。
      // 对话输入不是"这门课的完整构成"，用户完全不会预期自己的旧数据被清空。
      let apply: ApplySummary | null = null
      if (pickedExams.length > 0 || pickedGrades.length > 0) {
        const res = await fetch("/api/v1/course-updates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseId,
            exams: pickedExams.map((e) => ({
              examName: e.examName,
              examDate: e.examDate,
              examTime: e.examTime,
              location: e.location,
              sourceExcerpt: e.sourceExcerpt,
            })),
            gradeComponents: pickedGrades.map((g) => ({
              name: g.name,
              weightPercent: g.weightPercent,
              notes: g.notes,
              sourceExcerpt: g.sourceExcerpt,
            })),
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          // 服务端对单条非法输入是**整批拒绝**（不做"跳过坏的写好的"），
          // 所以这里明确报错、保留输入让用户改，不要装作部分成功。
          setError(data?.error?.message ?? "考试 / 成绩构成写入失败，请重试")
          return
        }
        const d = (data.data ?? {}) as {
          exams?: { created: number } | null
          gradeComponents?: { created: number } | null
          weightWarnings?: string[]
          summary?: string
        }
        apply = {
          exams: d.exams?.created ?? 0,
          gradeComponents: d.gradeComponents?.created ?? 0,
          weightWarnings: d.weightWarnings ?? [],
          text: d.summary ?? "",
        }
      }

      setSummary({ created, updated: updated + newMarkedDone, skipped, apply })
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

  /** 本次将要写入的考试 / 成绩构成条数（勾选之后）。 */
  const pickedExamCount = parsed
    ? (parsed.exams ?? []).filter((_, i) => examPicked[i] !== false).length
    : 0
  const pickedGradeCount = parsed
    ? (parsed.gradeComponents ?? []).filter((_, i) => gradePicked[i] !== false).length
    : 0

  /**
   * 写入前的合计预览：**现有构成 + 本次要写的条目**一起算（按 source 分组）。
   * 只算本次输入会报出不存在的缺口（见 `existingWeights` 的注释）。
   */
  const previewWarnings: string[] = (() => {
    if (!parsed || pickedGradeCount === 0) return []
    const incoming: WeightedItem[] = (parsed.gradeComponents ?? [])
      .filter((_, i) => gradePicked[i] !== false)
      .map((item) => ({ source: "manual", weightPercent: item.weightPercent }))
    return weightWarnings([...existingWeights, ...incoming])
  })()

  /** 现有构成分组（UI 里说明"这门课现在已标注了什么"）。 */
  const existingTotals = summarizeWeightTotals(existingWeights)

  return {
    // 状态
    courses,
    courseId,
    text,
    image,
    imagePreview,
    loadingCourses,
    parsing,
    ingesting,
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
    // P0-3-24
    examPicked,
    gradePicked,
    pickedExamCount,
    pickedGradeCount,
    previewWarnings,
    existingTotals,
    existingExamNames,
    existingExamKeys,
    existingGradeKeys,
    weightPreviewUnavailable,
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
    toggleExam,
    toggleGrade,
    handleConfirm,
  }
}

/** 浮窗 / 整页共用的流程类型（外壳只依赖它，不重复声明）。 */
export type CourseUpdateFlow = ReturnType<typeof useCourseUpdateFlow>
