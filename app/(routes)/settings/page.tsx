import Link from 'next/link'
import { redirect } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { DangerZone } from '@/components/settings/danger-zone'
import { loadDataSummary } from '@/lib/account/data-summary'
import { signOut } from '@/lib/auth/actions'
import { createClient } from '@/lib/supabase/server'

export const metadata = {
  title: '设置 · Tempo',
}

// 依赖用户 session，绝不能被静态预渲染（与 dashboard 同理）。
export const dynamic = 'force-dynamic'

/**
 * 服务端算好日期串，不让客户端组件再各算一遍（hydration mismatch 的
 * 经典来源）。时区固定 UTC，与总览页保持一致。
 */
const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
})

/**
 * 设置与隐私页（P0-3-2，PRD F6）。
 *
 * 三件事按用户关心的顺序排：**我有什么数据 → 这些数据去哪了 → 怎么删掉**。
 * 隐私说明刻意写成"能一口气读完"的长度 —— 写成长篇免责声明等于没人读，
 * 那还不如不写（Security-Privacy A12 要的是"明确告知"，不是"法务覆盖"）。
 */
export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const email = user.email ?? '（未设置邮箱）'
  const summary = await loadDataSummary(supabase, user.id)

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold">Tempo · 设置</span>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
              返回总览
            </Link>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                登出
              </Button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-10 px-6 py-10">
        <section className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">设置与隐私</h1>
          <p className="text-sm text-muted-foreground">登录邮箱：{email}</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">我们存了什么</h2>
          <div className="rounded-lg border border-border">
            <dl className="divide-y divide-border">
              <Item
                label="课程"
                value={`${summary.courses} 门`}
                hint={
                  summary.archivedCourses > 0 ? `另有 ${summary.archivedCourses} 门已归档` : null
                }
              />
              <Item label="Syllabus 文件" value={`${summary.syllabi} 份`} hint={null} />
              <Item
                label="任务"
                value={`${summary.tasks} 条`}
                hint="含 syllabus 解析出的考试与从 Canvas 导入的作业"
              />
              <Item
                label="Canvas 连接"
                value={summary.canvas.connected ? '已连接' : '未连接'}
                hint={
                  summary.canvas.expiresAt === null
                    ? null
                    : `令牌 ${DATE_FORMATTER.format(new Date(summary.canvas.expiresAt))} 过期 · 已关联 ${summary.canvas.linkedCourses} 门课`
                }
              />
            </dl>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">隐私说明</h2>
          <div className="space-y-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
            <p>
              <span className="text-foreground">存在哪</span>
              ：课程与任务存在 Supabase 托管的数据库里；syllabus 原件存在私有文件桶，只有你能下载；
              Canvas 访问令牌加密后存储（AES-256-GCM），服务端不保存明文。
            </p>
            <p>
              <span className="text-foreground">会发出去什么</span>
              ：你上传的 syllabus 文本会发送给 AI 服务商（当前为 DeepSeek）做解析 —— 这是 Phase 0
              唯一会离开我们数据库的数据流。课程名、日期这类结构化结果不会发送。⚠️
              该服务商的服务器不在美国境内，正式对外发布前会重新评估（开放问题 O-08）。
            </p>
            <p>
              <span className="text-foreground">不会做什么</span>
              ：不出售、不用于广告；不读取你的成绩与花名册（从 Canvas 只取作业与截止日期）；
              Phase 0 没有接入任何第三方分析与追踪。
            </p>
            <p>
              想把这些一次性清掉，用下面的「删除账号及全部数据」。
            </p>
          </div>
        </section>

        <DangerZone email={email} hasCredential={summary.canvas.status !== null && summary.canvas.status !== 'revoked'} />
      </div>
    </main>
  )
}

function Item({ label, value, hint }: { label: string; value: string; hint: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="text-sm text-foreground">{label}</dt>
      <dd className="text-right">
        <span className="text-sm font-medium text-foreground">{value}</span>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </dd>
    </div>
  )
}
