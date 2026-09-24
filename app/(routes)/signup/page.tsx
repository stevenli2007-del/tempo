import { AuthForm } from '@/components/auth/auth-form'
import { BuildSignature } from '@/components/auth/build-signature'
import { LanguageToggle } from '@/components/i18n/language-toggle'
import { getLang } from '@/lib/i18n/server'
import { t } from '@/lib/i18n/translate'

export async function generateMetadata() {
  const lang = await getLang()
  return { title: t(lang, 'auth.signupMeta') }
}

export default async function SignupPage() {
  return (
    // 与登录页同一套结构（P0-3-33）：署名在表单正下方；语言切换挂右上角（P0-5-1）。
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <div className="fixed right-6 top-6 z-50">
        <LanguageToggle />
      </div>
      <AuthForm mode="signup" />
      <BuildSignature />
    </main>
  )
}
