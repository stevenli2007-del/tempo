'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/use-i18n'
import { signIn, signUp } from '@/lib/auth/actions'
import type { AuthFormState } from '@/types/auth'

interface AuthFormProps {
  /** login = 登录页，signup = 注册页。两者共用同一份表单，只有文案和行为不同。 */
  mode: 'login' | 'signup'
  /** 页面级提示，例如从邮箱确认回调跳回登录页时的说明。 */
  initialMessage?: string | null
}

const INPUT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

export function AuthForm({ mode, initialMessage = null }: AuthFormProps) {
  const isSignUp = mode === 'signup'
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    isSignUp ? signUp : signIn,
    { error: null, message: initialMessage },
  )
  const t = useT()

  const title = isSignUp ? t('auth.signupTitle') : t('auth.loginTitle')
  const subtitle = isSignUp ? t('auth.signupSubtitle') : t('auth.loginSubtitle')
  const submitLabel = isSignUp ? t('auth.submitSignup') : t('auth.submitLogin')

  return (
    <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-6 space-y-1">
        <h1 className="text-xl font-semibold text-card-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>

      <form action={formAction} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-foreground">
            {t('auth.email')}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder={t('auth.emailPlaceholder')}
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-foreground">
            {t('auth.password')}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            placeholder={t('auth.passwordPlaceholder')}
            className={INPUT_CLASS}
          />
        </div>

        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}

        {state.message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.message}
          </p>
        ) : null}

        <Button type="submit" disabled={isPending} className="h-9 w-full">
          {isPending ? t('auth.processing') : submitLabel}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {isSignUp ? t('auth.hasAccount') : t('auth.noAccount')}{' '}
        <Link
          href={isSignUp ? '/login' : '/signup'}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {isSignUp ? t('auth.goLogin') : t('auth.goSignup')}
        </Link>
      </p>
    </div>
  )
}
