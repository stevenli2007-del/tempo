/**
 * 新手引导的内容与判据（P0-3-32）—— **纯模块**。
 *
 * ### 为什么是独立文件
 * 三处消费方，运行环境各不相同：
 * - `app/(routes)/dashboard/page.tsx`（服务端）读 `hasSeenOnboarding()` 决定要不要渲染；
 * - `components/onboarding/onboarding-cards.tsx`（客户端）读步骤内容；
 * - `scripts/regress-onboarding.ts`（Node）断言外链与标记判据。
 *
 * 所以本文件**零 import**：沾上 `next/headers` / `lib/supabase/*` 就会被拖进客户端图，
 * build 直接失败（与 `lib/safe-url.ts` / `lib/internal-path.ts` / `lib/messages/registry.ts`
 * 同一条纪律）。
 *
 * ### 🔴 「看过」的标记为什么用 cookie 而不是 localStorage
 * 卡面允许两者，选 cookie 是因为它**服务端读得到** —— 引导卡于是在**首屏 HTML 里**
 * 就渲染出来（真正的「首次登录第一屏」），而不是等客户端 JS 挂载后再补一块
 * （那样会闪一下，且需要在 effect 里 `setState`，正好撞上本仓的
 * `react-hooks/set-state-in-effect`）。换浏览器 / 清 cookie 会再见一次 ——
 * 这是「不新增表、零迁移」这张卡的既定代价。
 */

/** bCourses 首页（Canvas 全局导航 / 账号菜单的入口）。 */
export const CANVAS_HOME_URL = 'https://bcourses.berkeley.edu'
/**
 * bCourses 的 Settings 页 —— **`+ New Access Token` 就在这一页**。
 * 用深链是为了让用户少走一步（P0-2-1 实测确认按钮在此页，2026-09-01）。
 */
export const CANVAS_SETTINGS_URL = 'https://bcourses.berkeley.edu/profile/settings'

/**
 * 「已看过引导」的 cookie 名。
 * ⚠️ 改名 = 所有已看过的人再看一次（可接受，但要知道）。
 */
export const ONBOARDING_COOKIE = 'tempo_onboarding_seen'

/** 标记有效期：一年（引导是一次性信息，但一年后重看一遍没有坏处）。 */
export const ONBOARDING_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** 教程卡的跳转目标。站内那一步的 `href` 由页面注入（见组件），故这里是判别式。 */
export type OnboardingStep = {
  /** 稳定 id —— 用作 React `key`，**同一份列表里必须唯一**（回归钉住）。 */
  id: string
  title: string
  /** 一段人话说明。 */
  lead: string
  /** 要点。每条都是写完就不再变的操作细节，**不写「应该」「大概」**。 */
  points: string[]
  /** 外链（写死常量，不接用户输入 → 渲染前仍过 `readSafeUrl()`）。 */
  external: { label: string; url: string } | null
  /** 站内跳转：`connect` = 去第一门课的「Canvas 关联」区块。 */
  internal: 'connect' | null
}

/**
 * 四张卡：① 接上来值不值 ② 去哪打开 Canvas ③ 怎么生成 token ④ 怎么粘回来。
 *
 * 🔴 写文案的三条约束：
 * 1. **不承诺做不到的事**（模板里没有「一键接入」—— 现在确实是手动粘 token）；
 * 2. **每一个「去哪里点」都要能点**（外链/站内链接必须存在，否则那句话等于没说）；
 * 3. 中文文案用「」，ASCII 直引号只留给代码（CodingRules §10.2 已踩两次）。
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'why',
    title: '花一分钟把 Canvas 接上',
    lead: 'Tempo 不猜你的作业 —— 它从 bCourses 直接读。接一次，之后作业、考试与截止日期都会自动出现在这一页。',
    points: [
      '全程只需要一串 Access Token，不需要你的密码。',
      '不想现在接也行：下面可以先看一份真实 syllabus 被拆开的样子。',
    ],
    external: null,
    internal: null,
  },
  {
    id: 'open-canvas',
    title: '① 打开 bCourses',
    lead: '用你的伯克利账号登录，然后在左侧菜单底部找到「Account」→「Settings」。',
    points: ['右上角头像同样能进 Settings，两个入口是同一个页面。'],
    external: { label: '去 bCourses', url: CANVAS_HOME_URL },
    internal: null,
  },
  {
    id: 'new-token',
    title: '② 生成 Access Token',
    lead: '在 Settings 页面往下滚，找到「+ New Access Token」并点开。',
    points: [
      'Purpose 随便填（比如 tempo）—— 它只是给你自己看的备注。',
      'Expiration date 与 Expiration time 是必填项，最长只能设 90 天。',
      '点「Generate Token」后请立刻复制：弹窗一关就再也看不到那串 token 了。',
      '后悔了随时能撤：回到同一页的「Access Tokens」列表删掉即可。',
    ],
    external: { label: '直接打开 Settings', url: CANVAS_SETTINGS_URL },
    internal: null,
  },
  {
    id: 'connect',
    title: '③ 粘回 Tempo',
    lead: '回到 Tempo，打开一门课 → 找到「Canvas 关联」→ 粘贴刚才那串 token，并选择它对应的 Canvas 课程。',
    points: [
      'token 在服务端加密存储，只用来读作业与截止日期，不会进浏览器、不写日志。',
      '接上之后再打开 Tempo 就会自动同步；想断开随时一键撤销。',
    ],
    external: null,
    internal: 'connect',
  },
]

/**
 * cookie 里存的值 = 用户 id。
 *
 * 存 id 而不是存 `'1'`，是为了让标记**天然按用户分**：
 * 同一台电脑上换一个账号登录，值对不上 → 引导照常出现（卡面「每用户」的要求）。
 */
export function onboardingCookieValue(userId: string): string {
  return encodeURIComponent(userId)
}

/**
 * 「这个浏览器上的这个用户看过引导了吗」。
 *
 * ⚠️ **判据是"相等"而不是"存在"**：空值、别人的 id、被截断的值一律算没看过。
 * ⚠️ 解码失败（被手工改坏的值）按**没看过**处理 —— 宁可多显示一次引导，
 * 也不要让一个坏 cookie 把新用户的引导永久吞掉。
 */
export function hasSeenOnboarding(cookieValue: string | undefined, userId: string): boolean {
  if (typeof cookieValue !== 'string' || cookieValue === '') return false
  if (userId === '') return false
  let decoded = cookieValue
  try {
    decoded = decodeURIComponent(cookieValue)
  } catch {
    return false
  }
  return decoded === userId
}
