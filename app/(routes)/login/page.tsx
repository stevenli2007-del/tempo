import { AuthForm } from '@/components/auth/auth-form'

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export const metadata = {
  title: '登录 · Tempo',
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // 邮箱确认回调失败时会带 ?error=auth 跳回来，这里给出人话提示。
  const failed = (await searchParams).error !== undefined

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <AuthForm
        mode="login"
        initialMessage={failed ? '登录状态已失效，请重新登录。' : null}
      />
    </main>
  )
}
