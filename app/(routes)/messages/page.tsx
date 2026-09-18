import { redirect } from "next/navigation"

import { AppShell } from "@/components/shell/app-shell"
import { MessagesView } from "@/components/messages/messages-view"
import { createClient } from "@/lib/supabase/server"
import { loadMessages } from "@/lib/messages"
import { toMessageView } from "@/lib/messages/view"
import type { MessageView } from "@/lib/messages/view"

export const metadata = {
  title: "消息栏 · Tempo",
}

// 依赖用户 session，绝不能被静态预渲染（同 /dashboard、/courses）。
export const dynamic = "force-dynamic"

/**
 * 消息栏（P0-3-18）。
 *
 * **这是全站系统提案的唯一出口**（3-19 / 3-20 / 3-23 都往 `messages` 发，不再各自做 UI）。
 *
 * 服务端只负责：鉴权 + 拉当前用户的提案列表（RLS 按 `user_id` 收口，用用户级客户端）。
 * 渲染与交互（确认 / 忽略、内嵌的「告诉 Tempo 一个 Update」流程）交给客户端
 * `MessagesView` —— 它接收服务端预取的 `initialViews`，避免首屏空白与 hydration mismatch。
 */
export default async function MessagesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy 已经拦过一道，这里再兜一次底。
  if (!user) {
    redirect("/login")
  }

  const { messages, error } = await loadMessages(supabase)
  const initialViews: MessageView[] = messages.map(toMessageView)

  return (
    <AppShell title="消息栏">
      <div className="mx-auto max-w-[820px] space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">消息栏</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Tempo 在这里跟你确认它发现的变化 —— 确认才生效，忽略就当作没发生。
          </p>
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">提案加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
        ) : (
          <MessagesView initialViews={initialViews} />
        )}
      </div>
    </AppShell>
  )
}
