import { AuthForm } from '@/components/auth/auth-form'
import { BuildSignature } from '@/components/auth/build-signature'
import { LanguageToggle } from '@/components/i18n/language-toggle'
import { getLang } from '@/lib/i18n/server'
import { t } from '@/lib/i18n/translate'

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata() {
  const lang = await getLang()
  return { title: t(lang, 'auth.loginMeta') }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // 邮箱确认回调失败时会带 ?error=auth 跳回来，这里给出人话提示。
  const failed = (await searchParams).error !== undefined
  const lang = await getLang()

  return (
    // `flex-col` + `gap-6`：署名（P0-3-33）落在表单正下方，与表单作为一个整体居中，
    // 而不是贴到页面底部 —— 屏幕很高时居中的表单下方漂着一行小字会很脱节。
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      {/* login / signup 没有 topbar，语言切换自己挂右上角（P0-5-1） */}
      <div className="fixed right-6 top-6 z-50">
        <LanguageToggle />
      </div>
      <AuthForm
        mode="login"
        initialMessage={failed ? t(lang, 'auth.sessionExpired') : null}
      />
      <BuildSignature />
    </main>
  )
}
