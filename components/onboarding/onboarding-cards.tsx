'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { FEEDBACK_URL } from '@/lib/constants'
import { readInternalPath } from '@/lib/internal-path'
import {
  getOnboardingSteps,
  ONBOARDING_COOKIE,
  ONBOARDING_COOKIE_MAX_AGE,
  onboardingCookieValue,
} from '@/lib/onboarding/content'
import { readSafeUrl } from '@/lib/safe-url'
import { useI18n } from '@/lib/i18n/use-i18n'
import { cn } from '@/lib/utils'

interface OnboardingCardsProps {
  /** 当前登录用户 id —— 写进 cookie 值，标记天然按用户分。 */
  userId: string
  /** 站内那一步的目标（服务端算好：第一门课详情页，没有课则 `/courses`）。 */
  connectHref: string
  /** 服务端判定：要不要渲染（`replay || !hasSeen`）。 */
  initialOpen: boolean
  /** 是否来自「重看教程」入口（`/dashboard?tutorial=1`）—— 只用来关闭时清掉 URL。 */
  replay: boolean
}

/**
 * 新手引导卡片组（P0-3-32）。
 *
 * ### 谁来控制显隐
 * **服务端**：`dashboard/page.tsx` 读 cookie 算出 `initialOpen`；
 * 本组件只负责"用户点了跳过/开始使用之后立刻收起来"，并把标记写回 cookie。
 * 这样首屏 HTML 里就有引导（不会闪），也不需要 `useEffect` + `setState`
 * —— 后者会撞上本仓 `react-hooks/set-state-in-effect` 这条 eslint 规则。
 *
 * ### 🔴 不挡冷启动
 * 引导卡渲染在页面**同一条流**里（不是覆盖层），Demo Workspace 的
 * 「✨ 先看看效果」就在它下面 —— 两者同屏可见，谁也不挤掉谁（卡面约束 ③）。
 *
 * ### 🔴 每一步的链接都过守卫
 * 外链走 `readSafeUrl()`（只放行 http(s)），站内路径走 `readInternalPath()`
 * （只放行单个 `/` 开头的路径，`//host` 会被拒）。常量写死也不省这一步：
 * 守卫只有一份、判据只有一处，将来换常量的人不必记得"这里其实是安全的"。
 * 守卫判 null 时**不渲染那个链接**，而不是画一个假链接。
 */
export function OnboardingCards({
  userId,
  connectHref,
  initialOpen,
  replay,
}: OnboardingCardsProps) {
  const router = useRouter()
  const { lang, t } = useI18n()
  const [index, setIndex] = useState(0)
  // 翻页方向只用来决定动画从哪边进来，不影响任何业务判定。
  const [forward, setForward] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  if (!initialOpen || dismissed) return null

  // P0-5-1：步骤内容按语言取（id / 外链 / 媒体路径与 zh 完全一致，只换文案）。
  const steps = getOnboardingSteps(lang)
  const total = steps.length
  const step = steps[index]
  const media = step.media
  const isLast = index === total - 1

  const externalHref = step.external === null ? null : readSafeUrl(step.external.url)
  const internalHref = step.internal === 'connect' ? readInternalPath(connectHref) : null
  const feedbackHref = readSafeUrl(FEEDBACK_URL)

  function goTo(next: number) {
    if (next < 0 || next >= total) return
    setForward(next > index)
    setIndex(next)
  }

  function dismiss() {
    // 标记写失败也不影响本次收起（最坏情况是下次登录再看一遍，不是报错）。
    try {
      document.cookie = `${ONBOARDING_COOKIE}=${onboardingCookieValue(userId)}; path=/; max-age=${ONBOARDING_COOKIE_MAX_AGE}; samesite=lax`
    } catch {
      /* 忽略：cookie 被禁用时引导仍应能关掉 */
    }
    setDismissed(true)
    // 从「重看教程」进来的话，把 `?tutorial=1` 从地址栏清掉，
    // 否则刷新一次又弹出来（那不是 bug 但是噪音）。
    if (replay) router.replace('/dashboard')
  }

  return (
    <section
      aria-label={t('onboarding.title')}
      data-onboarding="cards"
      className="rounded-card border border-line bg-card p-6 shadow-card"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') goTo(index + 1)
        if (event.key === 'ArrowLeft') goTo(index - 1)
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs font-medium text-ink-muted">
          {t('onboarding.title')}
          <span className="ml-2 font-normal text-ink-faint">
            {index + 1} / {total}
          </span>
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex items-center gap-1 rounded-button px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" aria-hidden />
          {t('onboarding.skip')}
        </button>
      </div>

      {/* `key={step.id}`：换一张卡就重挂载，入场动画才会重新播一次
          （React 官方「用 key 重置状态」的同一手法）。 */}
      <div
        key={step.id}
        className={cn(
          'mt-4 space-y-3',
          'duration-300 animate-in fade-in',
          forward ? 'slide-in-from-right-3' : 'slide-in-from-left-3'
        )}
      >
        <h2 className="text-lg font-semibold tracking-tight text-ink">{step.title}</h2>
        <p className="text-sm text-ink-muted">{step.lead}</p>

        {/* 有动图时宽屏走两列（文字左、动图右）—— 目的是让卡片**高度基本不变**，
            下面的「✨ 先看看效果」仍然留在首屏（卡面约束 ③：不许挡住冷启动）。
            窄屏退回单列（`order-first` 让动图先出现），卡片变高是必然的，
            所以动图**不做限高裁切** —— 裁掉的是画面中间那块对话框，正好是最该看的部分。 */}
        <div className={cn(media !== null && 'lg:flex lg:items-start lg:gap-6')}>
          {media === null ? null : (
            <figure className="order-first mb-3 lg:order-last lg:mb-0 lg:w-[46%] lg:shrink-0">
              {/* 🔴 autoplay 的三个前提缺一不可：`muted`（不静音浏览器直接拒播）、
                  `playsInline`（iOS 上否则强制全屏）、`loop`（这只是个循环演示）。
                  `aria-hidden` 是因为视频对读屏软件没有意义 —— 语义由下面那行
                  figcaption 承担（它也顺带兜住「不播视频也看得懂」）。 */}
              <video
                src={media.src}
                poster={media.poster}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden
                tabIndex={-1}
                className="w-full rounded-card border border-line bg-muted motion-reduce:hidden"
              />
              {/* 「减弱动态效果」下的替代品：同一张首帧，纯 CSS 切换。
                  刻意不读 `matchMedia` —— 那要 `setState` 于 effect（撞本仓
                  `react-hooks/set-state-in-effect`），且 SSR 会 hydration 不匹配。 */}
              {/* 这里刻意不用 `next/image`：它是 `public/` 里已经压好的静态 webp
                  （24–41KB），优化器没有收益；而且它必须在「减弱动态效果」下
                  **不依赖 JS** 就显示出来 —— 普通 `<img>` 正好。 */}
              {/* eslint-disable-next-line @next/next/no-img-element -- 理由同上 */}
              <img
                src={media.poster}
                alt=""
                aria-hidden
                className="hidden w-full rounded-card border border-line motion-reduce:block"
              />
              <figcaption className="mt-2 text-xs text-ink-faint">{media.caption}</figcaption>
            </figure>
          )}

          <div className={cn('space-y-3', media !== null && 'min-w-0 lg:flex-1')}>
            {step.points.length > 0 ? (
              <ul className="space-y-1.5 pl-1">
                {step.points.map((point) => (
                  <li key={point} className="flex gap-2 text-sm text-ink-muted">
                    <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-faint" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {step.external !== null && externalHref !== null ? (
                <a
                  href={externalHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-button border border-line bg-background px-3 text-sm font-medium text-ink transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {step.external.label}
                  <ExternalLink className="size-3.5" aria-hidden />
                  <span className="sr-only">{t('onboarding.srNewTab')}</span>
                </a>
              ) : null}

              {internalHref !== null ? (
                <Link
                  href={internalHref}
                  className="inline-flex h-8 items-center gap-1.5 rounded-button bg-lime px-3 text-sm font-medium text-on-lime transition-colors hover:bg-lime/80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {connectHref === '/courses' ? t('onboarding.myCourses') : t('onboarding.openCourse')}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null}
            </div>

            {isLast && feedbackHref !== null ? (
              <p className="pt-2 text-xs text-ink-faint">
                {t('onboarding.stuck')}{' '}
                <a
                  href={feedbackHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent-blue underline-offset-4 hover:underline"
                >
                  {t('onboarding.tellUs')}
                </a>
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between gap-4 border-t border-line pt-4">
        {/* 进度点：可点直接跳步（验收标准 ①「点步进入下一张」）。 */}
        <div className="flex items-center gap-1.5">
          {steps.map((item, i) => (
            <button
              key={item.id}
              type="button"
              aria-current={i === index ? 'step' : undefined}
              aria-label={t('onboarding.stepAria', { n: i + 1, title: item.title })}
              onClick={() => goTo(i)}
              className={cn(
                'h-1.5 rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                i === index ? 'w-6 bg-lime-dark' : 'w-1.5 bg-line hover:bg-ink-faint'
              )}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={index === 0}
            onClick={() => goTo(index - 1)}
          >
            <ArrowLeft aria-hidden />
            {t('onboarding.prev')}
          </Button>
          {isLast ? (
            <Button type="button" size="sm" onClick={dismiss}>
              {t('onboarding.start')}
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => goTo(index + 1)}>
              {t('onboarding.next')}
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
