'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { readApiErrorMessage } from '@/lib/api/client-error'

/**
 * 设置页的危险操作区（P0-3-2，PRD F6）。
 *
 * 三个动作**后果完全不同**，所以是三个独立按钮而不是一个「清空数据」：
 *
 * | 动作 | 删什么 | 留什么 |
 * |---|---|---|
 * | 断开 Canvas 连接 | 已保存的 token | 课程、syllabus、已导入的作业、课程关联 |
 * | 清除 Canvas 数据 | token + 从 Canvas 导入的作业任务 | 课程、syllabus、手动任务、课程关联 |
 * | 删除账号 | 一切（含 Storage 文件与登录账号） | 无 |
 *
 * 前两个可重来（重新粘贴 token 就恢复），所以只要一次二次确认；
 * 删账号不可恢复，额外要求**输入自己的邮箱**才启用按钮 ——
 * 点错一下和输错一串字符是两种量级的误操作成本。
 *
 * 「断开连接」复用 P0-2-9 已验收的 `DELETE /api/v1/canvas/credentials`，
 * 不新造一个语义相同的端点。
 */
export function DangerZone({ email, hasCredential }: { email: string; hasCredential: boolean }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState<'revoke' | 'purge' | 'account' | null>(null)
  const [pending, setPending] = useState<'revoke' | 'purge' | 'account' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 删账号的确认输入框。必须与邮箱完全一致才启用按钮。 */
  const [typedEmail, setTypedEmail] = useState('')

  async function run(action: 'revoke' | 'purge' | 'account') {
    setError(null)
    setPending(action)
    try {
      const url =
        action === 'revoke'
          ? '/api/v1/canvas/credentials'
          : action === 'purge'
            ? '/api/v1/account/data?scope=canvas'
            : '/api/v1/account'
      const response = await fetch(url, { method: 'DELETE' })

      if (!response.ok) {
        // 404 = 没有凭据 / 已撤销过（端点幂等）。想达到的状态本来就成立，刷新即可。
        if (action === 'revoke' && response.status === 404) {
          setConfirming(null)
          router.refresh()
          return
        }
        setError(await readApiErrorMessage(response, ACTION_LABELS[action]))
        return
      }

      if (action === 'account') {
        // 账号已经没了，这个页面上的任何 router.refresh() 都只会拿到 401。
        // 直接送回登录页。
        router.push('/login')
        return
      }

      setConfirming(null)
      router.refresh()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">危险操作</h2>

      <div className="divide-y divide-border rounded-lg border border-destructive/40">
        {/* ---------- 1. 断开 Canvas 连接 ---------- */}
        <Row
          title="断开 Canvas 连接"
          description="删除已保存的访问令牌，所有课程停止同步。课程、syllabus 和已导入的作业都会保留 —— 重新粘贴一个 token 即可继续。"
          actionLabel="断开连接"
          disabled={!hasCredential || pending !== null}
          pending={pending === 'revoke'}
          pendingLabel="断开中…"
          disabledHint={hasCredential ? null : '还没有连接 Canvas'}
          onConfirm={() => {
            setError(null)
            setConfirming('revoke')
          }}
        />
        {confirming === 'revoke' ? (
          <Confirm
            text="删除已保存的 Canvas 访问令牌？所有课程会停止同步。"
            confirmLabel="确认断开"
            pending={pending !== null}
            onConfirm={() => void run('revoke')}
            onCancel={() => setConfirming(null)}
          />
        ) : null}

        {/* ---------- 2. 清除 Canvas 数据 ---------- */}
        <Row
          title="清除 Canvas 数据"
          description="在断开连接的基础上，同时删除从 Canvas 导入的作业任务。syllabus 与手动任务不受影响；重新连接后一同步，任务会回来。"
          actionLabel="清除 Canvas 数据"
          disabled={!hasCredential || pending !== null}
          pending={pending === 'purge'}
          pendingLabel="清除中…"
          disabledHint={hasCredential ? null : '还没有连接 Canvas'}
          onConfirm={() => {
            setError(null)
            setConfirming('purge')
          }}
        />
        {confirming === 'purge' ? (
          <Confirm
            text="删除 Canvas 访问令牌，并删除从 Canvas 导入的全部作业任务？"
            confirmLabel="确认清除"
            pending={pending !== null}
            onConfirm={() => void run('purge')}
            onCancel={() => setConfirming(null)}
          />
        ) : null}

        {/* ---------- 3. 删除账号 ---------- */}
        <Row
          title="删除账号及全部数据"
          description="课程、syllabus 文件、任务、Canvas 凭据、使用记录与登录账号全部删除，且无法恢复。"
          actionLabel="删除账号"
          disabled={pending !== null}
          pending={pending === 'account'}
          pendingLabel="删除中…"
          disabledHint={null}
          onConfirm={() => {
            setError(null)
            setTypedEmail('')
            setConfirming('account')
          }}
        />
        {confirming === 'account' ? (
          <div className="bg-muted/40 p-3">
            <p className="text-sm text-foreground">
              这会删除 <span className="font-medium">{email}</span> 的全部数据并注销账号，无法撤销。
            </p>
            <label className="mt-2 block text-xs text-muted-foreground">
              输入邮箱确认：
              <input
                type="email"
                value={typedEmail}
                onChange={(event) => setTypedEmail(event.target.value)}
                placeholder={email}
                autoComplete="off"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              />
            </label>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void run('account')}
                disabled={typedEmail.trim() !== email || pending !== null}
                className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
              >
                {pending === 'account' ? '删除中…' : '确认删除账号'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={pending !== null}
                className="h-8 rounded-md px-3 text-xs text-muted-foreground"
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

const ACTION_LABELS: Record<'revoke' | 'purge' | 'account', string> = {
  revoke: '断开 Canvas 连接',
  purge: '清除 Canvas 数据',
  account: '删除账号',
}

function Row({
  title,
  description,
  actionLabel,
  disabled,
  pending,
  pendingLabel,
  disabledHint,
  onConfirm,
}: {
  title: string
  description: string
  actionLabel: string
  disabled: boolean
  pending: boolean
  pendingLabel: string
  /** 按钮被禁用时补一句原因（例如「还没有连接 Canvas」），避免用户猜。 */
  disabledHint: string | null
  onConfirm: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        {disabled && disabledHint ? (
          <p className="mt-1 text-xs text-muted-foreground">{disabledHint}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        className="h-8 shrink-0 rounded-md border border-destructive/40 px-3 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        {pending ? pendingLabel : actionLabel}
      </button>
    </div>
  )
}

function Confirm({
  text,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  text: string
  confirmLabel: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="bg-muted/40 p-3">
      <p className="text-sm text-foreground">{text}</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="h-8 rounded-md px-3 text-xs text-muted-foreground"
        >
          取消
        </button>
      </div>
    </div>
  )
}
