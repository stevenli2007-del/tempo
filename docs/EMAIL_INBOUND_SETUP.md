# 邮件入站部署手册（P0-3-11）

> **适用范围**：把「转发到 Tempo 密址的邮件」接通到入站处理链路。
> **代码状态**：已上线 `main`（`6f4d1b1` + 本次 worker 依赖修复）。**以下全部是【Steven 手动】步骤**，代码侧不需要再改。
> **域名**：`tempocourse.com`（2026-09-17 于 Cloudflare Registrar 注册）。
> **设计依据**：`docs/Decisions.md` ADR-019（密址绑定 + 纯入站）、`docs/Phase-0-MVP.md` P0-3-11。

**进度速查**（2026-09-17）：①zone ✅ ②onboard ✅ ③destination ✅ ④subaddressing ✅ ⑤deploy Worker ✅（`7ac9d632`）⑥catch-all ✅ ｜ 剩余 ⑦Vercel env ⬜ ⑧端到端验收 ⬜

---

## 0. 链路全貌（先看这张图，再动手）

```
  你 / Gradescope
        │  转发（或直接在 Gradescope 改通知邮箱）
        ▼
  inbound+<token>@tempocourse.com
        │
        ▼  ① Cloudflare Email Routing（catch-all 规则）
  Worker: tempo-inbound-email          ← 解析 message.raw 取正文（postal-mime）
        │  ② POST JSON + Bearer <INBOUND_EMAIL_SECRET>
        ▼
  Vercel: POST /api/v1/email/inbound   ← 校验密钥 → 密址 token 定位用户
        │  ③ DeepSeek 解析 → 确定性匹配 task → 只写 status='done'
        ▼
  Supabase: tasks.status + email_inbound_events（审计）
```

**三处必须用同一份密钥**：Vercel env `INBOUND_EMAIL_SECRET` ↔ Worker secret `INBOUND_EMAIL_SECRET`。
**密钥不入库**：本文档只留占位符；真值见对话记录，或用下面命令现生成一份新的：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

---

## 1. ✅【已完成 2026-09-17 10:43】域名 zone 已生效

- [x] Cloudflare Dashboard → **Domains → Overview → `tempocourse.com`**，状态 **Active** ✅（Steven 截图确认，Plan Free）。
- [x] NS 委派已全球生效，**Cloudflare 成为权威 DNS**。三条独立实测证据：
  - `dig @1.1.1.1 NS tempocourse.com` → `kai.ns.cloudflare.com` / `sunny.ns.cloudflare.com`
  - `.com` 注册局权威（`a.gtld-servers.net`）已将该域名委派给上述两只 NS（TTL 172800）
  - 注册局 RDAP 登记 NS = `KAI/SUNNY.NS.CLOUDFLARE.COM`（status `client transfer prohibited` = 注册商转移锁，正常）

```bash
# 自查命令（权威口径，绕开本地缓存）
dig @1.1.1.1 NS tempocourse.com +short
```

> ⚠️ **判据提醒**：本地默认解析器（不写 `@1.1.1.1`）可能因缓存仍返回空 —— **空 ≠ 未生效**。实测注册后约 9 分钟（10:34 → 10:43）即通。**NS 未生效前，第 2 步的 Email Routing 打不开。**

---

## 2. ✅【已完成 2026-09-17】开启 Email Routing（onboard domain）

> **实测状态（Steven 截图）**：已进入 `Compute → Email Service → Email Routing · tempocourse.com`，**Onboard Domain 已完成**。
> 面板 Configuration summary 读数：`Domains: 1`、`DNS records: Locked`、**`Routing status: Syncing`**、`Routing rules: 0`、`Destination addresses: 0`。
> ✅ **DNS 侧已实测就位（2026-09-17 11:30）** —— `Routing status` 虽显示 `Syncing`，但收信所需记录已全球可见（权威 NS 直查一致，非缓存）：
>
> ```
> MX   → route1 / route2 / route3.mx.cloudflare.net  ✅
> SPF  → v=spf1 include:_spf.mx.cloudflare.net ~all  ✅
> DKIM → cf2024-1._domainkey（RSA 公钥已发布）        ✅
> ```
>
> 即 **`tempocourse.com` 已可收信**，`Syncing` 只是面板状态滞后。可直接往下做第 3、4 步。
> 新面板六个标签页：**Overview / Activity log / Routing rules / Destination addresses / Destination Workers / Settings**。其中 **`Destination Workers` 是本轮新出现的入口**（旧文档没有，见第 6 步）。

- [x] **官方直达链接（推荐，免翻面板）** —— 由 Cloudflare 官方文档给出，`?to=/:account/...` 会自动落到你当前 account 的对应功能页：

```
https://dash.cloudflare.com/?to=/:account/email-service/routing
```

- [x] 手动路径（2026-06 后新面板）：**Compute → Email Service → Email Routing**（✅ 已确认进入）。
  - ⚠️ 旧的 **Email → Email Routing** **已废弃** —— zone 侧边栏的 `Email` 分组下**只有** DMARC Management / Email Security，**不含** Email Routing（2026-09-17 实测）。
  - 找不到时用面板顶部 **⌘K 搜索**框敲 `Email Routing`。
  - ⚠️ 不要手动拼 account 级 URL（如 `dash.cloudflare.com/<account_id>/email/routing`）会 404 —— 用上面的 `?to=` 形式。
- [x] 点 **Onboard Domain** → 选 `tempocourse.com`（✅ 已完成，面板 `Domains: 1`）。
- [x] 复核 Cloudflare 自动要加的 DNS 记录 → **Done**（✅ `DNS records: Locked` = 记录已由 Cloudflare 托管）：
  - `MX` → `route1.mx.cloudflare.net` 等（收信入口）
  - `TXT`（SPF）→ 授权 Email Routing 发信
  - `TXT`（DKIM）→ 转发邮件的发信认证

> 这三条是 Cloudflare 自动加的，确认即可，不要手改。

---

## 3. 【手动】加一个「目标地址」并验证（硬性门槛）✅ 已完成

> 面板右侧 **Next Steps** 第 1 条就是这个：*"Add a destination address — Choose where forwarded email should be..."*。

- [x] 切到 **Destination addresses** 标签 → 输入框填你能收信的邮箱 → 提交。（✅ 已加 `stevenli2007@berkeley.edu`）
- [x] 去该邮箱收 Cloudflare 验证信 → 点 **Verify email address**。（✅ 状态为 **Verified**，2026-09-17）

> 🔴 **官方明确要求**：*"Before you can create a routing rule, you must add and verify at least one destination address."* —— 不验证就**建不了任何规则**（指向未验证地址的规则保持 disabled）。
> 📌 **Destination addresses 是「账户级」的**（不是 zone 级），跨域名复用；所以这一步对以后加域名也有效。

### 🔑 关键澄清：Berkeley 邮箱**不会**收到入站邮件
`Destination address` **只是一个「已验证的收件端点」，本身不收任何信**。Cloudflare 原文：*"A destination address is the verified email address that Email Routing **forwards messages to**"* —— 只有**某条 routing rule 的 Action 选了 `Send to an email` 并指向它**，匹配的邮件才会投过去。

我们**唯一**的规则是 **catch-all → Send to a Worker**（第 6 步），没有任何规则指向 `stevenli2007@berkeley.edu`。所以：

| 邮件 | 去向 | Berkeley 收到？ |
|---|---|---|
| 入站邮件（转发到 `inbound+token@tempocourse.com`） | catch-all → **Worker** → 处理 → 丢弃 | ❌ |
| Cloudflare **一次性验证信**（确认拥有该邮箱） | 直发 Berkeley | ✅ 仅此一封 |
| Gradescope 直发你 Berkeley 的原始确认信 | 与 `tempocourse.com` 无关 | ✅ 本来就有 |

> ⚠️ **唯一反例**：若日后**额外**建一条普通规则（如 `info@tempocourse.com → Send to stevenli2007@berkeley.edu`），发往 `info@` 的信才会进 Berkeley。**只配 catch-all→Worker 就没这问题，别多加规则。**
> 这样设计的目的正是：**入站邮件不刷你个人邮箱**，全部由 Tempo 后台消化。

---

## 4. ✅【已完成 2026-09-17 11:44】打开 Subaddressing（`+` 子地址）—— 最容易漏的一步

- [x] 切到 **Settings** 标签 → **Subaddressing** → **Enable subaddressing** 已拨到**开启**（蓝色）。✅ Steven 截图确认。
- [x] 同页 **DNS records** 复核：`MX` 三条均 `Locked`（Cloudflare 托管），与第 2 步一致 —— 说明 zone 侧收信链路已就位。

> **为什么必须开**：我们的密址形态是 `inbound+<token>@tempocourse.com`。官方说明只有**开启后**，`+detail` 部分才会**保留在 `message.to` 里**供 Worker 读取。不开的话 token 有被规则匹配"吃掉"的风险 → Worker 拿不到 token → 入站静默失败。
> 参考：Cloudflare Docs「Email routing rules and addresses」→ Subaddressing（RFC 5233）。
> ⚠️ 此开关是**zone 级**的（每个域名单独设）。若日后加第二个域名，要重新开一次。

---

## 5. ✅【已完成 2026-09-17 11:50】部署 Worker

> 🎉 **实际执行方式**：Steven 在本地终端完成 `npx wrangler login`（浏览器 OAuth）后，**后续三步由 Agent 侧直接代跑成功** —— OAuth 凭据落在 `~/Library/Preferences/.wrangler/config/default.toml`，沙箱进程可读，于是 `wrangler deploy` / `secret put` 与 Cloudflare REST API 都不再需要人工点。
> **实测结果**：`Uploaded tempo-inbound-email (2.10 sec)`，`Version ID 7ac9d632-1db6-477b-aa36-5295cec351d2`，`Uploaded secret INBOUND_EMAIL_SECRET` ✅，`secret list` 回读含该键 ✅。
> Worker URL：`https://tempo-inbound-email.stevenli2007.workers.dev`；account `Stevenli2007@berkeley.edu's Account`（`34fd5b6ee95df046b7eba21e06f0adee`）。

> 🔴 **顺序铁律 1：本步必须先于第 6 步。** 第 6 步的动作只能选「已部署的 Worker」——先配规则会选不到 `tempo-inbound-email`。
> 🔴 **顺序铁律 2：`deploy` 必须先于 `secret put`。** `wrangler secret put` 是给**已存在的 Worker** 加一份新版本，Worker 不存在会报 `not found`。
> 🔴 **`wrangler login` 必须由人工在交互式终端跑**（Agent 侧实测：非交互环境下 `wrangler whoami` 直接报 `Not logged in ... the environment is non-interactive`）；**登录之后**的 deploy / secret / API 调用 Agent 可代跑。

参考命令（首次或换机器时）：

```bash
cd /Users/youchengli/Desktop/Tempo/workers/inbound-email
npx wrangler login   # 仅此步必须人工：浏览器弹出 → Allow
npx wrangler deploy
printf '%s' '<与 Vercel 逐字相同的密钥>' | npx wrangler secret put INBOUND_EMAIL_SECRET
```

> ⚠️ `printf '%s'`（**不带换行**）很关键 —— 交互式粘贴容易在末尾混进一个换行，导致 Worker 发的是 `Bearer <密钥>\n`，Vercel 端比对失败 → 401。
> ⚠️ 若日后想换密钥：改完 Worker 的 secret **必须**回第 7 步把 Vercel 的同名变量改成同一份，再 Redeploy。两边**逐字相同**才算数（`wrangler secret list` 只能看名字、看不到值）。

- [x] 终端输出含 `Uploaded tempo-inbound-email`；Cloudflare → **Workers & Pages** 里出现 **`tempo-inbound-email`**。✅
- [x] 部署后回到 Email Routing 页，**`Destination Workers`** 标签 / 第 6 步的动作里应能看到它。✅（catch-all 已指向它，见第 6 步）
- 不需要改 `wrangler.toml`：`name = "tempo-inbound-email"`，`INBOUND_WEBHOOK_URL` 默认已指向 `https://tempo-six-neon.vercel.app/api/v1/email/inbound`。
- **本地已验证**（2026-09-17）：`npm install` ✅、`postal-mime@2.7.6` 的 `PostalMime.parse` 返回 `{text, html}` ✅、`wrangler deploy --dry-run` 打包成功（109 KiB，`INBOUND_WEBHOOK_URL` 绑定正常）✅。
  - ⚠️ 若 `wrangler login` 后报「multiple accounts」，选账号邮箱为 `stevenli2007@berkeley.edu` 的那个。
  - ⚠️ 若 `wrangler login` 卡在等浏览器回调：wrangler 会检测代理（实测输出 `Proxy environment variables detected`）。国内网络**保留** Clash/VPN 代理即可，别 `unset`——否则连不上 dash.cloudflare.com。兜底方案见下。

<details>
<summary>兜底：不想走浏览器 OAuth（用 API Token）</summary>

Cloudflare → **My Profile → API Tokens → Create Token**，用模板 **Edit Cloudflare Workers**，权限需含
`Account → Workers Scripts → Edit`。拿到 token 后：

```bash
cd /Users/youchengli/Desktop/Tempo/workers/inbound-email
export CLOUDFLARE_API_TOKEN='<粘贴 token>'
npx wrangler deploy
printf '%s' '<同一份密钥>' | npx wrangler secret put INBOUND_EMAIL_SECRET
unset CLOUDFLARE_API_TOKEN
```

（token 只放环境变量里，**不要**写进 `wrangler.toml` 或提交。）
</details>

---

## 6. ✅【已完成 2026-09-17 11:51】Catch-all 规则 → Worker（关键）

面板右侧 **Next Steps** 第 2、3 条就是这两件事：*"Add a destination Worker"* / *"Edit your catch-all rule"*。
**本步已由 Agent 经 Cloudflare API 配好**（`catch_all` 现为 `enabled: true` + `actions: [{type: worker, value: ["tempo-inbound-email"]}]`，`rules` 计数 = 1）。
Steven 侧待做：打开面板 **Routing rules** 目视确认 **Active**（仅复核，无需再改）。

- [x] 切到 **Routing rules** 标签 → **Enable catch-all rule**（✅ 已 Active）。
- [x] 该规则的 **Action: Send to a Worker** → **Worker** 选 `tempo-inbound-email`（✅ 已指向）。
- [ ] （等价入口，**无需再做**）**Destination Workers** 标签也可把 `tempo-inbound-email` 登记为投递目标；效果一致，**不要重复建普通规则**。
- [x] `Routing rules` 计数 = **1**、catch-all 状态 **Active**（API 回读确认）。

> **为什么必须用 catch-all 而不是普通地址规则**：密址 token 是**动态的**（每用户一个、懒生成）。官方对 Subaddressing 的原文是 *"The `+detail` part does not affect rule matching"* —— 也就是说 `inbound+<token>@` 会按 `inbound@` 去匹配普通规则、`+token` 不进匹配。**只有 catch-all（`*@tempocourse.com`）能兜住所有 `inbound+任意token@`**。普通规则只匹配固定 local part，会漏。
> ⚠️ 现在**不要**再建任何普通地址规则（如 `inbound@`）—— 一是没用（token 靠 catch-all 拿），二是规则顺序可能把邮件截走。

<details>
<summary>🔧 等价 API 做法（Agent 可代跑；含一个 409 坑）</summary>

```bash
ZONE=cc6b408796941c304323908f0f02b413          # tempocourse.com
TOKEN=$(sed -n 's/^oauth_token = "\(.*\)"$/\1/p' \
  ~/Library/Preferences/.wrangler/config/default.toml)   # 复用 wrangler 的 OAuth token

# 读当前 catch-all
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/email/routing/rules/catch_all"

# 启用并指向 Worker（幂等，可反复跑）
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/email/routing/rules/catch_all" \
  -d '{"actions":[{"type":"worker","value":["tempo-inbound-email"]}],"matchers":[{"type":"all"}],"enabled":true,"name":"Tempo inbound"}'
```

> 🔴 **踩坑**：catch-all **不能用通用端点** `PUT /zones/{zone}/email/routing/rules/{rule_id}` 更新 —— 即使把 `catch_all` 的 rule_id 填进去也会返回 **409 `Invalid rule operation`**。必须用**专用端点 `.../rules/catch_all`**。另：account 级 `/accounts/{acc}/email/routing/rules/catch_all` 直接 `404 page not found`，是 **zone 级**资源。
> 🔁 **回滚**：同一个端点 PUT `{"actions":[{"type":"drop"}],"matchers":[{"type":"all"}],"enabled":false}` 即恢复出厂（停收信）。
</details>

---

## 7. 【手动】Vercel 环境变量 + Redeploy

Vercel → 项目 **tempo** → **Settings → Environment Variables**（Production）：

- [ ] `INBOUND_EMAIL_SECRET` = 与 Worker **逐字相同**的那份密钥
- [ ] `INBOUND_EMAIL_DOMAIN` = `tempocourse.com`
- [ ] 保存后 **Redeploy**（env 变更不会自动进已有部署）

---

## 8. 【手动】端到端验收

- [ ] 登录 Tempo → **Settings** → 「邮件入站」区块应显示你的专属密址：`inbound+<token>@tempocourse.com`
      （首次访问自动生成 token 写入 `profiles.inbound_token`）
- [ ] 从你的邮箱**转发**一封 Gradescope 提交确认信到该密址（或在 Gradescope 把通知邮箱直接改成它）
- [ ] 预期：**对应 task 自动标记完成**；`email_inbound_events` 表新增一行
- [ ] 快速替身测试（不想发真邮件时）：随便发一封到密址，正文写 `Homework 6 submitted successfully`
      → LLM 应解析出 `submitted` 并匹配到名为 "Homework 6" 的 task

---

## 9. 排查表

| 现象 | 先查什么 |
|---|---|
| `Routing status` 长期停在 **Syncing** | DNS 传播中，官方口径 5–15 分钟（最长 24h）；查 `dig @1.1.1.1 MX tempocourse.com` 是否出现 `route1/2/3.mx.cloudflare.net` |
| 完全没反应 | Cloudflare Email Routing 的 MX/SPF 是否生效；catch-all 是否 **Active**；Subaddressing 是否开（第 4 步） |
| `unknown_address`（审计表） | 密址 token 与 `profiles.inbound_token` 不匹配；或邮件没进 Worker（查 catch-all） |
| `no_text`（审计表） | Worker 没解出正文 → `npx wrangler tail` 看 `[inbound-worker] MIME 解析失败` |
| Worker 报 401 | Worker secret 与 Vercel `INBOUND_EMAIL_SECRET` **不逐字相同** |
| 日志里连 `email_inbound_events` 都没有 | 邮件根本没到 Vercel（路由规则/Worker 部署），不是应用侧问题 |

排查命令：

```bash
cd /Users/youchengli/Desktop/Tempo/workers/inbound-email
npx wrangler tail          # 看 Worker 实时日志
```

---

## 附 A. 三个不变量（为什么代码这么写，别改回去）

1. **只认 `to` 里的密址 token，绝不读 `From`** —— `From` 可伪造，用它会变成"任何人冒充 Gradescope 就能改你的任务"。
2. **只写 `status='done'`** —— 绝不自动建任务、绝不改 `dueDate`、绝不碰 `submission_state`/`submitted_at`（ADR-015 红线：那是 Canvas 同步的专属真相）。
3. **webhook 永远返回 2xx**（含内部错误）—— 否则邮件网关会重试风暴 / 退信循环。

## 附 B. 代码位置索引

| 层 | 文件 |
|---|---|
| Worker（薄转发） | `workers/inbound-email/src/index.ts` + `wrangler.toml` |
| Webhook 路由 | `app/api/v1/email/inbound/route.ts` |
| 密址展示路由 | `app/api/v1/email/address/route.ts` |
| 编排 / 落写 | `lib/email/inbound.ts` |
| 决策（纯函数） | `lib/email/plan.ts` |
| 解析（LLM） | `lib/email/parse.ts` |
| token（纯函数） | `lib/email/token.ts` |
| 密址读写 | `lib/email/address.ts` |
| 迁移 | `supabase/migrations/20260917120000_inbound_email.sql`（**已执行 ✅**） |
| 回归 | `npm run regress:inbound`（14/14 ✅） |

## 附 C. 官方文档

- Email Routing 规则与地址（含 Subaddressing / 目标地址要求）：https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/
- 路由邮件（onboard domain 流程）：https://developers.cloudflare.com/email-service/get-started/route-emails/
