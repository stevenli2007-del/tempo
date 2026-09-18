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
 *
 * ### 版面：会话式（2026-09-17 验收修正）
 * 页面不再是"文档流里排一列卡片"，而是**整块占满视口**：中间消息流独占滚动、底部输入区常驻。
 * 所以这里要收掉 `AppShell` 默认的 `pt-10 / pb-[70px]`，并按「顶栏 76px + 上内边距 24px」
 * 把高度算死 —— 算式与上面的 `pt-6` 是一对，**改一起改**（不然会出现双滚动条或底部被切）。
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
    <AppShell title="消息栏" className="pb-0 pt-6">
      {/* 高度 = 100dvh − 顶栏(76px) − main 上内边距(24px)。 */}
      <div className="h-[calc(100dvh-100px)]">
        {error ? (
          <div
            role="alert"
            className="mx-auto max-w-[820px] rounded-card border border-destructive/40 bg-card p-4"
          >
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
