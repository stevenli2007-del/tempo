/**
 * 认证表单的状态类型。
 *
 * 供 Server Action（`lib/auth/actions.ts`）与客户端表单（`components/auth/auth-form.tsx`）
 * 共享。放在 types/ 而不是 actions 文件里，是因为 `'use server'` 文件只允许导出
 * 异步函数，不允许导出常量或对象。
 */

export type AuthFormState = {
  /** 错误提示（红色）。为 null 表示无错误。 */
  error: string | null
  /** 中性/成功提示（如"注册成功，请去邮箱确认"）。为 null 表示无提示。 */
  message: string | null
}
