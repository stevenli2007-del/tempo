"use client"

/**
 * 消息栏的交互层（P0-3-18，P0-3-25b 加上 AI 要点）。
 *
 * 服务端预取 `initialMessages`（RLS 已收口），这里只做客户端交互：
 * - 确认 / 忽略：调 `PATCH /api/v1/messages/:id`，成功后用 `toMessageView` 重建该条视图
 *   （与 API 共用同一份判定，不在这里另写一套"能不能点"）；并 dispatch
 *   `MESSAGES_UPDATED_EVENT` 让侧栏徽标即时刷新。
 * - 底部常驻输入区「告诉 Tempo 一个 Update」：复用 `useCourseUpdateFlow` + 共享渲染件，
 *   **用户的输入不进 `messages` 表**（只写 `tasks`，那是数据本身）。
 * - **AI 要点（P0-3-25b）**：首屏只画服务端已缓存的那部分，缺的在挂载后
 *   `POST /api/v1/messages/summaries` 静默补齐（见 `MAX_SUMMARY_ROUNDS` 与那个 effect 的注释）。
 *   全程不阻塞渲染、不弹错 —— 但要给用户一行「生成中」让他分清"在算"和"没生效"。
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
import { DEFAULT_SUMMARY_LOCALE } from "@/lib/messages/summary/locale"
import { toMessageView, type MessageView } from "@/lib/messages/view"
import type { Message, MessageSummary } from "@/types/message"

/** 气泡头像的宽 + 间距（size-7 = 28px，gap-2.5 = 10px）。回执靠它左沿对齐气泡内容。 */
const RECEIPT_INDENT = "pl-[38px]"

/** 撤销窗口（毫秒）：与路由端一致。前端只管 UX，真正的闸在 API。 */
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 要点请求最多跑几轮。
 *
 * 服务端一轮只算 `MAX_MESSAGES_PER_REQUEST` 条（见 `summary/generate.ts`），
 * 而消息栏里可能有 9 条公告 —— 不续轮的话用户要**反复刷新**才能补齐，
 * 那不叫"静默补"，叫"看起来没生效"。
 * 上限 4 轮 = 单次访问最多 12 次模型调用，且**任何一轮失败都会立刻停下**：
 * 服务端会把失败的落成 `failed` 行（= 别再问），下一轮自然就没人可问了。
 */
const MAX_SUMMARY_ROUNDS = 4

export function MessagesView({
  initialMessages,
  initialCourses,
}: {
  /**
   * 服务端预取的消息（**原始 `Message`，不是视图**）。
   *
   * 🔴 视图在客户端用 `toMessageView()` 现算 —— 因为要点是**异步补进来**的，
   * 必须能从"消息 + 新到的要点"重新派生视图。派生判断只此一处（与服务端同一函数），
   * 组件里不许自己拼 `summaryPoints`（那是 P0-3-15 那类分叉）。
   * `toMessageView` 是纯函数（时间格式固定时区、色板是散列），
   * 服务端与客户端算出的是同一个结果 → 不会 hydration mismatch。
   */
  initialMessages: Message[]
  /**
   * 服务端预取的课程下拉项。整页的输入区是常驻的（不像浮窗有"点开"这个动作去拉列表），
   * 不预取的话课程下拉里一个选项都没有 —— 见 `useCourseUpdateFlow` 的 `initialCourses`。
   */
  initialCourses: CourseOption[]
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  /** 客户端补进来的要点（按消息 id）。服务端已经带下来的那些不从这儿走。 */
  const [liveSummaries, setLiveSummaries] = useState<Record<string, MessageSummary>>({})
  /** 正在请求要点的消息 id（只用来画「生成中」那一行）。 */
  const [summaryBusyIds, setSummaryBusyIds] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyUndoId, setBusyUndoId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const flow = useCourseUpdateFlow({ initialCourses })
  const streamRef = useRef<HTMLDivElement | null>(null)
  /**
   * 已经问过模型的消息 id（含失败）。
   *
   * 用 `ref` 而不是 state：它**不参与渲染**，只防止同一次访问里反复重问。
   * 服务端那次才是权威去重（`failed` 行 = 别再问）—— 刷新页面后就完全靠它，
   * 所以这里不需要持久化，也不会因为热更新/重渲染而漏问。
   */
  const askedRef = useRef<Set<string>>(new Set())

  // 服务端带下来的要点 + 客户端补进来的：后者优先（它是更新的那一次）。
  const views: MessageView[] = useMemo(
    () =>
      messages.map((message) =>
        toMessageView(
          { ...message, summary: liveSummaries[message.id] ?? message.summary ?? null },
          DEFAULT_SUMMARY_LOCALE,
        ),
      ),
    [messages, liveSummaries],
  )

  // 旧 → 新：最新的一条落在底部、紧邻输入区，与 ChatGPT / Claude 的会话方向一致。
  // 显式按 `createdAt` 排，**不依赖 `loadMessages` 的返回顺序**（那是数据层的实现细节，
  // 哪天改个 `.order()` 就会静默错排，而且 tsc / build 全绿）。
  const ordered = useMemo(
    () => [...views].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [views],
  )

  // 首屏滚到最新一条：可操作（pending）的提案就停在输入区上方，不必先滚一段。
  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /**
   * 懒生成要点（P0-3-25b）：**只对"还没问过、且客户端真的会画"的消息**发一次请求。
   *
   * 🔴 要点是增强，所以这条路径**绝不弹错**：失败就什么都不显示，原文与按钮照常。
   *    唯一保留的信号是「AI 总结生成中…」那行字（请求结束即撤）——
   *    它的作用是让用户分清"在算"和"没生效"，而不是把技术错误摊给他看。
   *
   * ⚠️ 依赖里只有 `messages` / `liveSummaries`：`askedRef` 不进依赖（它不该触发重跑），
   *    这样"问过 → 结果回来 → 重渲染"不会变成无限请求。
   */
  useEffect(() => {
    const missing = views
      .filter((view) => view.needsSummary && !askedRef.current.has(view.id))
      .map((view) => view.id)
    if (missing.length === 0) return

    for (const id of missing) askedRef.current.add(id)
    setSummaryBusyIds((prev) => [...prev, ...missing.filter((id) => !prev.includes(id))])

    void (async () => {
      try {
        for (let round = 0; round < MAX_SUMMARY_ROUNDS; round += 1) {
          const res = await fetch("/api/v1/messages/summaries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageIds: missing, locale: DEFAULT_SUMMARY_LOCALE }),
          })
          if (!res.ok) return

          const data = await res.json()
          const incoming: Record<string, MessageSummary> = {}
          for (const entry of data?.data?.summaries ?? []) {
            const summary = readIncomingSummary(entry)
            if (summary) incoming[entry.messageId] = summary
          }
          if (Object.keys(incoming).length > 0) {
            setLiveSummaries((prev) => ({ ...prev, ...incoming }))
          }
          // 没有剩余（都算完了，或剩下的都已被标成失败不会再问）→ 收工。
          if ((data?.meta?.remaining ?? 0) <= 0) return
        }
      } catch {
        // 网络层失败：静默（见上面的注释）。下一轮由服务端的缓存/failed 行收敛。
      } finally {
        setSummaryBusyIds((prev) => prev.filter((id) => !missing.includes(id)))
      }
    })()
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
      // 用 PATCH 返回的最新 Message 替换。**要点手动带上**：PATCH 只回消息本身
      // （单条读取不查要点表），不补回来的话这条的要点会在重渲染时凭空消失 ——
      // 虽然已处理的提案只画一行回执、看不出来，但那是"数据被悄悄抹掉"，
      // 下次谁想在这行回执上加点东西就会撞上。
      setMessages((prev) =>
        prev.map((message) =>
          message.id === id
            ? { ...(data.data as Message), summary: liveSummaries[id] ?? message.summary ?? null }
            : message,
        ),
      )
      // 通知侧栏徽标刷新（同页面不会触发路由切换，靠事件补一次）。
      window.dispatchEvent(new Event(MESSAGES_UPDATED_EVENT))
    } catch {
      setError("网络错误，请重试")
    } finally {
      setBusyId(null)
    }
  }

  async function undo(id: string) {
    setBusyUndoId(id)
    setError(null)
    try {
      const res = await fetch(`/api/v1/messages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo" }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error?.message ?? "撤销失败，请重试")
        return
      }
      // 同上：PATCH 不回要点表，要点手动带上（撤销后那行 AI 要点要重新显示）。
      setMessages((prev) =>
        prev.map((message) =>
          message.id === id
            ? { ...(data.data as Message), summary: liveSummaries[id] ?? message.summary ?? null }
            : message,
        ),
      )
      window.dispatchEvent(new Event(MESSAGES_UPDATED_EVENT))
    } catch {
      setError("网络错误，请重试")
    } finally {
      setBusyUndoId(null)
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
                  summaryBusy={summaryBusyIds.includes(view.id)}
                  onAccept={() => void decide(view.id, "accepted")}
                  onDismiss={() => void decide(view.id, "dismissed")}
                />
              ) : view.isUndone ? (
                <ProposalBubble
                  key={view.id}
                  view={view}
                  busy={busyId === view.id}
                  summaryBusy={summaryBusyIds.includes(view.id)}
                  undone
                />
              ) : (
                <ResolvedReceipt
                  key={view.id}
                  view={view}
                  busyUndo={busyUndoId === view.id}
                  onUndo={() => void undo(view.id)}
                />
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

/**
 * 校验接口回来的要点条目（客户端侧的守卫）。
 *
 * 形状不对就整条丢掉：宁可这条没有要点，也不要把 `undefined` / 对象塞进
 * `points` 让渲染层崩掉（一个坏条目会让整页白屏，而那是一条要点的问题）。
 */
function readIncomingSummary(entry: unknown): MessageSummary | null {
  if (typeof entry !== "object" || entry === null) return null
  const record = entry as Record<string, unknown>
  const rawPoints = record.points
  if (!Array.isArray(rawPoints)) return null

  const points = rawPoints.filter(
    (point): point is string => typeof point === "string" && point.trim() !== "",
  )
  return {
    points: record.status === "failed" ? [] : points,
    itemsUsed: typeof record.itemsUsed === "number" ? record.itemsUsed : 0,
    itemsTotal: typeof record.itemsTotal === "number" ? record.itemsTotal : 0,
    status: record.status === "failed" ? "failed" : "ok",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
  }
}

/** 待确认提案 = 会话里「Tempo 的发言」：左侧头像 + 气泡 + 就地操作。 */
function ProposalBubble({
  view,
  busy,
  summaryBusy,
  undone = false,
  onAccept,
  onDismiss,
}: {
  view: MessageView
  busy: boolean
  /** 正在后台生成这条的 AI 要点（只影响那一行占位文案）。 */
  summaryBusy: boolean
  /** 已撤销（P0-3-26）：只读、不显示操作按钮，改为说明已回滚。 */
  undone?: boolean
  onAccept?: () => void
  onDismiss?: () => void
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
          {/*
            课程身份色（2026-09-18 验收反馈）。原来是灰字，与「课程公告」那个灰徽标
            连在一起看不清界限 —— 消息栏里的主问题是"这是哪门课的事"，
            所以给它一个稳定的彩色徽标。
            🔴 类名来自 `courseToneClass()` 的**字面量色板**，不是运行时拼的
            （Tailwind v4 扫不到拼出来的类名，见 `lib/messages/view.ts`）。
          */}
          {view.courseLabel && (
            <span
              className={`rounded-badge px-1.5 py-0.5 text-xs font-medium ${view.courseTone ?? ""}`}
            >
              {view.courseLabel}
            </span>
          )}
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

        {/*
          AI 要点（P0-3-25b）。

          🔴 三件事必须同时成立，缺一个这个功能就变成"看起来有用、实际误导"：
          ① **标注归因**（`view.summaryLabel` = 「AI 总结」）—— 要点是模型提炼的，
             不是老师的原话。不标，用户会把 AI 的理解当原文引用；
          ② **覆盖不足要说**（`view.summaryCoverage`）—— 40 条里只总结了 20 条时
             必须写出来，否则"都总结过了"的错觉会让他漏事；
          ③ **原文入口不能少** —— 所以这段永远挨着上面的标题/正文、
             以及下面那行「原文 ↗」，绝不单独成块飘在别处。

          版面上刻意做得比正文弱（小一号、灰一档、左侧留白）：视觉层级要先读原文，
          再看要点。
        */}
        {view.summaryPoints.length > 0 && (
          <div className="mt-2 rounded-card border border-line bg-surface2/40 px-3 py-2">
            <p
              className="text-[11px] text-ink-faint"
              title="由 AI 从原文提炼，可能不完整；请以「原文」为准"
            >
              {view.summaryLabel}
              {view.summaryCoverage && ` · ${view.summaryCoverage}`}
            </p>
            <ul className="mt-1 space-y-0.5">
              {view.summaryPoints.map((point, i) => (
                <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-ink-muted">
                  <span aria-hidden className="text-ink-faint">
                    ·
                  </span>
                  <span className="min-w-0 flex-1">{point}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/*
          生成中：只在真的在请求时出现，且**只在还没有要点时**。
          它是"在算"与"没生效"的唯一区分信号（见 `summaryPendingLabel` 的注释）；
          请求一结束这行就撤 —— 成功换成上面的要点，失败什么都不留（原文照常）。
        */}
        {summaryBusy && view.summaryPoints.length === 0 && (
          <p className="mt-2 text-xs text-ink-faint">{view.summaryBusyLabel}</p>
        )}

        {/*
          合并摘要（P0-3-25 C 口径）：一轮几十条「通知类公告」在这条消息里逐条列出。
          🔴 用 `<details>` 而不是"显示前 N 条 + 更多"：用户要的是**确认没漏事**，
          所以默认收起（不占版面）、但一次点击就能看到全部 —— 而不是逼他再点第二层。
          （用户原话场景：老师发了 40 条通知，不该在消息栏变成 40 次「知道了」。）
        */}
        {view.digestItems.length > 0 && (
          <details className="mt-2 rounded-card border border-line bg-surface2/40">
            <summary className="cursor-pointer px-3 py-2 text-xs text-ink-muted hover:text-ink">
              展开全部 {view.digestItems.length} 条原文入口
              {view.digestOverflow > 0 && `（另有 ${view.digestOverflow} 条未列出）`}
            </summary>
            <ul className="max-h-72 space-y-1.5 overflow-y-auto overscroll-contain border-t border-line px-3 py-2">
              {view.digestItems.map((item, i) => (
                <li key={i} className="flex items-baseline gap-2 text-xs">
                  {item.courseLabel && (
                    <span
                      className={`shrink-0 rounded-badge px-1 py-px text-[11px] font-medium ${item.courseTone ?? ""}`}
                    >
                      {item.courseLabel}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-ink-muted">{item.title}</span>
                  {item.postedAtLabel && (
                    <span className="shrink-0 text-ink-faint">{item.postedAtLabel}</span>
                  )}
                  {item.sourceUrl && (
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      原文 ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="mt-2 text-xs text-ink-faint">
          {view.timeLabel}
          {view.sourceUrl && (
            <>
              {" · "}
              {/*
                「原文」= 公告的证据链。正文在同步时被剥成了纯文本（防 stored XSS），
                表格 / 图片 / 附件只有点进来才看得到 —— 没有这个链接，
                用户就只能凭我们摘要过的几行做判断。
                `noopener noreferrer` 不能省：新窗口打开外部页面时不带 referrer、
                也不给对面 `window.opener` 的句柄。
              */}
              <a
                href={view.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                原文 ↗
              </a>
            </>
          )}
        </p>

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
          {undone ? (
            <span className="ml-auto text-xs text-ink-muted">
              已撤销 · 写入的内容已回滚
            </span>
          ) : (
            <>
              {!view.canAccept && view.blockReason && (
                <span className="mr-auto max-w-[60%] text-xs text-ink-muted" title={view.blockReason}>
                  {view.blockReason}
                </span>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={onDismiss}>
                忽略
              </Button>
              {/* 文案来自 `toMessageView`：无落点的公告是「知道了」—— 它确实什么都不会写。 */}
              <Button size="sm" disabled={busy || !view.canAccept} onClick={onAccept}>
                {view.confirmLabel}
              </Button>
            </>
          )}
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
 *
 * P0-3-26：确认的那行多显示**回执**（写了什么）+ 「原文 ↗」+ 24h 内的「撤销」。
 * 撤销按钮的可见性在**挂载后**才算（用 `mounted` 闸门），避免服务端/客户端
 * 因 `now` 不同出现 hydration mismatch —— 首屏两者都看不到按钮，挂载后客户端再补。
 */
function ResolvedReceipt({
  view,
  busyUndo,
  onUndo,
}: {
  view: MessageView
  busyUndo: boolean
  onUndo: () => void
}) {
  const accepted = view.status === "accepted"

  /**
   * 撤销按钮的可见性只在**挂载后**才算（`now` 来自客户端，且 `Date.now()` 不进 render）。
   * 首屏（SSR 与首次客户端渲染）一律看不到按钮 → 与服务端输出一致，无 hydration mismatch；
   * 挂载后客户端补算 24h 窗口，该显示的才显示。
   * `react-hooks/set-state-in-effect` 对本处的豁免：这是 client-only 闸门的标准写法，
   * 初始值 false 已与服务端一致，effect 里的 setState 不会造成"两帧不一致"。
   */
  const [canUndo, setCanUndo] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanUndo(
      accepted &&
        view.appliedCount > 0 &&
        view.decidedAt != null &&
        Date.now() - new Date(view.decidedAt).getTime() <= UNDO_WINDOW_MS,
    )
  }, [accepted, view.appliedCount, view.decidedAt])

  return (
    <div className={`flex flex-col gap-1 pr-1 text-xs text-ink-faint ${RECEIPT_INDENT}`}>
      <div className="flex items-baseline gap-2">
        <span className={accepted ? "shrink-0 text-green" : "shrink-0"}>
          {accepted ? "✓ 已确认" : "— 已忽略"}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-muted">{view.title}</span>
        <span className="shrink-0 tabular-nums">{view.timeLabel}</span>
      </div>
      {view.receiptText && <p className="text-ink-muted">{view.receiptText}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {view.sourceUrl && (
          <a
            href={view.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            原文 ↗
          </a>
        )}
        {canUndo && (
          <button
            type="button"
            onClick={onUndo}
            disabled={busyUndo}
            className="text-destructive underline decoration-dotted underline-offset-2 hover:opacity-80 disabled:opacity-50"
          >
            {busyUndo ? "撤销中…" : "撤销"}
          </button>
        )}
        {!canUndo && accepted && view.appliedCount > 0 && (
          <span className="text-ink-faint">已超 24 小时撤销窗口</span>
        )}
      </div>
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
