# Phase-0-MVP.md — Phase 0 执行清单

> **本文档是「逐个 check」的对象。** 每个 task 完成后停下，交 Steven 验收；通过才做下一个。
> 需求细节见 [`PRD.md`](./PRD.md)，阶段 Gate 见 [`Roadmap.md`](./Roadmap.md)，开发行为约束见 [`CodingRules.md`](./CodingRules.md)。

---

## 使用方式

**workflow（强制）**
1. Bud 领一个 task → 读下方该 task 的**执行卡**（AI 开工最小上下文，不必重读全部文档）→ 实现 → 自测
2. 交付时报告三件事：**改了什么 / 自测结论 / 下一步**
3. Steven check → 通过 → 下一个 task；不通过 → 原地返工
4. 一个 task 未通过前，**不启动下一个**

**执行卡机制**：每个阶段表格下方附「执行卡」小节，含做什么 / 改哪些文件 / 关键约束 / 验收命令 / 交接点。**交接点 = 需要 Steven 手动操作的步骤**（建账号、填密钥、点按钮等），AI 到交接点就停，不空转等待。已完成的 task 执行卡标注「勿重做」，防止下次会话重做。当前已覆盖 P0-0，后续阶段做到时再补卡。

**编号规则**：`P0-<里程碑>-<序号>`
- `P0-0-x` 基础设施
- `P0-1-x` M1 — 静态理解（syllabus 解析）
- `P0-2-x` M2 — 动态感知（数据源同步）
- `P0-3-x` 验证与收尾

**状态**：⚪ 未开始 ｜ 🔵 进行中 ｜ 🟡 阻塞 ｜ ✅ 已通过 ｜ ⏸ 暂缓 ｜ ⛔ 条件性（可能不需要做）

**Owner**：`Bud` = Bud 实现 ｜ `Steven` = Steven 执行 ｜ `共担` = 需双方配合

---

## 当前进度指针

**当前 task**：`P0-0-6` Vercel 部署 —— **代码/部署已完成**，剩 Steven 两步：① Supabase URL Configuration 加生产域名 ② 生产冒烟测试

> 📌 **生产 URL**：`https://tempo-six-neon.vercel.app`（GitHub `stevenli2007-del/tempo` Private 仓库，push main 自动部署）
> 📌 **代码侧已复核**：全仓库零硬编码 URL / localhost / `redirectTo`；redirect 全用相对路径（`/dashboard`、`/login`），不会被本地域名污染生产。

> 📌 **现状（2026-09-02 核实）**：
> - P0-0-1 脚手架 ✅、P0-0-2a（Supabase 项目 + `.env.local`）✅、P0-0-2b（client 分离）✅、**P0-0-3（Auth）✅ 已由 Steven 实测通过**。
> - P0-0-4 迁移文件 `supabase/migrations/20260902003000_initial_schema.sql` 已写好（13 表 + 外键 + 触发器 + 8 索引）。**沙箱无 Supabase CLI，无法代跑，需 Steven 在 Dashboard → SQL Editor 粘贴执行。**

---

## P0-0 基础设施

> 目标：一个能跑、能部署、能登录的空壳。这阶段不产生用户价值，但不做它后面每一步都在泥里走。

| 编号 | 任务 | Owner | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **P0-0-1** | 项目脚手架：Next.js 16.3.4 App Router + TS + Tailwind v4 + shadcn/ui 初始化，目录结构按 `CodingRules.md` | Bud | — | 本地 `dev` 可跑，访问首页看到占位页；TS 无报错 | ✅ |
| **P0-0-2a** | **【Steven 手动】** 在 Supabase 建项目 + 拿 Project URL / anon key + `cp .env.example .env.local` 填两个值 | **Steven** | P0-0-1 | `.env.local` 已填两个值；`npm run dev` 不报"缺少环境变量"错误 | ✅ |
| **P0-0-2b** | 前后端 client 分离（`lib/supabase/server.ts` / `browser.ts` 分开，不混用）+ `.env.example` 模板 + env 缺失即抛错校验 | Bud | P0-0-1 | `lib/supabase/{server,browser,env}.ts` 就位；service key 不进前端 | ✅ |
| **P0-0-3** | Supabase Auth：邮箱 + 密码注册/登录 + proxy 保护路由 | Bud | P0-0-2a | 可注册、登录、登出；未登录访问受保护页面被重定向 | ✅ |
| **P0-0-4** | 数据库迁移：建表（按 `Database.md` 全部表 + 索引 + 外键） | 共担 | P0-0-2a | 迁移脚本可重复执行；表结构与 `Database.md` 一致 | ✅ |
| **P0-0-5** | RLS 策略：用户只能访问自己的数据 | Bud | P0-0-4 | 用两个测试账号交叉验证，看不到对方任何数据 | ✅ |
| **P0-0-6** | 部署上线（Vercel）+ 生产环境变量 + 冒烟测试 | 共担 | P0-0-3, P0-0-5 | 生产环境可注册登录；无环境变量泄漏 | 🔵 待 Steven 配 Supabase URL + 冒烟 |

---

### P0-0 执行卡（AI 开工最小上下文）

> 领某个 task 时，只读下面这张卡 + `TechStack.md` 第 2 节版本矩阵即可开工，不必重读全部文档（见 `CodingRules.md` 阅读策略）。

#### 🎫 P0-0-1 · 脚手架 —— ✅ 已完成，勿重做
`app/page.tsx` 已显示占位页；目录结构、本地字体、shadcn `button.tsx` 均已就位。下次会话若再领到此 task，直接跳到 P0-0-2a。

#### 🎫 P0-0-2a · 【Steven 手动】Supabase 项目 + 环境变量
- **做什么**：supabase.com 建项目 → 拿 Project URL + anon key → `cp .env.example .env.local` 填两个值
- **交接点**：纯 Steven，AI 无法代劳
- **验收**：`npm run dev` 不再报「缺少环境变量 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY」

#### 🎫 P0-0-2b · 前后端 client 分离 —— ✅ 已完成，勿重做
`lib/supabase/server.ts` / `browser.ts` / `env.ts` 已就位。下次会话若领到此 task，直接跳过。

#### 🎫 P0-0-3 · Supabase Auth —— 代码已完成，待 Steven 实测验收
- **做什么**：邮箱+密码注册 / 登录 / 登出 + `proxy.ts` 保护受保护路由（未登录重定向）
- **改哪些文件**：`proxy.ts`（根）、`lib/supabase/proxy.ts`、`lib/auth/actions.ts`、`app/api/auth/callback/route.ts`、`components/auth/auth-form.tsx`、`app/(routes)/{login,signup,dashboard}/page.tsx`、`app/page.tsx`、`types/auth.ts`
- **关键约束**：
  - ⚠️ **Next 16 已把根 `middleware.ts` 约定改名为 `proxy.ts`**，导出函数名也从 `middleware` 改为 `proxy`。两者同时存在会直接报 **E900 构建错误**，且 `middleware.ts` 每次 build 都会刷弃用警告。已迁移完毕。
  - 必须用 `supabase.auth.getUser()` 而非 `getSession()` —— 前者真去 Auth 服务端校验 JWT，`getSession()` 只解本地 cookie，伪造 cookie 会被放行。
  - `@supabase/ssr` 0.12.5；服务端用 `server.ts`、浏览器用 `browser.ts`，不混用。
  - `redirect()` 会抛 `NEXT_REDIRECT`，**必须写在 try/catch 之外**，否则被当错误吞掉。
  - 路由白/黑名单集中在 `lib/supabase/proxy.ts` 的 `PROTECTED_PREFIXES` / `AUTH_PAGES`，不要散落到各页面。
- **已知边界**：不碰 `profiles` 表（P0-0-4 才建），dashboard 只显示 auth session 里的 email / id / last_sign_in_at。
- **验收**：`npm run dev` → 注册→登录→登出全通；未登录访问 `/dashboard` 被重定向到 `/login`；已登录访问 `/login` 被弹到 `/dashboard`
- **交接点**：Bud 已跑通 `build` / `lint` / `tsc`，**但交互链路必须由 Steven 在本地终端实测**（WorkBuddy 环境拦截 `.next` 缓存，`next dev` 跑不起来）

#### 🎫 P0-0-4 · 数据库迁移 ✅（commit `1e16944`，Steven 已执行 + 验证 13 张表）
- 改动：`supabase/migrations/20260902003000_initial_schema.sql`（360 行）
- 验收 ✅：Steven 在 Dashboard SQL Editor 执行 "Success. No rows returned"，验证查询返回 13 行
- ⚠️ 已知留白（已并入 P0-0-5）：`handle_new_user` 触发器待建

#### 🎫 P0-0-5 · RLS 策略
#### 🎫 P0-0-5 · RLS 策略 + `handle_new_user` 触发器 ✅（commit `f6de152`，Steven 已实测）
- 改动：`supabase/migrations/20260902100000_rls_and_handle_new_user.sql`（242 行）
- 验收 ✅：13 表 rowsecurity=true、13 条 policy、handle_new_user trigger 在 a/b 注册时自动写 profile、A 模拟 session 看不到 B、B 模拟 session 看不到 A（set local role + request.jwt.claim.sub 三段验证全过）

#### 🎫 P0-0-6 · Vercel 部署（**正在规划**）
- **做什么**：
  - 所有业务表 `ENABLE ROW LEVEL SECURITY` + 行级策略（防越权读别人数据）
  - **`handle_new_user` 触发器**：注册时自动在 `profiles` 插一行（从 P0-0-4 留白转入）
  - **匿名策略**：未登录用户**完全不读**任何业务表
- **改哪些文件**：`supabase/migrations/20260905000000_rls_and_handle_new_user.sql`（新文件）
- **关键约束**：
  - `profiles` / `canvas_credentials` / `sync_runs` / `parse_corrections`：`auth.uid() = user_id`
  - `courses` 及其子表（syllabi / tasks / exam_dates 等）：经 `courses.id` 反查，递归匹配 `auth.uid() = courses.user_id`
  - `llm_runs`：只走 service role 写，**前端 anon key 完全无权限**（含 select）；日志不该被前端读取
  - 校验：所有策略 `USING` + `WITH CHECK` 双写；触发器用 `security definer` + `set search_path = public`
- **验收**：
  - 两个测试账号 A/B，A 取 B 的任何一行都返回空
  - 未登录访问任何业务表被拒
  - 注册新账号 → `profiles` 表自动出现对应行
  - 删除 auth.users 中账号 → `profiles` 行级联消失
- **交接点**：Bud 写迁移；Steven 在 SQL Editor 执行 + 用两个测试账号交叉验证

#### 🎫 P0-0-6 · Vercel 部署 —— **部署已完成**，剩 Steven 收尾
- **做什么**：Vercel 部署 + 生产环境变量 + 冒烟测试
- **改哪些文件**：0 代码改动（纯基础设施）；Vercel Dashboard 环境变量
- **关键约束**：`SUPABASE_SERVICE_ROLE_KEY` 等密钥只在服务端、无 `NEXT_PUBLIC_` 前缀；生产变量不含任何密钥
- **验收**：生产环境可注册登录；无环境变量泄漏
- **代码改动**：0

**✅ 已完成（Bud）**
- GitHub 仓库 `stevenli2007-del/tempo`（Private）已建 + 推送
- Vercel Import 仓库 → 2 个 env vars（Production scope）→ 部署成功
- 生产 URL：**`https://tempo-six-neon.vercel.app`**
- 代码复核：全仓库零硬编码 URL / localhost / `redirectTo`，redirect 全相对路径

**⚠️ 两个已踩过的坑（下次别再掉进去）**
1. **git author 邮箱必须匹配 GitHub 账号** —— 否则 Vercel 判「冒名顶替」直接 **Blocked**，不报 build 错。修复：
   ```bash
   git config user.email "stevenli2007@berkeley.edu" && git config user.name "Steven Li"
   git commit --amend --author="Steven Li <stevenli2007@berkeley.edu>" --no-edit
   git push --force-with-lease origin main
   ```
2. **env vars 保存 ≠ 已注入当前 deployment** —— 先 Deploy 后加 env vars，旧 build 不带变量，页面 500。**加完必须手动 Redeploy**，让 Vercel 重跑 build 把变量烤进 bundle。

**⏳ Steven 剩余两步**
1. Supabase Dashboard → Authentication → URL Configuration：
   - **Site URL** = `https://tempo-six-neon.vercel.app`
   - **Redirect URLs** 加两条：`http://localhost:3000/**`（本地开发）+ `https://tempo-six-neon.vercel.app/**`（生产）
2. 生产冒烟：`/` 打开 → 注册 `prod-test@tempo.dev` → 直接进 `/dashboard` → 登出回 `/login`

---

## P0-1 M1 — 静态理解（syllabus 解析）

> 目标：验证"学生愿意上传 syllabus 且认可 AI 解析价值"。**这一阶段零外部依赖、零合规风险，是最该先跑通的部分。**

| 编号 | 任务 | Owner | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **P0-1-1** | 文件存储：syllabus 上传入口 + Supabase Storage + 类型/大小校验（PDF / docx / pptx） | Bud | P0-0-6 | 可上传并取回文件；非法类型被拒绝且有提示 | ⚪ |
| **P0-1-2** | 文本提取管线（PDF / docx / pptx），抽不出时**明确降级提示**而非静默返回空 | Bud | P0-1-1 | 三种格式各测一份真实文件；扫描件走降级提示不崩溃 | ⚪ |
| **P0-1-3** | LLM provider 抽象层（`lib/llm`）：默认 DeepSeek adapter + JSON schema 结构化输出 + 错误处理 | Bud | P0-0-6 | 抽象层可用；切换 provider 只改配置不动业务代码（[ADR-003](./Decisions.md#adr-003)） | ⚪ |
| **P0-1-4** | 五板块抽取 prompt v1：Grade Composition / Course Outline / Test Dates / Office Hours / Submission Policy，**拆成独立抽取任务** | Bud | P0-1-3 | 每板块独立调用；输出符合 schema；缺失字段返回 null 不编造 | ⚪ |
| **P0-1-5** | 解析 API 路由 + 结果落库 + **修正 diff 存储**（保存原始解析 vs 修正后 + 差异字段） | Bud | P0-1-2, P0-1-4 | 数据库同时存有原始与修正版本，可追溯差异 | ⚪ |
| **P0-1-6** | 可编辑表单 UI：五个板块逐项编辑 / 补全 / 覆盖 + 保存 | Bud | P0-1-5 | 可修改任一字段并保存；TBD 状态可正常展示与编辑 | ⚪ |
| **P0-1-7** | Workspace CRUD：创建（学期 + 课程名必填，编码/教师选填）、列表按学期分组、编辑、删除 | Bud | P0-0-6 | 建课后出现在总览页与列表；删除有二次确认 | ⚪ |
| **P0-1-8** | 课程详情页：展示五板块最终信息 | Bud | P0-1-6, P0-1-7 | 保存后的数据完整展示；缺失项显示 TBD 而非空白 | ⚪ |
| **P0-1-9** | 总览页 v1：课程卡片（显示近期 1-2 个任务）+ 跨课程近期任务列表（仅 syllabus 数据，按日期排序） | Bud | P0-1-8 | 能看到"最近 7 天所有课程要做的事"；可跳转课程详情 | ⚪ |
| **P0-1-10** | 冷启动：**Demo Workspace**（预置示例课程，含已解析 syllabus 与示例任务） | Bud | P0-1-9 | 新用户从进入站点到看到有内容的总览页 ≤ 30 秒 | ⚪ |
| **P0-1-11** | 解析过程可视化：上传后先显示文本预览，再逐步填充五个板块 + 进度提示 | Bud | P0-1-6 | 用户不再干等；每一步有明确状态反馈 | ⚪ |

---

## P0-2 M2 — 动态感知（数据源同步）

> 目标：验证"任务自动同步是否减少打开 Canvas 的次数"——**Tempo 内核的第一环**。
> ✅ **P0-2-1 已于 2026-09-01 完成（Steven 实测）：bCourses 的 "+ New Access Token" 按钮存在且可用** → M2 走 PAT 路线，iCal 兜底（P0-2-10）**不执行**。
> iCal 仍作为长期 Plan B 保留（学校若将来关闭入口则启用），但不再是 Phase 0 的工作项。

| 编号 | 任务 | Owner | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **P0-2-1** | **Canvas token 可行性实测**：登录 bCourses → Settings → 确认"+ New Access Token"按钮是否可用；记录是否强制填过期时间、上限多久 | **Steven** | — | ✅ **结论：可用**（2026-09-01）。M2 走 PAT；P0-2-10 不执行 | ✅ |
| **P0-2-1b** | **记录实测细节**：是否强制填写过期时间、上限天数、token 可撤销入口位置 | **Steven** | P0-2-1 | 三项信息记录在案（影响 P0-2-8 提醒逻辑的默认值） | ⚪ |
| **P0-2-2** | 凭据加密存储（AES）+ 服务端 Canvas 请求封装（token 绝不出现在前端响应中） | Bud | P0-2-1（可用） | DB 中凭据为密文；抓包确认前端拿不到 token | ⚪ |
| **P0-2-3** | Canvas API 客户端：拉取课程列表 + 作业列表（含 due date），含限流与错误处理 | Bud | P0-2-2 | 能正确拉取真实数据；API 报错有明确处理不崩溃 | ⚪ |
| **P0-2-4** | 课程关联 UI：手动将 Canvas 课程与 Tempo Workspace 关联（不做自动匹配） | Bud | P0-2-3 | 可选择并关联；关联后状态可见；可解除关联 | ⚪ |
| **P0-2-5** | 首次全量同步：Canvas 作业 → `tasks` 表落库（去重 + 更新，不重复插入） | Bud | P0-2-4 | 重复同步不产生重复任务；due date 变更能更新 | ⚪ |
| **P0-2-6** | 刷新机制：手动刷新按钮 + 后台定时轮询（**前期频率放宽**，数值见 `Sync-Strategy.md`） | Bud | P0-2-5 | 手动刷新可用；定时轮询按配置执行 | ⚪ |
| **P0-2-7** | **同步状态 UI**：显示最后同步时间 + **失败可见性**（失败时展示最后成功时间与失败原因，绝不静默展示旧数据） | Bud | P0-2-6 | 断网/token 失效时显示明确错误提示，而非旧数据 | ⚪ |
| **P0-2-8** | Token 过期提醒：基于**用户实际填写的过期时间**（非写死天数）提前提醒 | Bud | P0-2-2 | 用临近过期的测试 token 验证提醒触发 | ⚪ |
| **P0-2-9** | 撤销授权入口：一键断开 Canvas 授权 + 删除已存凭据 | Bud | P0-2-2 | 断开后凭据从库中清除；同步停止且状态正确显示 | ⚪ |
| **P0-2-10** | ~~iCal Feed 兜底（条件性）~~ | Bud | — | ⏸ **不执行**：P0-2-1 判定为可用，条件未触发。保留为长期 Plan B（[ADR-002](./Decisions.md#adr-002)） | ⏸ |
| **P0-2-11** | 总览页合并展示：syllabus 考试日期 + Canvas 作业 due date 合并排序；考试日期以 `exam_dates` 为权威源 | Bud | P0-2-5, P0-1-9 | 两类任务正确合并；**课程页与总览页日期一致**（[ADR-004](./Decisions.md#adr-004)） | ⚪ |

---

## P0-3 验证与收尾

| 编号 | 任务 | Owner | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **P0-3-1** | 量化指标埋点：编辑修正率、7 日回访次数、人均关联课程数、token 续期完成率 | Bud | P0-2-11 | 四项指标可查；数据口径与 `PRD.md` 定义一致 | ⚪ |
| **P0-3-2** | 设置与隐私页：存了哪些数据的说明 + 一键删除 Canvas 凭据 + 一键删除账号及全部数据（级联） | Bud | P0-2-9 | 删除后所有相关数据（含 Storage 文件）被清除 | ⚪ |
| **P0-3-3** | **种子用户招募（5-6 人）**：技术型 2-3 人 + 非技术型 2-3 人，覆盖 ≥2 门不同学科 | **Steven** | P0-3-2 | 名单确定且构成符合要求（构成不对会导致结论不可信） | ⚪ |
| **P0-3-4** | 种子用户验证跑通：完整旅程 + 两条异常路径（扫描件 / token 失效） | 共担 | P0-3-3 | 每位用户走通主旅程；异常路径均有正确表现 | ⚪ |
| **P0-3-5** | 反馈收集与整理（含定性"是否减少了打开 Canvas 的次数"） | 共担 | P0-3-4 | 反馈整理成结构化结论 | ⚪ |
| **P0-3-6** | **Gate 0→1 评审**：对照 `Roadmap.md` 的 G0-1 ~ G0-7 逐条判定 | 共担 | P0-3-5 | 逐条给出达标/未达标结论 + 未达标的处置方案 | ⚪ |

---

## 关键路径与并行建议

```
P0-0 基础设施
  └─> P0-1 M1 静态理解 ──────────────┐
                                     ├─> P0-2-11 合并总览 ─> P0-3 验证
  ✅ P0-2-1 token 实测（已完成：可用）│
  └─> P0-2 M2 动态感知（PAT 路线）───┘
```

**关于 Phase 1 的 OAuth 申请（Steven 已拍板）**

不提前启动，等 Phase 0 有验证结果后再申请。理由：申请需要机构审批，而 Phase 0 的结论可能改变申请的策略与说辞——带着真实用户数据去谈，比空手去谈更有筹码。

> ⚠️ **这条偏离了原计划**（原建议并行启动以节省时间），属于 Steven 的主动取舍。代价是 Phase 1 的 OAuth 可能赶不上 Fall 2026 学期。**若 Phase 0 验证结果积极，应在 Gate 0→1 评审通过后立即启动申请**，不要继续拖。

---

## 风险登记（执行层面）

| 风险 | 影响 | 触发处置 |
|---|---|---|
| ~~bCourses 关闭学生 token 入口~~ | ~~M2 改走 iCal，功能降级~~ | ✅ **已排除**（P0-2-1 实测可用）。iCal 保留为长期 Plan B |
| LLM 解析效果不达标 | 编辑修正率高但用户仍觉得不准 | 切 Claude provider（抽象层已备，[ADR-003](./Decisions.md#adr-003)） |
| 扫描件 syllabus 比例超预期 | 用户频繁撞到降级提示 | 评估是否启用多模态 provider（待决 O-03） |
| 学期过半导致验证窗口收紧 | 数据样本不足 | 优先保 P0-1（价值峰值在期中前），M2 可适度后延 |

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-01 | 初版创建：33 个 task，分 P0-0 / P0-1 / P0-2 / P0-3 四组，含 Owner、依赖、验收标准、关键路径与风险登记 |
| 2026-09-01 | P0-2-1 完成（Steven 实测：token 入口可用）→ P0-2-10 iCal 兜底标记为不执行；新增 P0-2-1b 记录实测细节；Phase 1 OAuth 申请改为「Phase 0 验证后再启动」（Steven 拍板，偏离原并行建议） |
| 2026-09-02 | 修复文档漂移（P0-0-1 「Next.js 14」→「16.3.4」，与 TechStack 对齐）；P0-0-2 拆分为 2a（Steven 手动建项目/填 env）/ 2b（Bud 写 client，已完成）；P0-0-6 改「共担」并标注交接点；新增「P0-0 执行卡」小节；更新进度指针反映真实卡点 |
