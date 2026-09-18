"use client"

/**
 * 消息栏的交互层（P0-3-18）。
 *
 * 服务端预取 `initialViews`（RLS 已收口），这里只做客户端交互：
 * - 确认 / 忽略：调 `PATCH /api/v1/messages/:id`，成功后用 `toMessageView` 重建该条视图
 *   （与 API 共用同一份判定，不在这里另写一套"能不能点"）；并 dispatch
 *   `MESSAGES_UPDATED_EVENT` 让侧栏徽标即时刷新。
 * - 底部内嵌「告诉 Tempo 一个 Update」：复用 `useCourseUpdateFlow` + 共享渲染件，
 *   **用户的输入不进 `messages` 表**（只写 `tasks`，那是数据本身）。
 */

import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { UpdateActions, UpdateComposer, UpdateReview } from "@/components/tasks/update-flow-parts"
import { useCourseUpdateFlow } from "@/components/tasks/use-course-update-flow"
import { MESSAGES_UPDATED_EVENT } from "@/lib/messages/event"
import { toMessageView, type MessageView } from "@/lib/messages/view"

export function MessagesView({ initialViews }: { initialViews: MessageView[] }) {
  const [views, setViews] = useState<MessageView[]>(initialViews)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const flow = useCourseUpdateFlow()

  const { pendingViews, doneViews } = useMemo(() => {
    const pending: MessageView[] = []
    const done: MessageView[] = []
    for (const v of views) {
      if (v.isPending) pending.push(v)
      else done.push(v)
    }
    return { pendingViews: pending, doneViews: done }
  }, [views])

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
    <div className="space-y-8">
      <section>
        {views.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
            <p className="text-sm text-ink-muted">暂时没有需要确认的提案。</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tempo 发现大纲变动、新资料或学习建议时，会出现在这里。
            </p>
          </div>
        ) : (
          <>
            {pendingViews.length > 0 && (
              <div className="space-y-3">
                {pendingViews.map((view) => (
                  <MessageCard
                    key={view.id}
                    view={view}
                    busy={busyId === view.id}
                    onAccept={() => void decide(view.id, "accepted")}
                    onDismiss={() => void decide(view.id, "dismissed")}
                  />
                ))}
              </div>
            )}

            {doneViews.length > 0 && (
              <>
                <div className="mb-3 mt-7 text-xs font-medium text-muted-foreground">已处理</div>
                <div className="space-y-3 opacity-70">
                  {doneViews.map((view) => (
                    <MessageCard
                      key={view.id}
                      view={view}
                      busy={busyId === view.id}
                      onAccept={() => void decide(view.id, "accepted")}
                      onDismiss={() => void decide(view.id, "dismissed")}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-ink">告诉 Tempo 一个 Update</h2>
        <p className="mb-4 mt-1 text-sm text-ink-muted">
          贴文字或截图，Tempo 帮你识别并写入任务。你的输入只改任务数据，不会出现在消息栏。
        </p>
        <UpdateComposer flow={flow} />
        <UpdateReview flow={flow} />
        <UpdateActions flow={flow} />
      </section>
    </div>
  )
}

function MessageCard({
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
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {view.typeLabel}
            </span>
            {view.courseLabel && (
              <span className="text-xs text-muted-foreground">· {view.courseLabel}</span>
            )}
            {view.confidence === "low" && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
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
          <p className="mt-2 text-xs text-muted-foreground">{view.timeLabel}</p>
        </div>
      </div>

      {view.isPending ? (
        <div className="mt-3 flex items-center justify-end gap-2">
          {!view.canAccept && view.blockReason && (
            <span
              className="mr-auto max-w-[60%] text-xs text-muted-foreground"
              title={view.blockReason}
            >
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
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {view.status === "accepted" ? "已确认" : "已忽略"}
        </p>
      )}
    </div>
  )
}
