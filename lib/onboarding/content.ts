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
  /**
   * 演示动图（P0-3-32 扩展）。`null` = 这张卡不放媒体，卡片自动退回单列。
   *
   * ⚠️ **路径必须指向 `public/` 下真实存在的文件** —— 指向不存在的文件等于画一个假东西
   * （和「守卫判 null 时宁可不画链接」同一条纪律）。`scripts/regress-onboarding.ts`
   * 会 `fs.existsSync` 逐条钉住，写错文件名回归立刻红、不会等到线上才发现一个空框。
   */
  media: OnboardingMedia | null
}

/** 一张卡的演示动图（`public/onboarding/` 下的静态资源）。 */
export type OnboardingMedia = {
  /** 站内绝对路径，如 `/onboarding/new-token.mp4`。 */
  src: string
  /**
   * 首帧封面。两处用：`<video poster>`，以及 `prefers-reduced-motion` 降级时
   * 顶替视频的那张静止图（纯 CSS 切换，不读 `matchMedia` —— 那会撞
   * `react-hooks/set-state-in-effect` 且 SSR 会 hydration 不匹配）。
   */
  poster: string
  /**
   * 一句话说明画面在演什么。视频对读屏软件是隐藏的，这句是它唯一的语义载体；
   * 同时它也承担「不播视频也看得懂」的兜底。
   */
  caption: string
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
    media: null,
  },
  {
    id: 'open-canvas',
    title: '① 打开 bCourses',
    lead: '用你的伯克利账号登录，然后点左侧栏最上方的头像。',
    points: [
      '头像就在 Cal 校徽正下方，下面写着「Account」。',
      '点开后菜单里的「Settings」就是 Access Token 所在的那一页。',
    ],
    external: { label: '去 bCourses', url: CANVAS_HOME_URL },
    internal: null,
    /**
     * 录屏 2026-09-20（Steven 本机，全屏 3024×1898）。
     *
     * 🔴 **文案里"在哪里点"是事实，必须拿录屏对一遍**（本卡踩到的正是这一条）：
     * 这条片子拍的是「点**左侧栏最上方**的头像 → 菜单里的 Settings」，而卡片原先写的是
     * 「左侧菜单**底部**找到 Account」+「**右上角**头像同样能进 Settings」—— 与实际界面都不符
     * （Account 就在 Cal 校徽正下方）。Steven 2026-09-20 指出后已按画面改正。
     * ⚠️ 我第一版还曾把这条片子判成"内容不对、不采用"：其实是我把「账号菜单浮层」看成了
     * 「无障碍设置弹窗」（浮层里确实有 Accessibility Settings 一段，但那不是它的主题）。
     * 教训：**别只看接触表下结论，放大到原分辨率看** —— 边界与文字都在那里。
     *
     * 裁切取 `crop=1900:1240:0:160`：去掉浏览器窗口（标签栏/地址栏）与右侧「To Do」栏，
     * 只留左栏 + 弹层 + 两张课程卡做上下文。高度取 1240 是为了**把弹层整块包进去**
     * （弹层底边约 y=1280，裁切覆盖到 y=1400），否则「Accessibility Settings」那段会被切断。
     * 体积只有 77KB —— 画面绝大部分是静止的，可变形参压不动它，这是 UI 录屏的常态。
     *
     * ⚠️ 弹层里是**真实姓名与头像**（Canvas 账号菜单自带的；它们住在动态浮层里，
     * "先跑脚本改 DOM 再录"够不着 —— 脚本跑完浮层才渲染）。Steven 2026-09-20 明确接受，
     * 理由是姓名与头像本来就公开在他的个人站 / GitHub 上。将来若要遮：弹层在整段里
     * 是**静止**的 → 固定坐标的模糊块就够，不必重录（这正是"静止内容可以打码、
     * 滚动内容不行"那条判据的适用场景）。
     */
    media: {
      src: '/onboarding/open-canvas.mp4',
      poster: '/onboarding/open-canvas-poster.webp',
      caption: '动画演示：点左侧栏最上方的头像（Account）→ 弹出菜单里的「Settings」。',
    },
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
    /**
     * 录屏 2026-09-20（Steven 本机，全屏 3024×1898）。
     *
     * 裁切做了两件事：去掉浏览器窗口（顶栏里没有任何 token，但也没必要露），
     * 以及**把右栏整条切掉** —— Canvas 的 Settings 页右栏是「Ways to Contact」，
     * 里面就是登录邮箱。那串邮箱**从第 0 帧就在画面里**（它比清理脚本渲染得晚，
     * 所以脚本没改到它），只能靠裁切解决。左边界取 420 而不是 670：
     * 670 会把「+ New Access Token」按钮整块切没（按钮从 x≈482 开始）。
     */
    media: {
      src: '/onboarding/new-token.mp4',
      poster: '/onboarding/new-token-poster.webp',
      caption: '动画演示：在 Settings 页找到「+ New Access Token」，填写 Purpose 与过期日期。',
    },
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
    /**
     * 录屏 2026-09-20（同一批）。裁掉了浏览器窗口与 Tempo 侧栏，只留内容区；
     * 时间轴取原片 13s→34s（前 13 秒在演「新建课程」，与这张卡要教的「粘回 token」无关）。
     *
     * ✅ token 输入框是 `type="password"`（`canvas-connect-form.tsx`），所以粘进去
     * 的那串东西在画面里**只有圆点**。这条不是靠肉眼保证的，是靠输入框类型保证的。
     */
    media: {
      src: '/onboarding/connect.mp4',
      poster: '/onboarding/connect-poster.webp',
      caption: '动画演示：回到 Tempo 打开一门课 →「Canvas 关联」→ 粘贴 token、选过期时间。',
    },
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
 * 英文版四张卡（P0-5-1）。**结构与 id、外链、媒体路径必须与 `ONBOARDING_STEPS` 完全一致**
 * —— 只有 title / lead / points / label / caption 换语言（媒体是同一批录屏）。
 * 放在本模块而不是 messages.ts：步骤内容是结构化数据（points 是数组），
 * 且本文件必须保持零运行时 import。
 */
export const ONBOARDING_STEPS_EN: readonly OnboardingStep[] = [
  {
    id: 'why',
    title: 'Spend a minute connecting Canvas',
    lead: 'Tempo does not guess your assignments — it reads them directly from bCourses. Connect once, and assignments, exams, and deadlines appear on this page automatically.',
    points: [
      'All you need is an Access Token — never your password.',
      'Not ready to connect? Below you can first see how a real syllabus gets broken open.',
    ],
    external: null,
    internal: null,
    media: null,
  },
  {
    id: 'open-canvas',
    title: '① Open bCourses',
    lead: 'Sign in with your Berkeley account, then click the avatar at the very top of the left sidebar.',
    points: [
      'The avatar sits right below the Cal seal, labeled "Account".',
      'In the menu that opens, "Settings" is the page with Access Tokens.',
    ],
    external: { label: 'Go to bCourses', url: CANVAS_HOME_URL },
    internal: null,
    media: {
      src: '/onboarding/open-canvas.mp4',
      poster: '/onboarding/open-canvas-poster.webp',
      caption: 'Animated: click the avatar (Account) at the top of the left sidebar → "Settings" in the menu.',
    },
  },
  {
    id: 'new-token',
    title: '② Generate an Access Token',
    lead: 'Scroll down on the Settings page, find "+ New Access Token" and open it.',
    points: [
      'Fill Purpose with anything (e.g. tempo) — it is just a note to yourself.',
      'Expiration date and Expiration time are required, at most 90 days.',
      'After clicking "Generate Token", copy it immediately: once the dialog closes, the token is gone forever.',
      'Changed your mind? Revoke anytime from the "Access Tokens" list on the same page.',
    ],
    external: { label: 'Open Settings directly', url: CANVAS_SETTINGS_URL },
    internal: null,
    media: {
      src: '/onboarding/new-token.mp4',
      poster: '/onboarding/new-token-poster.webp',
      caption: 'Animated: find "+ New Access Token" on the Settings page, fill in Purpose and the expiration date.',
    },
  },
  {
    id: 'connect',
    title: '③ Paste it back into Tempo',
    lead: 'Back in Tempo, open a course → "Canvas link" → paste the token and pick the matching Canvas course.',
    points: [
      'The token is encrypted on the server and only reads assignments and deadlines — never sent to the browser, never logged.',
      'Once connected, Tempo syncs automatically on open; disconnect anytime with one click.',
    ],
    external: null,
    internal: 'connect',
    media: {
      src: '/onboarding/connect.mp4',
      poster: '/onboarding/connect-poster.webp',
      caption: 'Animated: back in Tempo, open a course → "Canvas link" → paste the token and pick the expiry.',
    },
  },
]

/** 按语言取步骤列表（P0-5-1）。默认 zh —— 回归脚本等老调用方行为不变。 */
export function getOnboardingSteps(lang: 'zh' | 'en' = 'zh'): readonly OnboardingStep[] {
  return lang === 'en' ? ONBOARDING_STEPS_EN : ONBOARDING_STEPS
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
