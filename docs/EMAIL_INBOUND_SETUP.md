# 邮件入站部署手册（P0-3-11）

> **适用范围**：把「转发到 Tempo 密址的邮件」接通到入站处理链路。
> **代码状态**：已上线 `main`（`6f4d1b1` + 本次 worker 依赖修复）。**以下全部是【Steven 手动】步骤**，代码侧不需要再改。
> **域名**：`tempocourse.com`（2026-09-17 于 Cloudflare Registrar 注册）。
> **设计依据**：`docs/Decisions.md` ADR-019（密址绑定 + 纯入站）、`docs/Phase-0-MVP.md` P0-3-11。

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

## 1. 【手动】等域名 zone 生效

- [ ] Cloudflare Dashboard → **Domains → Overview → `tempocourse.com`**，状态为 **Active**。
  - Registrar 直接买的域名通常几分钟内自动建好 zone，无需手填 NS。
- [ ] 本地验证（应返回 `*.ns.cloudflare.com`，也可能出现 `pending` 的旧 NS）：

```bash
dig +short NS tempocourse.com
```

> ⚠️ 注册后短时间内 `dig` 报 `NXDOMAIN` **是正常的**（2026-09-17 10:34 实测仍为 NXDOMAIN），等几分钟到几小时。**NS 没生效前，第 2 步的 Email Routing 打不开。**

---

## 2. 【手动】开启 Email Routing（onboard domain）

- [ ] Dashboard 路径（2026-06 后的新面板）：**Compute → Email Service → Email Routing**。
  - 若面板里找不到，试旧路径：**Email → Email Routing**（同一功能，入口位置改过）。
- [ ] 点 **Onboard Domain** → 选 `tempocourse.com`。
- [ ] 复核 Cloudflare 自动要加的 DNS 记录 → **Done**：
  - `MX` → `route1.mx.cloudflare.net` 等（收信入口）
  - `TXT`（SPF）→ 授权 Email Routing 发信
  - `TXT`（DKIM）→ 转发邮件的发信认证

> 这三条是 Cloudflare 自动加的，确认即可，不要手改。

---

## 3. 【手动】加一个「目标地址」并验证（硬性门槛）

- [ ] **Destination Addresses** → 填你能收信的邮箱（如 `stevenli2007@berkeley.edu`）→ 提交。
- [ ] 去该邮箱收 Cloudflare 验证信 → 点 **Verify email address**。

> 🔴 **官方明确要求**：在建任何路由规则之前，**必须**至少有一个已验证的目标地址；未验证前，指向它的规则**保持 disabled**。
> 我们的密址**不经过**这个收件箱（邮件进的是 Worker），但这一步是**开通 Email Routing 的前置门**，绕不过。

---

## 4. 【手动】🔴 打开 Subaddressing（`+` 子地址）—— 最容易漏的一步

- [ ] **Email Routing → Settings → Subaddressing**（`+` addressing）→ 打开。

> **为什么必须开**：我们的密址形态是 `inbound+<token>@tempocourse.com`。官方说明只有**开启后**，`+detail` 部分才会**保留在 `message.to` 里**供 Worker 读取。不开的话 token 有被规则匹配"吃掉"的风险 → Worker 拿不到 token → 入站静默失败。
> 参考：Cloudflare Docs「Email routing rules and addresses」→ Subaddressing（RFC 5233）。

---

## 5. 【手动】部署 Worker

```bash
cd /Users/youchengli/Desktop/Tempo/workers/inbound-email
npm install                                   # 装 postal-mime + wrangler
npx wrangler login                            # 浏览器 OAuth 登录 Cloudflare
npx wrangler secret put INBOUND_EMAIL_SECRET  # 粘贴密钥（与 Vercel 同一份）
npx wrangler deploy
```

- [ ] 部署成功，Cloudflare → **Workers & Pages** 里出现 **`tempo-inbound-email`**。
- 不需要改 `wrangler.toml`：`INBOUND_WEBHOOK_URL` 默认已指向 `https://tempo-six-neon.vercel.app/api/v1/email/inbound`。
- **本地已验证**（2026-09-17）：`npm install` ✅、`postal-mime@2.7.6` 的 `PostalMime.parse` 返回 `{text, html}` ✅、`wrangler deploy --dry-run` 打包成功（109 KiB，`INBOUND_WEBHOOK_URL` 绑定正常）✅。

---

## 6. 【手动】Catch-all 规则 → Worker（关键）

- [ ] **Email Routing → Routing Rules → Catch-all rule → Enable**。
- [ ] **Action: Send to a Worker** → 选 `tempo-inbound-email` → **Save**。

> **为什么用 catch-all 而不是普通地址**：密址的 token 是**动态的**（每用户一个，懒生成），只有 catch-all（`*@tempocourse.com`）能兜住 `inbound+任何token@`。普通规则只匹配固定 local part，会漏。

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
