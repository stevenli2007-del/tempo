"use client"

/**
 * 「更新课程」流程的**唯一一份渲染**（P0-3-18 从浮窗抽出）。
 *
 * 右下角浮窗（`course-update-fab.tsx`）与全屏消息栏（`/messages`）都渲染这三个组件，
 * 状态与网络调用来自 `use-course-update-flow.ts` —— 一个状态机、一份 UI、两处外壳。
 *
 * 顺序固定：`<UpdateComposer/>`（输入）→ `<UpdateReview/>`（识别 + 消歧）→ `<UpdateActions/>`（确认）。
 */

import { useRef } from "react"

import { sourceLabel } from "@/lib/course-update/weights"
import { Button } from "@/components/ui/button"
import {
  candidateHint,
  examKey,
  formatDay,
  gradeKey,
  isEditable,
  taskTypeLabel,
  type CourseUpdateFlow,
} from "./use-course-update-flow"

/** 课程选择 + 文本 / 截图输入 + 错误与回执。 */
export function UpdateComposer({ flow }: { flow: CourseUpdateFlow }) {
  // 选文件的 `<input>` 由本组件持有 —— DOM 引用属于视图，不从状态机里外借
  // （外借会让 eslint 的 react-hooks/refs 把整个 `flow` 当成 ref，见 hook 里的注释）。
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <label className="mb-1 block text-sm text-muted-foreground">课程</label>
      <select
        value={flow.courseId}
        onChange={(e) => flow.setCourseId(e.target.value)}
        disabled={flow.loadingCourses}
        className="mb-3 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">
          {flow.loadingCourses ? "加载中…" : flow.courses.length === 0 ? "还没有课程" : "选择课程"}
        </option>
        {flow.courses.map((c) => (
          <option key={c.id} value={c.id}>
            {c.courseName}
          </option>
        ))}
      </select>

      {/* 一门课都没有时，下拉里没有可选项 —— 明说去哪儿加，并给一个重试入口
          （列表可能是没取到，不一定是真的空）。 */}
      {!flow.loadingCourses && flow.courses.length === 0 && (
        <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
          还没有课程 —— 先去「我的课程」加一门，Tempo 才知道这条更新属于哪门课。
          <button
            type="button"
            onClick={flow.loadCourses}
            className="ml-1 underline transition hover:text-ink"
          >
            重新加载
          </button>
        </p>
      )}

      {/* 4 行是 P0-3-8/3-9 验收过的浮窗高度；整页共用这一份渲染，所以两处都是 4 行。 */}
      <textarea
        value={flow.text}
        onChange={(e) => flow.setText(e.target.value)}
        onPaste={flow.handlePaste}
        rows={4}
        placeholder="Hi，有什么 Update 想要告诉 Tempo？"
        disabled={!!flow.image}
        className="mb-2 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      />

      {/* P0-3-9 截图档：选图 / 粘贴入口（与文字互斥）。 */}
      <div className="mb-3 flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void flow.handleFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!!flow.image}
          onClick={() => fileInputRef.current?.click()}
        >
          选择图片
        </Button>
        <span className="text-xs text-muted-foreground">或在此框内 Cmd+V 粘贴截图</span>
      </div>

      {flow.image && flow.imagePreview && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={flow.imagePreview}
            alt="待识别截图"
            className="h-20 w-20 rounded object-cover"
          />
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              截图已就绪，点「解析」识别更新（将发送给视觉模型）
            </span>
            <button
              type="button"
              onClick={flow.removeImage}
              className="w-fit text-xs text-muted-foreground underline transition hover:text-ink"
            >
              移除截图
            </button>
          </div>
        </div>
      )}

      {flow.error && <p className="mb-2 text-sm text-destructive">{flow.error}</p>}
      {flow.summary && (
        <div className="mb-2 space-y-1">
          {(flow.summary.created > 0 || flow.summary.updated > 0) && (
            <p className="text-sm text-emerald-500">
              任务：已新增 {flow.summary.created} 条 · 已更新 {flow.summary.updated} 条
              {flow.summary.skipped > 0 ? ` · 跳过 ${flow.summary.skipped} 条` : ""} ✓
            </p>
          )}
          {/* 回执文案由**服务端**拼（`lib/course-update/apply.ts` 的 `summarizeApply`），
              3-26 的消息栏回执共用同一份措辞 —— 不在这里另写一遍，否则两处说法会漂移。 */}
          {flow.summary.apply && flow.summary.apply.text !== "" && (
            <p className="text-sm text-emerald-500">{flow.summary.apply.text} ✓</p>
          )}
          {/* 合计 ≠ 100% 的报警：**留灰不补**，只如实说差多少（lib/course-update/weights.ts）。 */}
          {flow.summary.apply?.weightWarnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
    </>
  )
}

/** 识别结果 + 消歧（0 命中新增 / 有命中让用户选改哪条）+ 考试 / 成绩构成分区。 */
export function UpdateReview({ flow }: { flow: CourseUpdateFlow }) {
  const parsed = flow.parsed
  if (!parsed) return null

  const hasTasks = parsed.tasks.length > 0
  // 三个分区各自独立：只贴了一段 "Quiz 1: Sep 4 …" 时不该因为 tasks 为空就整块不渲染。
  const hasExams = (parsed.exams?.length ?? 0) > 0
  const hasGrades = (parsed.gradeComponents?.length ?? 0) > 0
  if (!hasTasks && !hasExams && !hasGrades) return null

  return (
    <div className="mb-3 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">识别到的更新（确认后写入）</p>
      {hasTasks && <TaskReview flow={flow} />}
      {hasExams && <ExamReview flow={flow} />}
      {hasGrades && <GradeReview flow={flow} />}
    </div>
  )
}

/** 任务分区（原 P0-3-8/3-9 的消歧渲染，逻辑一字未改）。 */
function TaskReview({ flow }: { flow: CourseUpdateFlow }) {
  if (!flow.parsed) return null
  return (
    <div className="space-y-3">
      {flow.parsed.tasks.map((task, index) => {
        const candidates = flow.candidatesFor[index] ?? []
        const resolution = flow.resolutions[index] ?? { mode: "create" as const }
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

            {flow.searching ? (
              <p className="mt-2 text-xs text-muted-foreground">正在匹配现有任务…</p>
            ) : (
              (() => {
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
                            onChange={() => flow.chooseCreate(index)}
                            className="mt-1"
                          />
                          <span className="text-ink">都不是，新建一条</span>
                        </label>
                        {editableCandidates.map((candidate) => {
                          const hint = candidateHint(candidate)
                          const selected =
                            resolution.mode === "update" && resolution.candidate.id === candidate.id
                          return (
                            <label
                              key={candidate.id}
                              className="flex cursor-pointer items-start gap-2 text-sm"
                            >
                              <input
                                type="radio"
                                name={`resolution-${index}`}
                                checked={selected}
                                onChange={() => flow.chooseCandidate(index, candidate)}
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
                            flow.setOpenReadonly((p) => ({ ...p, [index]: !p[index] }))
                          }
                          className="flex w-full items-center justify-between text-xs text-muted-foreground transition hover:text-ink"
                        >
                          <span>只读任务（Canvas / 考试）— {readonlyCandidates.length} 项</span>
                          <span>{flow.openReadonly[index] ? "▾" : "▸"}</span>
                        </button>
                        {flow.openReadonly[index] && (
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
              })()
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 考试分区（P0-3-24）。
 *
 * 三条都要显示，缺一条用户就无法核对：
 * 1. **逐字原文摘录**（`sourceExcerpt`）—— 没有它用户没法判断模型有没有编日期，
 *    而服务端校验器要求非空，所以这里必然有值；
 * 2. **日期待定**如实写成待定（`examDate === null`），不当成"没识别出来"而隐藏；
 * 3. **与现有考试重名时提示**——本通道是追加不是覆盖，重名会真的多出一条。
 */
function ExamReview({ flow }: { flow: CourseUpdateFlow }) {
  const exams = flow.parsed?.exams ?? []
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        考试安排 — {exams.length} 条（写入课程的「考试日期」，并自动同步为任务）
      </p>
      {exams.map((exam, index) => {
        const picked = flow.examPicked[index] !== false
        // 精确重复（同名 + 同日期）→ 默认没勾、并说明原因；同名不同日期只给提醒（可能是补考/改期）。
        const existed = flow.existingExamKeys.includes(examKey(exam.examName, exam.examDate))
        const duplicated = flow.existingExamNames.includes(exam.examName)
        return (
          <div key={index} className="rounded-lg border border-border bg-muted/40 p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked}
                onChange={() => flow.toggleExam(index)}
                className="mt-1"
              />
              <span>
                <span className="text-ink">{exam.examName}</span>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  · {exam.examDate ? formatDay(exam.examDate) : "日期待定"}
                  {exam.examTime ? ` · ${exam.examTime}` : ""}
                  {exam.location ? ` · ${exam.location}` : ""}
                </span>
                {existed && (
                  <span className="ml-1 rounded bg-muted px-1 text-xs text-muted-foreground">
                    已存在
                  </span>
                )}
              </span>
            </label>
            <p className="mt-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
              原文：{exam.sourceExcerpt}
            </p>
            {existed && (
              <p className="mt-1 text-xs text-muted-foreground">
                这门课已有同名同日期的一条 —— 已默认不勾选。仍想再写一条就把它勾上。
              </p>
            )}
            {!existed && duplicated && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                这门课已有一条同名考试（日期不同）—— 这里是追加，勾选后会变成两条（若只是改期，
                请到课程页改）
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 成绩构成分区（P0-3-24）。
 *
 * 合计按 **source 分组**算，且**连这门课已有的构成一起算** ——
 * 只看本次输入会把"两个期中各 30%"报成"缺 40%"，而真相可能是 syllabus 里另有 Final 40%。
 * 缺口留灰（不补、不摊），与 `lib/course-update/weights.ts` 同一条纪律。
 */
function GradeReview({ flow }: { flow: CourseUpdateFlow }) {
  const components = flow.parsed?.gradeComponents ?? []
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        成绩构成 — {components.length} 条（写入课程的「成绩构成」）
      </p>
      {components.map((item, index) => {
        const picked = flow.gradePicked[index] !== false
        const existed = flow.existingGradeKeys.includes(gradeKey(item.name, item.weightPercent))
        return (
          <div key={index} className="rounded-lg border border-border bg-muted/40 p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked}
                onChange={() => flow.toggleGrade(index)}
                className="mt-1"
              />
              <span>
                <span className="text-ink">{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  · {item.weightPercent === null ? "未标占比" : `${item.weightPercent}%`}
                  {item.notes ? ` · ${item.notes}` : ""}
                </span>
                {existed && (
                  <span className="ml-1 rounded bg-muted px-1 text-xs text-muted-foreground">
                    已存在
                  </span>
                )}
              </span>
            </label>
            <p className="mt-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
              原文：{item.sourceExcerpt}
            </p>
            {existed && (
              <p className="mt-1 text-xs text-muted-foreground">
                这门课已有同名同占比的一条 —— 已默认不勾选（否则合计会翻倍）。
              </p>
            )}
          </div>
        )
      })}

      {flow.weightPreviewUnavailable ? (
        <p className="text-xs text-muted-foreground">
          现有成绩构成没取到，无法在写入前算合计 —— 确认后会给出写入后的合计校验。
        </p>
      ) : (
        <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          {flow.existingTotals.length > 0 && (
            <p>
              这门课现有：
              {flow.existingTotals
                .map(
                  (group) =>
                    `${sourceLabel(group.source)} ${group.total}%（${group.knownCount} 项）`,
                )
                .join(" · ")}
            </p>
          )}
          {flow.previewWarnings.length > 0 ? (
            flow.previewWarnings.map((w, i) => (
              <p key={i} className="text-amber-600 dark:text-amber-400">
                ⚠ {w}
              </p>
            ))
          ) : (
            <p className="text-emerald-600 dark:text-emerald-400">
              加上本次要写的条目后，手动来源合计正好 100%。
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** 警告（解析器给的提醒，不是错误）+ 底部动作行。 */
export function UpdateActions({
  flow,
  onConfirmSuccess,
}: {
  flow: CourseUpdateFlow
  onConfirmSuccess?: () => void
}) {
  // 三个分区任意一个有内容，就进入"确认"态（只贴考试日期时 tasks 是空的，不能再按 tasks 判）。
  const hasAny =
    !!flow.parsed &&
    (flow.parsed.tasks.length > 0 ||
      (flow.parsed.exams?.length ?? 0) > 0 ||
      (flow.parsed.gradeComponents?.length ?? 0) > 0)

  // 文案只列非零项：否则只写了一门课的考试时会看到"新增 0 · 更新 0 · 考试 6"这种噪音。
  const picked = [
    flow.createCount > 0 ? `新增 ${flow.createCount}` : "",
    flow.updateCount > 0 ? `更新 ${flow.updateCount}` : "",
    flow.pickedExamCount > 0 ? `考试 ${flow.pickedExamCount}` : "",
    flow.pickedGradeCount > 0 ? `成绩构成 ${flow.pickedGradeCount}` : "",
  ].filter((part) => part !== "")
  const nothingPicked = picked.length === 0

  return (
    <>
      {flow.parsed && flow.parsed.warnings.length > 0 && (
        <div className="mb-3 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
          {flow.parsed.warnings.map((w, i) => (
            <p key={i}>⚠ {w}</p>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {!hasAny ? (
          <Button onClick={flow.handleParse} disabled={flow.parsing}>
            {flow.parsing ? "解析中…" : "解析"}
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={flow.resetInput} disabled={flow.saving}>
              重新输入
            </Button>
            <Button
              onClick={() => void flow.handleConfirm(onConfirmSuccess)}
              disabled={flow.saving || flow.searching || nothingPicked}
            >
              {flow.saving
                ? "保存中…"
                : nothingPicked
                  ? "确认（未选择任何条目）"
                  : `确认（${picked.join(" · ")}）`}
            </Button>
          </>
        )}
      </div>
    </>
  )
}
