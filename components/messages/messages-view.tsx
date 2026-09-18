"use client"

/**
 * 消息栏的交互层（P0-3-18）。
 *
 * 服务端预取 `initialViews`（RLS 已收口），这里只做客户端交互：
 * - 确认 / 忽略：调 `PATCH /api/v1/messages/:id`，成功后用 `toMessageView` 重建该条视图
 *   （与 API 共用同一份判定，不在这里另写一套"能不能点"）；并 dispatch
 *   `MESSAGES_UPDATED_EVENT` 让侧栏徽标即时刷新。
 * - 底部常驻输入区「告诉 Tempo 一个 Update」：复用 `useCourseUpdateFlow` + 共享渲染件，
 *   **用户的输入不进 `messages` 表**（只写 `tasks`，那是数据本身）。
 *
 * ### 版面（2026-09-17 验收修正 → 会话式）
 * 对齐 ChatGPT / Claude：**中间消息流是唯一可滚动区，底部输入区常驻**。
 * 处理过的提案不再用等身大卡片占位 —— 状态一变就**就地降级成一行回执**并随会话向上滚走，
 * 于是"已处理"永远不占版面，也不需要再单独划一块「已处理」区域。
 * （用户原话：「选择忽略掉的内容直接覆盖掉…做成滚动式的」。）
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { UpdateActions, UpdateComposer, UpdateReview } from "@/components/tasks/update-flow-parts"
import { useCourseUpdateFlow } from "@/components/tasks/use-course-update-flow"
import type { CourseOption } from "@/components/tasks/use-course-update-flow"
import { MESSAGES_UPDATED_EVENT } from "@/lib/messages/event"
import { toMessageView, type MessageView } from "@/lib/messages/view"

/** 气泡头像的宽 + 间距（size-7 = 28px，gap-2.5 = 10px）。回执靠它左沿对齐气泡内容。 */
const RECEIPT_INDENT = "pl-[38px]"

export function MessagesView({
  initialViews,
  initialCourses,
}: {
  initialViews: MessageView[]
  /**
   * 服务端预取的课程下拉项。整页的输入区是常驻的（不像浮窗有"点开"这个动作去拉列表），
   * 不预取的话课程下拉里一个选项都没有 —— 见 `useCourseUpdateFlow` 的 `initialCourses`。
   */
  initialCourses: CourseOption[]
}) {
  const [views, setViews] = useState<MessageView[]>(initialViews)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const flow = useCourseUpdateFlow({ initialCourses })
  const streamRef = useRef<HTMLDivElement | null>(null)

  // 旧 → 新：最新的一条落在底部、紧邻输入区，与 ChatGPT / Claude 的会话方向一致。
  // 显式按 `createdAt` 排，**不依赖 `loadMessages` 的返回顺序**（那是数据层的实现细节，
  // 哪天改个 `.order()` 就会静默错排，而且 tsc / build 全绿）。
  const ordered = useMemo(
    () =>
      [...views].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [views],
  )

  // 首屏滚到最新一条：可操作（pending）的提案就停在输入区上方，不必先滚一段。
  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  async function decide(id: string, status: "accepted" | "dismissed") {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/v1/messages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error?.message ?? "操作失败，请重试")
        return
      }
      // 用 PATCH 返回的最新 Message 重建视图，判定走 toMessageView 单一来源。
      setViews((prev) => prev.map((v) => (v.id === id ? toMessageView(data.data) : v)))
      // 通知侧栏徽标刷新（同页面不会触发路由切换，靠事件补一次）。
      window.dispatchEvent(new Event(MESSAGES_UPDATED_EVENT))
    } catch {
      setError("网络错误，请重试")
    } finally {
      setBusyId(null)
    }
  }

  return (
    // `flex-1 min-h-0`（而不是 `h-full`）：父级是固定高度的 flex 列，上面可能还压着一条
    // 错误横幅 —— 用 `h-full` 会把横幅挤出去、并多出一条滚动条。
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 唯一的可滚动区：消息流。 */}
      <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-[820px] space-y-2.5 px-1 pb-4 pt-2">
          {ordered.length === 0 ? (
            <EmptyState />
          ) : (
            ordered.map((view) =>
              view.isPending ? (
                <ProposalBubble
                  key={view.id}
                  view={view}
                  busy={busyId === view.id}
                  onAccept={() => void decide(view.id, "accepted")}
                  onDismiss={() => void decide(view.id, "dismissed")}
                />
              ) : (
                <ResolvedReceipt key={view.id} view={view} />
              ),
            )
          )}
        </div>
      </div>

      {/* 常驻输入区。整块受 60vh 上限约束：识别结果（UpdateReview）变长时内部滚动，
          而不是把消息流挤没。 */}
      <div className="shrink-0 border-t border-line bg-background/95 backdrop-blur">
        <div className="mx-auto max-h-[60vh] w-full max-w-[820px] overflow-y-auto overscroll-contain px-1 py-3">
          <p className="mb-3 text-xs text-ink-faint">
            确认才生效，忽略就当作没发生 · 你的输入只改任务数据，不会出现在消息栏
          </p>
          <UpdateComposer flow={flow} />
          <UpdateReview flow={flow} />
          <UpdateActions flow={flow} />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}

/** 待确认提案 = 会话里「Tempo 的发言」：左侧头像 + 气泡 + 就地操作。 */
function ProposalBubble({
  view,
  busy,
  onAccept,
  onDismiss,
}: {
  view: MessageView
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  return (
    <div className="flex items-start gap-2.5">
      {/* 品牌色头像：与侧栏 logo 同一treatment（bg-lime + text-on-lime）。 */}
      <span
        aria-hidden
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-lime text-on-lime"
      >
        <Sparkles className="size-4" />
      </span>

      <div className="min-w-0 flex-1 rounded-card rounded-tl-[4px] border border-line bg-card px-4 py-3 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-badge bg-surface2 px-1.5 py-0.5 text-xs text-ink-muted">
            {view.typeLabel}
          </span>
          {view.courseLabel && <span className="text-xs text-ink-muted">{view.courseLabel}</span>}
          {view.confidence === "low" && (
            <span className="rounded-badge bg-amber-bg px-1.5 py-0.5 text-xs text-amber">
              低置信度
            </span>
          )}
        </div>

        <p className="mt-2 text-[15px] font-medium text-ink">{view.title}</p>
        {view.lines.map((line, i) => (
          <p key={i} className="mt-0.5 text-sm text-ink-muted">
            {line}
          </p>
        ))}
        <p className="mt-2 text-xs text-ink-faint">{view.timeLabel}</p>

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
          {!view.canAccept && view.blockReason && (
            <span className="mr-auto max-w-[60%] text-xs text-ink-muted" title={view.blockReason}>
              {view.blockReason}
            </span>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={onDismiss}>
            忽略
          </Button>
          <Button size="sm" disabled={busy || !view.canAccept} onClick={onAccept}>
            确认
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 已处理提案 = 一行回执（刻意不用等身大卡片）。
 *
 * `status` 一离开 pending 就"就地降级"成这一行：忽略掉的内容不再占版面，
 * 也没有真的丢 —— 想回溯还看得见，且随会话继续向上滚走。
 */
function ResolvedReceipt({ view }: { view: MessageView }) {
  const accepted = view.status === "accepted"
  return (
    <div className={`flex items-baseline gap-2 pr-1 text-xs text-ink-faint ${RECEIPT_INDENT}`}>
      <span className={accepted ? "shrink-0 text-green" : "shrink-0"}>
        {accepted ? "✓ 已确认" : "— 已忽略"}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-muted">{view.title}</span>
      <span className="shrink-0 tabular-nums">{view.timeLabel}</span>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-card border border-dashed border-line bg-card/40 px-6 py-10 text-center">
      <p className="text-sm text-ink-muted">暂时没有需要确认的提案。</p>
      <p className="mt-1 text-xs text-ink-faint">
        Tempo 发现大纲变动、新资料或学习建议时，会出现在这里。
      </p>
    </div>
  )
}
