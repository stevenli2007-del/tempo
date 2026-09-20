import { AuthForm } from '@/components/auth/auth-form'
import { BuildSignature } from '@/components/auth/build-signature'

export const metadata = {
  title: '注册 · Tempo',
}

export default function SignupPage() {
  return (
    // 与登录页同一套结构（P0-3-33）：署名在表单正下方。
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <AuthForm mode="signup" />
      <BuildSignature />
    </main>
  )
}
