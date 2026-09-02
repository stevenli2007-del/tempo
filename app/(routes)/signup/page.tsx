import { AuthForm } from '@/components/auth/auth-form'

export const metadata = {
  title: '注册 · Tempo',
}

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <AuthForm mode="signup" />
    </main>
  )
}
