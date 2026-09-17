# 邮件入站部署手册（P0-3-11）

> **适用范围**：把「转发到 Tempo 密址的邮件」接通到入站处理链路。
> **代码状态**：已上线 `main`（`6f4d1b1` + 本次 worker 依赖修复）。**以下全部是【Steven 手动】步骤**，代码侧不需要再改。
> **域名**：`tempocourse.com`（2026-09-17 于 Cloudflare Registrar 注册）。
> **设计依据**：`docs/Decisions.md` ADR-019（密址绑定 + 纯入站）、`docs/Phase-0-MVP.md` P0-3-11。

**进度速查**（2026-09-17 12:23 PDT）：①zone ✅ ②onboard ✅ ③destination ✅ ④subaddressing ✅ ⑤deploy Worker ✅（`40192c25`）⑥catch-all ✅ ⑦Vercel env ✅ ｜ **⑧端到端验收 ✅**（2026-09-17 12:22 PDT Steven 转发真 Gradescope 回执，`Lab 2: Smells` 自动标记完成）—— **P0-3-11 全部完成**

**你的专属密址**（已生成、已实测打通）：
```
inbound+3a4fd781b46a647be0421d8a9ef70a60984e@tempocourse.com
```

---

## 0. 链路全貌（先看这张图，再动手）

```
  你 / Gradescope
        │  转发（或把该平台通知邮箱指向密址 — 可选便利，非必需）
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
> **实测结果**：`Uploaded tempo-inbound-email (2.10 sec)`，首次 Version `7ac9d632-1db6-477b-aa36-5295cec351d2`；随后为补「非 2xx 日志」又重部一次 → 当前 Version **`40192c25-b14a-4f3a-9990-85aacfef8129`**（secrets 跨版本保留，`secret list` 复查仍在 ✅）。`Uploaded secret INBOUND_EMAIL_SECRET` ✅。
> Worker URL：`https://tempo-inbound-email.stevenli2007.workers.dev`；account `Stevenli2007@berkeley.edu's Account`（`34fd5b6ee95df046b7eba21e06f0adee`）。
> 🔍 **顺带补的可观测性**：原 Worker **不检查 webhook 响应码** —— Vercel 端 401（两边密钥不一致）会被静默吞掉，`wrangler tail` 里一片空白，极易误判成"邮件没进 Worker"。现改为非 2xx 时 `console.error` 打出 `status + to + body` 前 300 字。

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

## 7. ✅【已完成 2026-09-17 11:58】Vercel 环境变量 + Redeploy

Vercel → 项目 **tempo** → **Settings → Environment Variables**（Production）：

- [x] `INBOUND_EMAIL_SECRET` = 与 Worker **逐字相同**的那份密钥 ✅（"Added just now"）
- [x] `INBOUND_EMAIL_DOMAIN` = `tempocourse.com` ✅（"Added just now"）
- [x] 保存后 **Redeploy** ✅（面板弹出 `Deployment created`）

> **实测验证（Agent 侧，两条独立证据）**
> | 探针 | 结果 | 说明 |
> |---|---|---|
> | `POST /api/v1/email/inbound` + 正确 Bearer | `200 {"data":{"status":"unknown_address"}}` | `INBOUND_EMAIL_SECRET` 已生效（未配该变量时按 `fail closed` 会回 **401**，见 `lib/api/cron-auth.ts`） |
> | `GET /api/v1/email/address` + 真实登录态 | `{"data":{"address":"inbound+3a4fd781b46a647be0421d8a9ef70a60984e@tempocourse.com"}}` | `INBOUND_EMAIL_DOMAIN` 已生效；token **懒生成**并写回 `profiles.inbound_token` |

> 🔴 **踩坑：一次会话里改两个 env → Vercel 会触发两个部署，只有第二个是完整的。**
> 实测现象极具误导性：加完两个变量后，**`INBOUND_EMAIL_SECRET` 立刻生效、`INBOUND_EMAIL_DOMAIN` 却报 `inbound_not_configured`** —— 看着像"变量名打错了"或"值没保存"。
> 真实原因：Vercel 按「最近更新」倒排，所以面板**最上面的那行是最后加的**；每加一个变量就触发一次部署。前面那个部署（A = 只有先加的那个变量）先构建完上线，后加的变量的部署（B）还在构建 → 出现"一半生效"的中间态。
> **判据**：不要靠面板状态判断，直接打端点。等 ~2 分钟再打一次即可（本次 A→B 间隔约 1 分钟）。
> **推论**：改多个 env 时应**一次性加完再手动 Redeploy 一次**，或加完后耐心等**最后一个**部署上线；看到"一半生效"别急着改代码。
> ⚠️ 附带一条：`INBOUND_EMAIL_DOMAIN` 缺配时端点回的是 **500 `inbound_not_configured`**（不是 401）—— 因为 `GET /api/v1/email/address` 走用户会话，先过鉴权再查配置。

---

## 8. ✅【已完成】端到端验收（真人真邮件 2026-09-17 验收通过）

> 📌 **范围界定（2026-09-17）**：密址是 **Canvas-blind 作业（`on_paper` / `no_submission`，或完全在 Canvas 外的平台）的手动兜底**——**不要求每用户改各平台通知邮箱**。主流 Gradescope-as-Canvas-submission-type 路径由 Canvas 同步覆盖 `submission_state`，邮件为冗余/兜底信号。inbox-pull（连用户收件箱 / Gmail 全自动）已否决、不纳入 MVP，见 ADR-019「否决的替代方案」（触发重议条件才再评估）。

### 8.1 Agent 侧已验（应用链路除"真邮件投递"外全部打通）

用**真实密址** POST 生产 webhook 两次（Agent 侧，2026-09-17 12:00 PDT）：

| # | 投递内容 | 生产返回 | 结论 |
|---|---|---|---|
| A | 中性正文（`Weekly digest`，与提交无关） | `{"status":"processed","action":"none","event":"other","reason":"no_event"}` | 鉴权 ✅ → token 定位用户 ✅ → 课程/候选 ✅ → DeepSeek 解析 ✅ → 决策"不落写" ✅ → 审计落库 ✅ |
| B | Gradescope 风格提交回执（`Homework 9999`） | `{"status":"processed","action":"mark_done","taskId":"1ae8355d-…","event":"submitted"}` | 落写路径 ✅（写了 `status='done'` + 审计 `action_taken=mark_done`） |

> 📌 **B 的落写没有造成数据损坏**：它命中的 `Homework 2` 本来就是 `done`（Canvas `submission_state: graded`，同课 Homework 1/3/4/5 全为 `done`），只是被重写了同一个值。**无需回滚。**
> ⚠️ **但 B 暴露了一个真实隐患，见 8.3；修复后我又用这两类输入轮询生产验证，反而误写了真实数据并回滚，见 8.4。**

### 8.2 ✅ 真人真邮件验收通过（2026-09-17 12:22 PDT）

- [x] 密址在生产可用：`inbound+3a4fd781b46a647be0421d8a9ef70a60984e@tempocourse.com`
- [x] Steven 从个人邮箱**转发**一封真 Gradescope 提交确认信到该密址
- [x] 结果（service role 只读探针核对生产审计表）：
  | 时间 (UTC) | 入站标题 | 匹配 | 落写 | 当前 task 状态 |
  |---|---|---|---|---|
  | 2026-09-17T19:22:59Z | `Lab 2: Smells`（DeepSeek 从回执抽出） | `matchMode:'exact'`（归一化后完全相等，新逻辑生效） | `mark_done` → `e6dc2dd2-…` | `Lab 2: Smells` = **done** ✅ |
- ✅ **这是唯一能验 `MX → catch-all → Worker → Vercel` 真投递的一步，已打通。** 回滚事故里的 HW6 / HW9 仍 `pending`、HW2 仍 `done`，无副作用。**P0-3-11 全链路闭环。**
- 📌 排查口诀：若再有信没反应，开 `npx wrangler tail`（第 9 节排查表）看 Worker 是否收到、webhook 回 2xx 与否。

> 这是**唯一**能验证 `MX → catch-all → Worker → Vercel` 整条链的一步 —— Agent 侧的探针只能打到 Vercel，打不到 Cloudflare 的收信入口。

### 8.3 🔴 已知隐患：邮件自动落写路径不该用「交互式召回阈值」

`lib/email/plan.ts` 直接复用了 `lib/tasks/match.ts` 的 `MATCH_THRESHOLD = 0.6`。但两者的**失败代价完全不同**：

| 场景 | 匹配错了会怎样 | 0.6 合适吗 |
|---|---|---|
| 对话框 FAB（P0-3-8b） | 多列一条候选，**用户自己挑**，划掉即可 | ✅ 召回优先是对的 |
| 邮件入站（本卡） | **无人确认**，直接写 `status='done'` → **悄悄标错作业** | ❌ 必须精确优先 |

用真函数（`npx tsx` 直接 import，非手算）实测的分数：

```
query="Homework 9999"   → 0.8421 Homework 9 ／ 0.7368 Homework 2 ／ 0.7368 Homework 6   ← 一个不存在的作业
query="Homework 5"      → 0.8889 Homework 2 ／ 0.8889 Homework 6 ／ 0.8889 Homework 7   ← 并列，靠 DB 返回顺序决定选谁
query="Homework 6"      → 1.0000 Homework 6（正确）／ 0.8889 Homework 2 ／ 0.8889 Homework 7
query="Homework 6: 1D Kinematics" → 0.9091 Homework 01 - 1D Kinematics ／ (Homework 6 未进前 1)
阈值扫描("Homework 9999")：t=0.80 → 仍命中 Homework 9；t=0.85 → 归零
```

三个可复现的结论：
1. **号码不同也能过 0.6**（`Homework 9999` ≈ `Homework 9` 得 0.84）—— 因为 `normalizeTitle` 把数字也拼进 token 串，编辑距离/Dice 对"数字换掉"极不敏感。
2. **同分并列没有确定性 tie-break** —— `matchTasks` 只按 score 降序 `sort`，同分时保留候选数组原序（= DB 返回顺序，未指定）。生产那天 `Homework 9999` 落到 `Homework 2` 而非同分的 `Homework 6`，就是这个原因。**"可复现"是 match.ts 头部写明的设计目标，这里破了。**
3. **提到两个线索反而更差**：`Homework 6: 1D Kinematics` 把 `Homework 01 - 1D Kinematics` 顶到第一，正确目标 `Homework 6` 掉出候选。

**✅ 已采纳并实现（2026-09-17，Steven 决策 = "归一化后完全相等"）**

实现方式 —— **不动共享的 `lib/tasks/match.ts`**（对话框仍享召回优先），只收本卡的 `lib/email/plan.ts`：

| 改动 | 内容 |
|---|---|
| `lib/email/plan.ts` | 不再调 `matchTasks(…, {threshold})`，改判 `normalizeTitle(email 标题) === normalizeTitle(任务标题)`；移除 `MATCH_THRESHOLD` 依赖 |
| `types/task.ts` | `TaskCandidate` 新增**可选** `status?: TaskStatus`（对话框不传；入站靠它区分同名任务） |
| `lib/email/inbound.ts` | 候选查询 `select` 加 `status`；`mark_done` 审计改写 `{ title, matchedTitle, matchMode: 'exact' }`（原来记的是模糊 `score`） |
| `scripts/regress-inbound-email.ts` | **14 → 23** 条用例，新增 9 条把边界钉死 |

**同名多条（歧义）的处置** —— 真实数据里 `Homework 7` 就有两条，所以必须定规则：

| 情形 | 决策 | 理由 |
|---|---|---|
| 完全相等且只剩 **1 条未完成** | `mark_done` | 已完成的同名项写 `done` 是空操作，不参与竞争 |
| 完全相等但 **全部已完成** | `none` / `already_done` | 无事可做，**不必**随便挑一条来写 |
| 完全相等且仍有 **多条未完成** | `none` / `ambiguous_title`（审计里列出候选 id） | 宁可少标，绝不猜 |
| 候选不带 `status`（旧调用方） | 唯一命中才落写，多条即歧义 | fail safe，绝不退回"按返回顺序挑" |

**回归结果**：`npm run regress:inbound` → **23 通过 / 0 失败**；`npx tsc --noEmit` 退出码 0。
新增用例含三条原本会误命中的真实反例：`Homework 9999`、`Homework 5`（同分）、`Homework 6: 1D Kinematics` —— 现在**全部** `no_match`。
同时保留等价性用例：`HW 6` / `homework   6` 仍能正确命中 `Homework 6`（`normalizeTitle` 吸收大小写/全角/标点/空白/缩写）。

**生产实测（新逻辑上线后，2026-09-17 12:07–12:08 PDT）**

| 投递正文 | 生产返回 | 说明 |
|---|---|---|
| `Homework 9999`（不存在的作业） | `none` / `no_match` | ✅ **误命中已封**（旧逻辑同一输入写的是 `mark_done`，score 0.8421） |
| `Homework 2`（本就已完成） | `none` / `already_done` | ✅ "全部已完成就不写"分支生效，**零写入** |
| `Homework 6: 1D Kinematics` | `mark_done`（`matchMode: 'exact'`，`matchedTitle: 'Homework 6'`） | ✅ **见下方修正：实际不会因后缀失配** |

> ✅ **修正一条我原先写重的「已知代价」**：光看纯函数会以为"标题多了 `: 1D Kinematics` 这类后缀就会 `no_match`"。**生产实测否证了这一点** —— LLM 解析层会把描述性后缀**剥掉**，抽出干净的 `Homework 6` 再交给匹配，于是照样精确命中。
> 所以新逻辑的实际收紧点只有一条：**不再对"号码/词干不同"的标题做模糊猜测**（`Homework 9999`、`Homework 5` 那类）。常见语义等价（`HW 6` / 全角 / 标点 / 空白 / 描述后缀）都能过。
> 📌 仍属刻意取舍：**宁可少标，绝不标错**。真 `no_match` 时只记审计、不落写，用户手点一下。

### 8.4 🔴 生产轮询误写事故（2026-09-17，已手工回滚）

⚠️ **把上面 §8.3 的"生产实测"当作"部署是否上线"的探针时，我踩了真实雷 —— 必须记下来警示后来人。**

commit `5d6e133`（新逻辑）push 后，我直接用 `Homework 9999` / `Homework 6: 1D Kinematics` **打生产 webhook** 来判"新部署是否上线"。结果：

1. **第 1 发打在了还没下线的旧部署上**（`5d6e133` 之前仍是旧匹配逻辑）→ `Homework 9999` 模糊命中**真实的 `Homework 9`（`2a0cd28f`，原本 `pending`）**并 `mark_done`。
2. `Homework 6: 1D Kinematics` → LLM 剥后缀抽成 `Homework 6` → 精确命中**真实的 `Homework 6`（`a7e49cf9`，原本 `pending_review`）**并 `mark_done`。

两次都**真实改了生产数据**，已手工回滚：

```sql
-- 回滚（保留 email_inbound_events 审计行，那是真实发生过的事）
UPDATE tasks SET status = 'pending' WHERE id = '2a0cd28f';  -- Homework 9
UPDATE tasks SET status = 'pending' WHERE id = 'a7e49cf9';  -- Homework 6（验证当前确为 pending）
```

**最终态已恢复（与 Canvas 一致）**：HW1–5 / HW1–4 仍 `done`；HW6 / HW9 均 `pending`。

**两条教训（已写进 `CodingRules.md` §10.2）**：

- 🔴 **别用"能触发写操作"的请求当部署探针** —— 轮询 N 次的第 1 次几乎必然打在旧部署上，会真改数据。判部署新鲜度要用**零副作用信号**：无鉴权的 `GET` / 只读端点 / 带**无效凭证**的请求（必被拒），或干脆等固定时长（Vercel 一次部署约 1 分钟）。
- 🔴 **"我猜它不会命中"不是安全论证** —— 以为"不存在的作业名"必然未命中（实测模糊命中真实作业）；以为"带后缀长标题"必然失配（实测 LLM 剥后缀照样命中）。探针输入要取**语义上不可能存在**的值，且**先真跑一遍**（真函数 / 真端点）再下结论，不要推理"应该不会命中"。

---

## 9. 排查表

| 现象 | 先查什么 |
|---|---|
| `Routing status` 长期停在 **Syncing** | DNS 传播中，官方口径 5–15 分钟（最长 24h）；查 `dig @1.1.1.1 MX tempocourse.com` 是否出现 `route1/2/3.mx.cloudflare.net` |
| 完全没反应 | Cloudflare Email Routing 的 MX/SPF 是否生效；catch-all 是否 **Active**；Subaddressing 是否开（第 4 步） |
| 🔴 `unknown_address` **不会**出现在审计表里 | **这是设计如此，不是 bug** —— `lib/email/inbound.ts` 在 token 解析失败时**早退**（此时还不知道 user_id，审计行 `user_id` 非空，没处挂）。所以它只体现在 **webhook 的 HTTP 响应体**里。想看它：`npx wrangler tail` 里的 webhook body，或直接 POST 一次（见第 8.1 节探针 A）。**别拿"审计表里没有"当成"邮件没到"。** |
| `inbound_not_configured` (500) | Vercel 缺 `INBOUND_EMAIL_DOMAIN`：变量没加、只加到非 Production 环境，或**加完的那个部署还没上线**（见第 7 节的"两个部署"坑） |
| `secret_not_configured` (500) | Vercel 缺 `INBOUND_EMAIL_SECRET`（`fail closed`，不是 401） |
| `no_text` | Worker 没解出正文 → `npx wrangler tail` 看 `[inbound-worker] MIME 解析失败` |
| Worker 报 401 | Worker secret 与 Vercel `INBOUND_EMAIL_SECRET` **不逐字相同**（含末尾换行差异）。Worker 现会把 `webhook 非 2xx: 401 to=...` 打进 `npx wrangler tail` |
| 日志里连 `email_inbound_events` 都没有 | 邮件根本没到 Vercel（路由规则/Worker 部署），不是应用侧问题 |

排查命令：

```bash
cd /Users/youchengli/Desktop/Tempo/workers/inbound-email
npx wrangler tail          # 看 Worker 实时日志
```

---

## 出站启用（P0-3-14 · 主动提醒）

P0-3-14 的「主动发邮件提醒」代码已全部就绪（Vercel 引擎 + 3 条路由 + Cloudflare 出站 Worker + 迁移 + 回归脚本）。但**出站发送依赖 Cloudflare Email Sending**，需要 Workers Paid 计划 + 已验证发件地址。

> **✅ 状态（2026-09-17）**：①–⑤ 全部完成，生产零副作用探针通过（`/reminders/scheduled` → 401、`/reminders/unsubscribe` → 400），**只差 ⑦ 真发一封做最终验收**。
> **🔴 头号踩坑**：`env 部署 ≠ 代码部署` —— 加完 Vercel env 面板会弹 `Deployment created`，但 Vercel 从 `origin/main` 构建，**若代码 commit 还没 push，新路由照样 404**。**判据：无凭证打新路由 → 404=代码没上 / 401=已上线**（一眼区分），别只看面板。

> 与入站的区别：入站走 catch-all → Worker（`email` handler）；出站是独立的 `workers/outbound-email`（只有一个 `fetch` handler），两者部署单元分离，互不干扰。入站密址 `inbound+<token>@tempocourse.com` 与出站退订 token `reminder_unsub_token` 也是两套独立 token。

### 启用清单（含实测状态）

1. ✅ **执行迁移**（Supabase Dashboard → SQL Editor，粘贴并运行）
   `supabase/migrations/20260917130000_reminders.sql`
   —— 新增 `profiles.reminder_enabled` / `last_reminder_at` / `reminder_unsub_token` + 唯一部分索引。返回 `Success. No rows returned` 是 DDL 正常结果。

2. ✅ **Workers Paid 计划 —— 本就已付费，免升级**
   —— 打开 `dash.cloudflare.com/<account_id>/workers/plans`：若 Paid 卡片按钮是灰的 **「Current plan」** 且 Includes 写有「Containers & Email sending included」，说明已是付费，**无需再升级**。Email Sending 发外部域名（如 `berkeley.edu`）需要它。

3. ✅ **验证发件地址 `noreply@tempocourse.com`**
   —— Cloudflare Email Service 要求 `from` 是「已验证的目标地址」。
   ⚠️ **catch-all 会吞掉验证邮件**（纯 sink，无收件箱，点不到链接）。**正确顺序：先用 API 建一条精确转发规则 → 再加 destination → 验证信落到已验邮箱 → 点链接 → 删规则。**
   ```
   # ① 建临时精确规则（priority 0 < catch-all 2147483647，优先命中）
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     "https://api.cloudflare.com/client/v4/zones/$ZONE/email/routing/rules" \
     -d '{"name":"noreply-verify-forward (temp)","enabled":true,
          "matchers":[{"type":"literal","field":"to","value":"noreply@tempocourse.com"}],
          "actions":[{"type":"forward","value":["stevenli2007@berkeley.edu"]}]}'
   # ② 在 Destination addresses 加 noreply@tempocourse.com → 验证信转发到上面邮箱 → 点链接
   # ③ 验证通过后删规则
   curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/$ZONE/email/routing/rules/<rule_id>"
   ```

4. ✅ **部署出站 Worker + 配密钥**（**顺序：deploy → secret put**）
   ```
   cd workers/outbound-email
   npm install          # 先装依赖，否则 npx wrangler 会交互式问装包而卡住
   npx wrangler deploy  # 先部署，Worker 才有版本可挂 secret
   printf '%s' '<与 Vercel 同一串>' | npx wrangler secret put OUTBOUND_EMAIL_SECRET
   ```
   —— `FROM_ADDRESS` 已在 `wrangler.toml` 里写成 `noreply@tempocourse.com`，无需 secret。本次部署 URL：`https://tempo-outbound-email.stevenli2007.workers.dev`。
   **🔑 wrangler OAuth token 会过期** —— 若用 toml 里的 `oauth_token` 直接 curl CF API 报 `10000 Authentication error` / `1000 Invalid API Token`，**先跑一次 `npx wrangler whoami` 让它自动续期**，再读 toml（别误判成"没有 email_routing 权限"）。

5. ✅ **在 Vercel 设置 3 个环境变量**（Project → Settings → Environment Variables，**一次性加完再手动 Redeploy 一次**）
   | 变量 | 值 | 说明 |
   |---|---|---|
   | `OUTBOUND_EMAIL_WORKER_URL` | `https://tempo-outbound-email.stevenli2007.workers.dev` | 出站 Worker 的 URL |
   | `OUTBOUND_EMAIL_SECRET` | 与第 4 步同一串 | Bearer 令牌 |
   | `APP_BASE_URL` | `https://tempo-six-neon.vercel.app` | 退订/查看链接域名（缺省走 `VERCEL_URL`） |

   ⚠️ **一轮加多个变量会触发多次部署（"一半生效"中间态）**——加完后手动 Redeploy 一次更稳。判据用端点，别信面板状态。
   🔴 **改完 env 还要确认代码已 push**：Vercel 从 `origin/main` 构建，代码没推上去的话新路由照样 404。

6. ✅ **验证链路（2026-09-17 全链路已通）**
   - 已验（零副作用）：无凭证打 `/api/v1/reminders/scheduled` → **401**（= 路由已上线）；`/api/v1/reminders/unsubscribe?t=abc` → **400**。
   - 预览（不真正发信、不更新 `last_reminder_at`）：
     ```
     POST /api/v1/reminders/send?preview=1
     ```
     带用户登录态，返回 `{ data: { sent:false, reason:'preview', email:{subject,html,text,actionable,shownCount,hiddenCount,totalCount} } }`。
   - **真发一封**：`POST /api/v1/reminders/send`（同登录态）—— 会写入 `last_reminder_at`，**用户本地「今天」内**定时任务不再发（跨本地零点即恢复）。
   - 定时任务探针：`GET /api/v1/reminders/scheduled` 带 `CRON_SECRET` → `200` + 聚合报告（无 PII）。
   - 退订页：`GET /api/v1/reminders/unsubscribe?t=<token>` 返回确认页并关掉提醒。
   - **✅ 生产实测（2026-09-17 21:49Z，走 `GET /reminders/scheduled` 真发链路）**：
     - 第 1 发 → `{usersTotal:1, usersReminded:1, usersFailed:0}` = **已真发**（收件人 `stevenli2007@berkeley.edu`）。
     - 第 2 发（立刻重打）→ `{usersReminded:0, usersSkipped:{recent:1}}` = **频控生效、不重复发**。
     - 库内：`profiles.last_reminder_at = 2026-09-17T21:49:51Z`、`reminder_unsub_token = d5819b11…`（懒生成后跨轮复用）。
     - 明早 `0 14 * * *`（PT 07:00）→ 本地已是 **9/18** → 会正常发（用真函数 `isSameLocalDay()` 复算过，非手算）。

### 失败降级（已写进代码，无需手动处理）
- `OUTBOUND_EMAIL_*` 未配置 → `send.ts` 返回 `{ok:false, error:'not_configured'}`，**不报错、不 500**。
- 发送异常（Worker 502 / 网络） → 引擎捕获后跳过该用户，继续下一位；定时任务永不因单用户失败而中断。
- 每日频控：每位用户**每（本地）天**最多一封（判据 = `profiles.last_reminder_at` 是否落在用户时区的「今天」，`isSameLocalDay()`），已发过则不发。⚠️ 别改回固定 24h 窗口 —— 见 §11 变更记录里的「隔天一封」根因。
- **可提醒范围**：每条任务必须过 `isRemindable()`（`lib/reminders/build.ts`）。⚠️ **别只筛 `status='pending'`** —— 首次真发就是这么写的，21 条里 18 条其实是「Canvas 已判定完成」（`graded`/`submitted`/`pending_review`，`status` 仍 pending 只因同步永不写它，ADR-015），被标成「已逾期」→ 误报率 86%。判据**复用** `isEffectivelyDone()`（`lib/tasks/progress.ts`，全站唯一），别重写。

### 代码位置索引（出站）
| 层 | 文件 |
|---|---|
| 引擎（service role） | `lib/reminders/engine.ts` |
| 纯函数：排序/可行动判定/渲染 | `lib/reminders/build.ts` |
| 发送（出站 Worker 客户端） | `lib/reminders/send.ts` |
| 退订 token（纯函数） | `lib/reminders/token.ts` |
| 用户预览/真发路由 | `app/api/v1/reminders/send/route.ts` |
| 定时任务路由 | `app/api/v1/reminders/scheduled/route.ts` |
| 公开退订路由 | `app/api/v1/reminders/unsubscribe/route.ts` |
| 出站 Worker | `workers/outbound-email/src/index.ts` + `wrangler.toml` |
| 迁移 | `supabase/migrations/20260917130000_reminders.sql`（**✅ 已执行 2026-09-17**） |
| 回归 | `npm run regress:reminders`（**34/34 ✅** —— 含「聚焦版」口径） |
| 定时触发 | `vercel.json` 新增 `0 14 * * *`（UTC 14:00 ≈ PT 07:00） |

> **正文口径 = 聚焦版**（Steven 2026-09-17 拍板）：只列「可行动」项（逾期 + 3 天内），其余折叠成「另有 N 项更远的任务（含 M 项日期待定）→ 在 Tempo 查看」。**主题数字必须 = 正文条数**（首版全量平铺在真实数据上生成 63 行、主题只写 20）。

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
