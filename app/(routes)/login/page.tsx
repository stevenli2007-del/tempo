import { AuthForm } from '@/components/auth/auth-form'
import { BuildSignature } from '@/components/auth/build-signature'

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
    // `flex-col` + `gap-6`：署名（P0-3-33）落在表单正下方，与表单作为一个整体居中，
    // 而不是贴到页面底部 —— 屏幕很高时居中的表单下方漂着一行小字会很脱节。
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <AuthForm
        mode="login"
        initialMessage={failed ? '登录状态已失效，请重新登录。' : null}
      />
      <BuildSignature />
    </main>
  )
}
