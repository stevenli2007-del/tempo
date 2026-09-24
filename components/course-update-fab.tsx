"use client"

/**
 * 全局课程更新浮窗（P0-3-8 文本档 + P0-3-8b 检索/更新 + P0-3-9 截图档）。
 *
 * 一个常驻右下角的小圆圈 FAB，点开就是「更新课程」对话框。挂在 `AppShell` 里，
 * 所以**所有已登录页面都看得到**（ADR-016：对话框是兜底不是入口 —— 随时能 update，
 * 但零操作成本）。
 *
 * ### 📌 P0-3-18：本文件只剩「外壳」
 * 状态机与网络调用在 `components/tasks/use-course-update-flow.ts`，
 * 渲染在 `components/tasks/update-flow-parts.tsx` —— 与全屏页 `/messages` **共用同一份**。
 * 这里只负责「右下角那个圆圈 + 打开/关闭 + 成功后收起」。
 * 🔴 不要把流程逻辑搬回本文件：一旦浮窗与整页各有一份「确认才写」的判定，
 * 就会重演 P0-3-15 那种「两处各自都对、说的不是同一件事」的分叉（CodingRules §10.1 第 21 条）。
 *
 * ### 两条红线（在共享层实现，这里不重复）
 * - **确认才写**：解析与检索都不落库，只有点「确认」才写。
 * - **只改手动任务**：Canvas / 考试类候选只读（见 `candidateHint()`）。
 */

import { useState } from "react"

import { useT } from "@/lib/i18n/use-i18n"

import { UpdateActions, UpdateComposer, UpdateReview } from "@/components/tasks/update-flow-parts"
import { useCourseUpdateFlow } from "@/components/tasks/use-course-update-flow"

export function CourseUpdateFab() {
  const flow = useCourseUpdateFlow()
  const t = useT()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label={t("fab.title")}
        title={t("fab.title")}
        onClick={() => {
          setOpen(true)
          flow.startSession()
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
              <h2 className="text-base font-semibold text-ink">{t("fab.title")}</h2>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => setOpen(false)}
                className="text-muted-foreground transition hover:text-ink"
              >
                ✕
              </button>
            </div>

            <UpdateComposer flow={flow} />
            <UpdateReview flow={flow} />
            <UpdateActions
              flow={flow}
              onConfirmSuccess={() => {
                // 成功后短暂回显回执再收起（原行为，P0-3-8 验收过）。
                setTimeout(() => setOpen(false), 1200)
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
