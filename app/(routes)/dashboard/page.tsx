import { redirect } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { signOut } from '@/lib/auth/actions'
import { createClient } from '@/lib/supabase/server'

export const metadata = {
  title: '总览 · Tempo',
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // middleware 已经拦过一道，这里再兜一次底：既防 middleware 被人绕过，
  // 也让 TS 知道 user 一定存在。
  if (!user) {
    redirect('/login')
  }

  const email = user.email ?? '（未设置邮箱）'

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold">Tempo</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{email}</span>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                登出
              </Button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">总览</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          P0-0-3 认证已跑通。这里将来是总览页（P0-1-9）：课程卡片 + 跨课程近期任务。
        </p>
        <dl className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <dt className="text-xs text-muted-foreground">用户 ID</dt>
            <dd className="mt-1 font-mono text-xs break-all">{user.id}</dd>
          </div>
          <div className="rounded-lg border border-border p-4">
            <dt className="text-xs text-muted-foreground">上次登录</dt>
            <dd className="mt-1 text-sm">
              {user.last_sign_in_at
                ? new Date(user.last_sign_in_at).toLocaleString('zh-CN')
                : '—'}
            </dd>
          </div>
        </dl>
      </div>
    </main>
  )
}
