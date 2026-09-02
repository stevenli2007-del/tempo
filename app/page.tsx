import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
      <h1 className="text-4xl font-bold tracking-tight">Tempo</h1>
      <p className="text-lg text-muted-foreground">Course OS — 你的课程操作系统</p>
      <p className="text-sm text-muted-foreground">Phase 0 · 脚手架已就绪</p>

      <div className="mt-4 flex items-center gap-3">
        <Link href="/login" className={buttonVariants({ variant: 'default', size: 'lg' })}>
          登录
        </Link>
        <Link href="/signup" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
          注册
        </Link>
      </div>
    </main>
  )
}
