/**
 * P0-3-32 回归：新手引导的内容层与守卫（**不依赖数据库、不依赖网络、不调 LLM**）。
 *
 * 运行：`npx -y tsx scripts/regress-onboarding.ts`（或 `npm run regress:onboarding`）
 *
 * 钉死五件事，每一条都对应一个"全绿但静默错"的真实陷阱：
 * 1. **教程卡的跳转链接必须真的是 http(s) 绝对 URL** —— 卡片上写着「去 bCourses」，
 *    而链接被判 null 时渲染层**不画链接**（这是刻意的：不画假链接）。于是
 *    "常量写坏了"的表现是**引导卡少一个按钮**，页面不报错、构建不报错。
 *    所以在回归里钉住常量，而不是等到线上肉眼发现少了个按钮。
 * 2. **`FEEDBACK_URL` 占位常量同理** —— Steven 换 Google Form 链接时若漏了协议
 *    （`docs.google.com/...`），侧栏入口会静默消失。
 * 3. **外链守卫拦得住 `javascript:` / `data:` / 协议相对 URL** —— 三者的共同点是
 *    "长得像链接"。守卫只有一份（`lib/safe-url.ts`），这里顺便钉住它的判据。
 * 4. **站内路径走另一个守卫** —— `/courses/<id>` 必须放行（喂给外链守卫会判 null →
 *    链接凭空消失），`//evil.com` 必须拒（协议相对 URL）。
 * 5. **「看过」的标记按用户判、且判据是"相等"不是"存在"** —— 用 `'1'` 之类的
 *    存在性判定，会让**同一台电脑上的下一个账号**再也看不到引导；
 *    解码失败的值则必须按「没看过」处理（宁可多看一次，不能让新用户的引导被坏 cookie 吞掉）。
 */

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

import { FEEDBACK_URL } from "@/lib/constants"
import {
  CANVAS_HOME_URL,
  CANVAS_SETTINGS_URL,
  ONBOARDING_COOKIE,
  ONBOARDING_STEPS,
  hasSeenOnboarding,
  onboardingCookieValue,
} from "@/lib/onboarding/content"
import { readInternalPath } from "@/lib/internal-path"
import { readSafeUrl } from "@/lib/safe-url"

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

/** 读 `public/` 下某个静态资源的大小（KB）；文件不在返回 `null`。 */
function assetKb(rel: string): number | null {
  const abs = join(process.cwd(), "public", rel)
  return existsSync(abs) ? statSync(abs).size / 1024 : null
}

console.log("外链守卫 readSafeUrl（唯一实现，P0-3-25 与本卡共用）")
{
  check("https 放行", readSafeUrl("https://bcourses.berkeley.edu") !== null)
  check("http 放行", readSafeUrl("http://x.test/a") !== null)
  check("javascript: 拒", readSafeUrl("javascript:alert(1)") === null)
  check("data: 拒", readSafeUrl("data:text/html,<script>1</script>") === null)
  check("vbs 拒", readSafeUrl("vbscript:msgbox(1)") === null)
  check("协议相对 URL 拒（//host）", readSafeUrl("//evil.com/x") === null)
  check("缺协议的裸域名拒", readSafeUrl("bcourses.berkeley.edu") === null)
  check("站内路径拒（那是另一个守卫的活）", readSafeUrl("/courses/abc") === null)
  check("空串拒", readSafeUrl("") === null)
  check("只有空白拒", readSafeUrl("   ") === null)
  check("非字符串拒", readSafeUrl(42) === null && readSafeUrl(null) === null)
  check("取出的是规范化后的绝对 URL", readSafeUrl("https://x.test") === "https://x.test/")
}

console.log("")
console.log("教程卡常量（写死了链路，所以必须钉住）")
{
  check("bCourses 首页可点", readSafeUrl(CANVAS_HOME_URL) !== null, CANVAS_HOME_URL)
  check("Settings 深链可点", readSafeUrl(CANVAS_SETTINGS_URL) !== null, CANVAS_SETTINGS_URL)
  check(
    "两个跳转都在 bCourses 域内",
    readSafeUrl(CANVAS_HOME_URL)?.startsWith("https://bcourses.berkeley.edu") === true &&
      readSafeUrl(CANVAS_SETTINGS_URL)?.startsWith("https://bcourses.berkeley.edu") === true,
  )
  check("Settings 深链指向 /profile/settings", CANVAS_SETTINGS_URL.endsWith("/profile/settings"))

  check("🔴 FEEDBACK_URL 是完整 http(s) URL（换链接时别漏协议）", readSafeUrl(FEEDBACK_URL) !== null, FEEDBACK_URL)
}

console.log("")
console.log("步骤结构（少一步 / 重 id / 无链接都是静默退化）")
{
  const ids = ONBOARDING_STEPS.map((step) => step.id)
  check("步骤数 ≥ 3", ONBOARDING_STEPS.length >= 3, String(ONBOARDING_STEPS.length))
  check("id 唯一（要当 React key）", new Set(ids).size === ids.length, ids.join(","))
  check(
    "每张卡都有标题与正文",
    ONBOARDING_STEPS.every((step) => step.title.trim() !== "" && step.lead.trim() !== ""),
  )
  check(
    "要点都是非空字符串（空白项会渲染成一个孤立圆点）",
    ONBOARDING_STEPS.every((step) => step.points.every((p) => p.trim() !== "")),
  )
  check(
    "🔴 除第一张（为什么接）外，每张都有可跳的链接",
    ONBOARDING_STEPS.slice(1).every((step) => step.external !== null || step.internal !== null),
  )
  check(
    "每一步的链接都能过守卫（过不了 = 按钮不出现）",
    ONBOARDING_STEPS.every(
      (step) => step.external === null || readSafeUrl(step.external.url) !== null,
    ),
  )
  check(
    "带外链的卡都标了 https 且新开标签（渲染层 target=_blank 的同一批）",
    ONBOARDING_STEPS.filter((step) => step.external !== null).every((step) =>
      String(step.external?.url).startsWith("https://"),
    ),
  )
  check(
    "最后一张是「粘回 Tempo」（引导闭环：站内连接那一步）",
    ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]?.internal === "connect",
  )
  check("带外链的卡 ≥ 2 张（打开 Canvas / 生成 token）", ONBOARDING_STEPS.filter((step) => step.external !== null).length >= 2)
}

console.log("")
console.log("站内路径守卫 readInternalPath（与外链守卫刻意分开）")
{
  check("课程详情页放行", readInternalPath("/courses/123e4567-e89b-12d3-a456-426614174000") !== null)
  check("课程列表页放行", readInternalPath("/courses") !== null)
  check("协议相对 URL 拒", readInternalPath("//evil.com/x") === null)
  check("反斜杠形态拒", readInternalPath("/\\evil.com") === null)
  check("外链（http(s)）拒 —— 它该走另一个守卫", readInternalPath("https://x.test/a") === null)
  check("空串拒", readInternalPath("") === null)
}

console.log("")
console.log("「看过」标记（cookie 值 = 用户 id）")
{
  const me = "5f0c1e2a-1111-4bbb-8ccc-9ddddddddddd"
  const other = "9999aaaa-2222-4bbb-8ccc-9ddddddddddd"

  check("cookie 名固定", ONBOARDING_COOKIE === "tempo_onboarding_seen", ONBOARDING_COOKIE)
  check("本人看过 → 不出现", hasSeenOnboarding(onboardingCookieValue(me), me) === true)
  check(
    "🔴 同一浏览器换账号 → 引导照常出现（判据是相等，不是存在）",
    hasSeenOnboarding(onboardingCookieValue(other), me) === false,
  )
  check("没有 cookie → 出现", hasSeenOnboarding(undefined, me) === false)
  check("空串 → 出现（不是「存在就算看过」）", hasSeenOnboarding("", me) === false)
  check("写坏的值 → 出现（宁可多看一次，不能被坏 cookie 吞掉）", hasSeenOnboarding("%", me) === false)
  check("缺 userId → 出现", hasSeenOnboarding(onboardingCookieValue(me), "") === false)
  check("编码往返稳定（uuid 不含需转义字符，值可读）", onboardingCookieValue(me) === me)
}

console.log("")
console.log("演示动图（P0-3-32 扩展）—— 路径写错的表现是卡片上一个空白框，构建不报错")
{
  const withMedia = ONBOARDING_STEPS.flatMap((step) =>
    step.media === null ? [] : [{ id: step.id, media: step.media }],
  )

  check(
    "确实有卡带动图（全 null 时下面这段等于没跑，要显式看见）",
    withMedia.length >= 1,
    String(withMedia.length),
  )

  for (const { id, media } of withMedia) {
    check(`[${id}] src 是 /onboarding/ 下的站内路径`, media.src.startsWith("/onboarding/"), media.src)
    check(`[${id}] src 是 .mp4`, media.src.endsWith(".mp4"), media.src)
    check(`[${id}] poster 是 .webp`, media.poster.endsWith(".webp"), media.poster)
    check(
      `[${id}] caption 非空（视频对读屏软件是隐藏的，语义只能靠它）`,
      media.caption.trim() !== "",
    )
    check(
      `[${id}] src 与 poster 同目录`,
      media.src.slice(0, media.src.lastIndexOf("/")) ===
        media.poster.slice(0, media.poster.lastIndexOf("/")),
    )
  }

  // 🔴 这一组是本卡最值钱的断言：**文件名打错时页面不报错、构建不报错**，
  //    用户看到的就是卡片上一个空白方块 —— 只有真去看文件在不在才拦得住。
  for (const { id, media } of withMedia) {
    for (const rel of [media.src, media.poster]) {
      const abs = join(process.cwd(), "public", rel)
      check(`[${id}] 文件真的在：${rel}`, existsSync(abs), abs)
    }
  }

  // 体积闸门：单条 ≤ 700KB、封面 ≤ 120KB。超了要回头调 crf / fps / 宽度，
  // 而不是把大文件塞进仓库 —— 二进制一旦进了 git 历史就永久占位。
  for (const { id, media } of withMedia) {
    const kb = assetKb(media.src)
    check(
      `[${id}] 动图 ≤ 700KB（当前 ${kb === null ? "文件缺失" : `${kb.toFixed(0)}KB`}）`,
      kb !== null && kb <= 700,
    )
    const posterKb = assetKb(media.poster)
    check(
      `[${id}] 封面 ≤ 120KB（当前 ${posterKb === null ? "文件缺失" : `${posterKb.toFixed(0)}KB`}）`,
      posterKb !== null && posterKb <= 120,
    )
  }

  const totalKb = withMedia.reduce((sum, { media }) => sum + (assetKb(media.src) ?? 0), 0)
  check(`全部动图合计 ≤ 2MB（当前 ${totalKb.toFixed(0)}KB）`, totalKb <= 2048)
}

console.log("")
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
