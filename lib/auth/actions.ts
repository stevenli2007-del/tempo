'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import type { AuthFormState } from '@/types/auth'

/**
 * Supabase 返回的错误是英文原文，直接甩给用户很粗糙。
 * 这里只映射 Phase 0 真正会遇到的几条，其余原样返回 —— 宁可露英文，
 * 也不要把未知错误翻译成一句误导人的中文。
 */
const ERROR_MESSAGES: Record<string, string> = {
  'Invalid login credentials': '邮箱或密码不正确',
  'Email not confirmed': '邮箱尚未完成验证，请检查收件箱里的确认邮件',
  'User already registered': '这个邮箱已经注册过了，直接登录吧',
  'Password should be at least 6 characters': '密码至少需要 6 位',
  'Unable to validate email address: invalid format': '邮箱格式不正确',
  'Email rate limit exceeded': '邮件发送太频繁了，请稍后再试',
  'For security purposes, you can only request this after a certain amount of time':
    '操作太频繁了，请稍后再试',
}

function toUserMessage(message: string): string {
  return ERROR_MESSAGES[message] ?? message
}

function readCredentials(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  return { email, password }
}

export async function signIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const { email, password } = readCredentials(formData)

  if (!email || !password) {
    return { error: '请填写邮箱和密码', message: null }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    return { error: toUserMessage(error.message), message: null }
  }

  // redirect 会抛 NEXT_REDIRECT，必须放在 try/catch 之外，否则会被当成错误吞掉。
  redirect('/dashboard')
}

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const { email, password } = readCredentials(formData)

  if (!email || !password) {
    return { error: '请填写邮箱和密码', message: null }
  }

  if (password.length < 6) {
    return { error: '密码至少需要 6 位', message: null }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({ email, password })

  if (error) {
    return { error: toUserMessage(error.message), message: null }
  }

  // 邮箱验证开启时 signUp 不会返回 session，用户得先点确认邮件。
  // Phase 0 关掉了验证，正常情况下会直接走到下面的 redirect。
  if (!data.session) {
    return {
      error: null,
      message: '注册成功，请先到邮箱点击确认链接，然后回来登录。',
    }
  }

  redirect('/dashboard')
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
