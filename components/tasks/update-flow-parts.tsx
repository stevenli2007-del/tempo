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

import { Button } from "@/components/ui/button"
import {
  candidateHint,
  formatDay,
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
        <p className="mb-2 text-sm text-emerald-500">
          已新增 {flow.summary.created} 条 · 已更新 {flow.summary.updated} 条
          {flow.summary.skipped > 0 ? ` · 跳过 ${flow.summary.skipped} 条` : ""} ✓
        </p>
      )}
    </>
  )
}

/** 识别结果 + 消歧（0 命中新增 / 有命中让用户选改哪条）+ 只读候选折叠。 */
export function UpdateReview({ flow }: { flow: CourseUpdateFlow }) {
  if (!flow.parsed || flow.parsed.tasks.length === 0) return null

  return (
    <div className="mb-3 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">识别到的更新（确认后写入）</p>
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

/** 警告（解析器给的提醒，不是错误）+ 底部动作行。 */
export function UpdateActions({
  flow,
  onConfirmSuccess,
}: {
  flow: CourseUpdateFlow
  onConfirmSuccess?: () => void
}) {
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
        {!flow.parsed || flow.parsed.tasks.length === 0 ? (
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
              disabled={flow.saving || flow.searching}
            >
              {flow.saving
                ? "保存中…"
                : `确认（新增 ${flow.createCount} · 更新 ${flow.updateCount}）`}
            </Button>
          </>
        )}
      </div>
    </>
  )
}
