/**
 * P0-3-27 回归：URL 抓取的**判定层**（不依赖网络、不调 LLM、零写入）。
 *
 * 运行：`npm run regress:url-ingest`
 *
 * 钉死四件事：
 * 1. **链接识别口径**（`looksLikeUrl`）—— 含空白不算、小数不算、`http(s)` 与裸域名算；
 * 2. **SSRF 护栏**（`isPrivateIp` / `isBlockedHostname` / `checkDestination`）——
 *    本机 / 内网 / 链路本地 / v4-mapped IPv6 全拦，公网放行；这是安全底线，只许更严；
 * 3. **子页选取**（`pickSubpages`）—— 只跟同源、只跟命中关键词的、有上限、去重、去自身；
 * 4. **合并**（`mergeTexts`）—— 带来源标注、超量截断并如实标记。
 *
 * ⚠️ 只测**纯判定**：`fetchUrlText` 的网络层（超时 / 1MB / 跳转 / DNS）由代码护栏 +
 * 上线后的真链接验收覆盖，不在本脚本里真发请求。
 */

import { looksLikeUrl, normalizeUrlInput } from "@/lib/ingest/detect"
import {
  checkDestination,
  extractLinks,
  isBlockedHostname,
  isPrivateIp,
  mergeTexts,
  pickSubpages,
} from "@/lib/ingest/url-fetch"

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

async function main() {
  console.log("looksLikeUrl（链接 vs 文本）")
  {
    check("https:// 链接 → true", looksLikeUrl("https://math.berkeley.edu/~m53"))
    check("http:// 链接 → true", looksLikeUrl("http://example.com/course"))
    check("裸域名 → true", looksLikeUrl("math.berkeley.edu"))
    check("裸域名带路径 → true", looksLikeUrl("example.com/course/schedule"))
    check("空串 → false", !looksLikeUrl("   "))
    check("含空白的句子 → false", !looksLikeUrl("Quiz 1: Sep 4"))
    check("单个小数 → false（3.14）", !looksLikeUrl("3.14"))
    check("日期形态 → false（9.20）", !looksLikeUrl("9.20"))
    check("IP 字面量 → false（127.0.0.1）", !looksLikeUrl("127.0.0.1"))
    check("一句话夹域名 → false", !looksLikeUrl("见 example.com"))
  }

  console.log("normalizeUrlInput（补 scheme）")
  {
    check("裸域名 → 补 https", normalizeUrlInput("example.com/x") === "https://example.com/x")
    check("已是 http → 原样", normalizeUrlInput("http://example.com") === "http://example.com")
    check("已是 https → 原样", normalizeUrlInput("https://example.com") === "https://example.com")
  }

  console.log("isPrivateIp（本机 / 内网 / 链路本地）")
  {
    check("回环 127.0.0.1", isPrivateIp("127.0.0.1"))
    check("10/8", isPrivateIp("10.1.2.3"))
    check("172.16/12 下界", isPrivateIp("172.16.0.1"))
    check("172.16/12 上界", isPrivateIp("172.31.255.255"))
    check("192.168/16", isPrivateIp("192.168.0.1"))
    check("链路本地 / 元数据 169.254.169.254", isPrivateIp("169.254.169.254"))
    check("0.0.0.0", isPrivateIp("0.0.0.0"))
    check("运营商级 NAT 100.64.0.1", isPrivateIp("100.64.0.1"))
    check("IPv6 回环 ::1", isPrivateIp("::1"))
    check("IPv6 链路本地 fe80::1", isPrivateIp("fe80::1"))
    check("IPv6 唯一本地 fc00::1", isPrivateIp("fc00::1"))
    check("v4-mapped ::ffff:127.0.0.1", isPrivateIp("::ffff:127.0.0.1"))
    // 对照组：这些是公网，必须放行（判宽了会把正常站点也挡掉）。
    check("公网 8.8.8.8 → false", !isPrivateIp("8.8.8.8"))
    check("公网 1.1.1.1 → false", !isPrivateIp("1.1.1.1"))
    check("172.32.0.1（出 172.16/12）→ false", !isPrivateIp("172.32.0.1"))
    check("172.15.0.1（在 172.16/12 之前）→ false", !isPrivateIp("172.15.0.1"))
    check("192.169.0.1（非 192.168）→ false", !isPrivateIp("192.169.0.1"))
    check("公网 IPv6 → false", !isPrivateIp("2606:4700::1111"))
  }

  console.log("isBlockedHostname（字面量层）")
  {
    check("localhost", isBlockedHostname("localhost"))
    check("foo.localhost", isBlockedHostname("foo.localhost"))
    check("foo.local", isBlockedHostname("foo.local"))
    check("bar.internal", isBlockedHostname("bar.internal"))
    check("127.0.0.1", isBlockedHostname("127.0.0.1"))
    check("10.0.0.5", isBlockedHostname("10.0.0.5"))
    check("带方括号的 [::1]", isBlockedHostname("[::1]"))
    check("example.com → false", !isBlockedHostname("example.com"))
    check("math.berkeley.edu → false", !isBlockedHostname("math.berkeley.edu"))
    check("8.8.8.8 → false", !isBlockedHostname("8.8.8.8"))
  }

  console.log("extractLinks（绝对化 + 锚文本）")
  {
    const html =
      '<html><body><a href="/schedule">Schedule</a>' +
      "<a href='grading.html'>Grading</a>" +
      '<a href="https://other.com/x">X</a>' +
      '<a href="#top">Top</a></body></html>'
    const links = extractLinks(html, "https://math.berkeley.edu/m53/")
    const hrefs = links.map((l) => l.href)
    check("根相对 → 绝对", hrefs.includes("https://math.berkeley.edu/schedule"))
    check("文档相对 → 绝对", hrefs.includes("https://math.berkeley.edu/m53/grading.html"))
    check("绝对链接保留", hrefs.includes("https://other.com/x"))
    check("片段链接 → 绝对（带 #）", hrefs.includes("https://math.berkeley.edu/m53/#top"))
    check("锚文本已取", links.some((l) => l.href.endsWith("/schedule") && l.text === "Schedule"))
    check("共 4 条", links.length === 4, JSON.stringify(hrefs))
  }

  console.log("pickSubpages（同源 + 关键词 + 上限）")
  {
    const base = "https://math.berkeley.edu/m53/"
    const links = [
      { href: "https://math.berkeley.edu/m53/schedule", text: "Schedule" },
      { href: "https://math.berkeley.edu/m53/grading.html", text: "Grading" },
      { href: "https://math.berkeley.edu/m53/about", text: "About us" },
      { href: "https://other.com/m53/exam", text: "Exam" },
      { href: "https://math.berkeley.edu/m53/", text: "Home" },
      { href: "mailto:prof@berkeley.edu", text: "Email" },
      { href: "https://math.berkeley.edu/m53/schedule", text: "Schedule again" },
    ]
    const picked = pickSubpages(links, base, 5)
    check("命中 schedule", picked.includes("https://math.berkeley.edu/m53/schedule"))
    check("命中 grading", picked.includes("https://math.berkeley.edu/m53/grading.html"))
    check("无关键词 → 不跟", !picked.some((h) => h.endsWith("/about")))
    check("跨源 → 不跟", !picked.some((h) => h.includes("other.com")))
    check("自身 → 不跟", !picked.includes("https://math.berkeley.edu/m53/"))
    check("mailto → 不跟", !picked.some((h) => h.startsWith("mailto:")))
    check("去重（schedule 只一次）", picked.filter((h) => h.endsWith("/schedule")).length === 1)
    check("上限生效（max=1 → 1 条）", pickSubpages(links, base, 1).length === 1)
    check("结果 ≤5", picked.length <= 5)
  }

  console.log("mergeTexts（来源标注 + 截断）")
  {
    const pages = [
      { url: "https://a.example/", text: "第一页内容" },
      { url: "https://b.example/", text: "第二页内容" },
    ]
    const merged = mergeTexts(pages)
    check("带来源标注", merged.text.includes("── 来源：https://a.example/ ──"))
    check("两页都在", merged.text.includes("第一页内容") && merged.text.includes("第二页内容"))
    check("未截断", merged.truncated === false)

    const tiny = mergeTexts(pages, 10)
    check("超量截断标记", tiny.truncated === true)
    check("截断后不超上限", tiny.text.length <= 10)
  }

  console.log("checkDestination（协议 + 主机 + 凭据，离线可测）")
  {
    const file = await checkDestination(new URL("file:///etc/passwd"))
    check("file:// → bad_request", !file.ok && file.code === "bad_request")
    const creds = await checkDestination(new URL("http://user:pass@example.com/"))
    check("带账号密码 → bad_request", !creds.ok && creds.code === "bad_request")
    const loopback = await checkDestination(new URL("http://127.0.0.1/"))
    check("127.0.0.1 → blocked_url", !loopback.ok && loopback.code === "blocked_url")
    const localhost = await checkDestination(new URL("http://localhost/"))
    check("localhost → blocked_url", !localhost.ok && localhost.code === "blocked_url")
    const privateNet = await checkDestination(new URL("http://192.168.1.1/"))
    check("192.168.1.1 → blocked_url", !privateNet.ok && privateNet.code === "blocked_url")
    const metadata = await checkDestination(new URL("http://169.254.169.254/latest/meta-data/"))
    check("云元数据地址 → blocked_url", !metadata.ok && metadata.code === "blocked_url")
  }

  console.log(`\n通过 ${passed} / 失败 ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

void main()
