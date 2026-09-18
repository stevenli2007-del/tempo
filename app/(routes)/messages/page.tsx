import { redirect } from "next/navigation"

import { AppShell } from "@/components/shell/app-shell"
import { MessagesView } from "@/components/messages/messages-view"
import type { CourseOption } from "@/components/tasks/use-course-update-flow"
import { COURSE_COLUMNS, toCourse } from "@/lib/courses"
import type { CourseRow } from "@/lib/courses"
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

  const [{ messages, error }, coursesResult] = await Promise.all([
    loadMessages(supabase),
    supabase
      .from('courses')
      .select(COURSE_COLUMNS)
      .eq('is_archived', false)
      .order('created_at', { ascending: true }),
  ])
  const initialViews: MessageView[] = messages.map(toMessageView)

  /**
   * 课程下拉项**必须**在服务端一起下发。
   *
   * 整页的输入区是常驻的 —— 与浮窗不同，这里没有"点开"这个动作去触发客户端
   * `loadCourses()`。不预取的话 `courses` 恒为 `[]`，课程下拉里只剩占位项，
   * 用户点开是空的（2026-09-17 验收实测：「选择课程」选不了）。
   *
   * 列名的翻译只经 `toCourse()` 一处（`lib/courses.ts` 是唯一知道 snake_case 的地方）。
   */
  const initialCourses: CourseOption[] = ((coursesResult.data ?? []) as CourseRow[])
    .map(toCourse)
    .map((course) => ({ id: course.id, courseName: course.courseName }))

  // 课程查询失败时明说：否则底部的下拉会显示成「还没有课程」—— 把失败伪装成空数据
  // （CodingRules 7；`/courses` 页对同一件事的处理也一样）。
  const coursesError = coursesResult.error

  return (
    <AppShell title="消息栏" className="pb-0 pt-6">
      {/* 高度 = 100dvh − 顶栏(76px) − main 上内边距(24px)。 */}
      <div className="flex h-[calc(100dvh-100px)] flex-col">
        {coursesError ? (
          <div
            role="alert"
            className="mb-3 shrink-0 rounded-card border border-destructive/40 bg-card p-3"
          >
            <p className="text-sm font-medium text-destructive">课程列表加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              提案列表不受影响，但底部「告诉 Tempo 一个 Update」的课程下拉可能为空。
              {coursesError.message}
            </p>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="mx-auto max-w-[820px] rounded-card border border-destructive/40 bg-card p-4"
          >
            <p className="text-sm font-medium text-destructive">提案加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
        ) : (
          <MessagesView initialViews={initialViews} initialCourses={initialCourses} />
        )}
      </div>
    </AppShell>
  )
}
