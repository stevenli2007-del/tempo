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

**当前 task**：`P0-1-6` 五板块编辑 UI（P0-1-5b 已代码完成 + 本地 56/56 + 生产 18/18，待 Steven 验收）

> 📌 **P0-1-5a 已验收通过 ✅（2026-09-03，Steven 验收；测试账号已清理）**。代码 commit `bcd5a20` + 文档 commit（生产验证 14/14 + §10 部署延迟条目），均已 push。本地冒烟 44/44、生产验证 14/14（真实调 DeepSeek 4.4s、`llm_runs` 落 5 条 success）。
>
> 🟦 **P0-1-5b 状态（2026-09-03，代码完成 / 自测通过（本地 56/56 + 生产 18/18）/ Steven 验收待做）**：
> - **已交付**：5 个 `PUT /api/v1/courses/:id/{板块}` 端点 + `lib/parse/save.ts`（编排）+ `lib/parse/corrections.ts`（字段级 diff + 归因）+ `lib/sync/exam-tasks.ts`（`syncExamToTask()`）+ 五张表的保存校验/映射函数 + `lib/parse/persist.ts` 接入派生（解析后也产 task）。
> - **本地冒烟 56/56**（`next build` + `next start` + 两个测试账号）：五板块正常路径、幂等、diff 三类修正、exam 派生（tbd → null / status 保留 / 删除联动 / 当日 23:59:59）、真实 `/parse` 归因（`llm_run_id` 非 null 且真实存在）、7 条异常路径（401/400×4/404/越权）+ 归档 404。
> - **生产验证 18/18**（2026-09-03，`a959d45` 已 push 且部署 success 后实跑 `tempo-six-neon.vercel.app`）：路由存在、grade-components 全流程含 edit 修正落库、exam 派生、真实 `/parse` + 归因、401/跨用户 404/非法日期 400、数据清理。临时冒烟脚本已删。
> - **实现期决策（已写进 `API-Contract.md` §4 变更记录，无需 ADR）**：① request 不含 `status`（由 examDate 派生）；② 修正粒度 = 字段级（add/delete 也按字段拆，`order_index` 除外）；③ 归档课程保存 → 404；④ 归因取「最新 syllabus 最近一次成功解析」。
> - **待办**：Steven 验收 P0-1-5b；测试账号 `p15b-a/p15b-b@test.dev`（本地）+ `p15b-prod/p15b-prod2@test.dev`（生产）留在 auth.users 待手动删（业务数据均已清）。
>
> 🟦 **P0-1-6 开工提示**：后端全部就绪，纯前端 —— 编辑表单拿 `Stored*`（带 id），提交 `Save*Item`（见 `types/sections.ts`）；保存调 `PUT` 对应板块端点；`ExamDate.status` 不用表单里放字段（服务端派生，传了也忽略）；大纲条目不用做排序输入（数组顺序即 `orderIndex`）。`source='manual'` 的行要能看出"手动添加"标记。

> 🛑 **上一轮收工状态（2026-09-02 23:00，Steven 收工）**：P0-1-4 已验收通过。
> - **P0-1-5a 已在 2026-09-03 开工**，开工提示见下方 P0-1-4 卡末尾（①②③④）。

> 📌 **P0-1-4 五板块抽取 prompt v1 已验收通过 ✅（2026-09-02 晚，Steven 验收）**
> - `types/parse.ts` + `lib/parse/`（schemas / prompts / index）已交付；`parseSyllabusSections()` 五板块并发调用、单块失败不影响其余。
> - **核心设计：`sourceExcerpt`** —— 每个条目都带≤200 字的原文逐字摘录，逼模型给依据、让用户可核对，且直接对应五张表都有的 `source_excerpt` 列。
> - **验收证据**：CS 61B 风格 syllabus 现场实跑，五板块全 ok、3.2s，反幻觉两个陷阱（「按校历安排」/「见 bCourses」）均正确返回 `null` + `tbd`，未编造日期。
> - **留白 ④ 已裁定**：提交政策粒度偏粗（一个 section 内的两条规则被合并成 1 条）**Steven 接受**，Phase 0 不改，不升 `PROMPT_VERSION`。若日后真实 syllabus 显示粒度影响可用性，再升 `v2` 单独立项。
> - **`P0-1-5` 开工提示**：① 调用方看 `okSections.length`（不是 `ok`）判断有没有可落库的结果 —— **部分成功是常态**；② `ExamDate.status` 由 `examDate` 派生，别让模型填；③ 五张表的 snake_case 映射写在各自的 `lib/*.ts` 里，`lib/parse/index.ts` 不碰 DB；④ **验收时必须补做 P0-1-3 / P0-1-4 的生产验证** —— 这两个都是纯库层，此前只在本地验过，P0-1-5 是第一个能打到它们的端点。

> 📌 **P0-1-3 代码验收通过 ✅（2026-09-02，Steven 按 Option A 收口）**
> - **状态**：`lib/llm` 六件套已交付，本地自测全绿；Steven 手动项（Vercel key + Redeploy、删测试账号、push）**全部完成**。
> - **⚠️ 生产验证并入 P0-1-5**：`lib/llm` 是纯库层、零 HTTP 出口，现有 6 个端点无一 import 它，打生产域名验不到。第一个真正调 LLM 的端点是 P0-1-5，**届时必须补做**（key 注入 / adapter 在 Vercel 跑通 / 审计落库）。详见 P0-1-3 执行卡。

> 📌 **P0-1-7 / P0-1-1 / P0-1-2 / P0-1-3 / P0-1-4 均已完成 ✅（2026-09-02）**
> - **ADR-010 已拍板接受**：RLS 保护的资源，「越权」与「不存在」统一返回 `404`，Phase 0 不用 403。契约文档已同步改（§1.2 / §1.4），**后续所有资源端点按此执行，不再逐个论证**。
> - **P0-1-1 / P0-1-2 的浏览器 UI 已由 Steven 本地验收通过（2026-09-02，合并验收）**：两者共用 `syllabus-upload.tsx` 一个组件，上传 → 提取状态 → 文本预览 → 错误提示文案走一遍覆盖两个 task。M1 前三个 task 全部收口，下一 task 为 P0-1-3。

> 📌 **P0-0 基础设施 全部完成 ✅**
> - P0-0-1 脚手架 · P0-0-2a/b Supabase 接入 · P0-0-3 Auth · P0-0-4 13 表迁移 · P0-0-5 RLS + handle_new_user · P0-0-6 Vercel 部署 + 生产冒烟。
> - 生产 URL：`https://tempo-six-neon.vercel.app`（GitHub `stevenli2007-del/tempo` Private，push main 自动部署）。
> - Supabase URL Configuration：Site URL + Redirect URLs（`http://localhost:3000/**` + `https://tempo-six-neon.vercel.app/**`）已配齐。

> 📌 **⚠️ 顺序调整（2026-09-02，Steven 拍板）：执行顺序 ≠ 编号顺序 —— P0-1-7 提前到 P0-1-1 之前。**
> - **原因**：`syllabi.course_id` 是 `NOT NULL`（`supabase/migrations/20260902003000_initial_schema.sql:71`），而上传接口是 `POST /api/v1/courses/:id/syllabus`（`API-Contract.md:141`）。**没有课程就没有上传落点**，按原编号顺序做出来是个测不通的半成品。
> - **实际执行序**：`P0-1-7 → P0-1-1 → P0-1-2 → …`（其余 task 相对顺序不变）。
> - **编号保持不动**：`P0-1-x` 是 task 的稳定标识，已出现在 commit message 与 memory 里。重编号会让这些引用全部失效。**顺序以本指针为准，不以编号大小为准。**

> 📌 **同日另两个决策（2026-09-02，Steven 拍板）**
> 1. **syllabus 上传走「浏览器直传 Supabase Storage」**，不再走服务端 multipart 转发 —— 见 [ADR-009](./Decisions.md#adr-009)。`API-Contract.md` §3 的 multipart 契约将在 P0-1-1 交付时同步改写。
> 2. **Storage 桶规范**（桶名 / 路径约定 / `storage.objects` RLS 策略）**并入 P0-1-1 一起交付**：先补 `Database.md` 新增 Storage 小节（SSOT 在前），再出迁移文件，不单独拆 task。

> 📌 **领 P0-1-1 时只需读**：`Phase-0-MVP.md` 中 P0-1-1 执行卡 + `TechStack.md` 第 2 节版本矩阵 + `Database.md` Storage 小节 + `API-Contract.md` §1.5 / §3 + [ADR-009](./Decisions.md#adr-009) / [ADR-010](./Decisions.md#adr-010) 即可开工，按 `CodingRules.md` 阅读策略**不重读全部 11 份文档**。
> - 参考 P0-1-7 的既有实现：`lib/courses.ts`（snake_case ↔ camelCase 唯一映射点）+ `lib/api/response.ts`（统一响应）+ `app/api/v1/courses/[id]/route.ts`（资源端点范式，含 ADR-010 落地写法）。

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
| **P0-0-6** | 部署上线（Vercel）+ 生产环境变量 + 冒烟测试 | 共担 | P0-0-3, P0-0-5 | 生产环境可注册登录；无环境变量泄漏 | ✅ |

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

#### 🎫 P0-0-3 · Supabase Auth ✅（commit `02e6bde`，Steven 2026-09-02 实测 7 条验收全过）
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

#### 🎫 P0-0-4 · 数据库迁移 ✅（commit `1e16944`，Steven 已执行 + 验证 13 张表）
- 改动：`supabase/migrations/20260902003000_initial_schema.sql`（360 行）
- 验收 ✅：Steven 在 Dashboard SQL Editor 执行 "Success. No rows returned"，验证查询返回 13 行
- ⚠️ 已知留白（已并入 P0-0-5）：`handle_new_user` 触发器待建

#### 🎫 P0-0-5 · RLS 策略 + `handle_new_user` 触发器 ✅（commit `f6de152`，Steven 已实测）
- 改动：`supabase/migrations/20260902100000_rls_and_handle_new_user.sql`（242 行）
- 验收 ✅：13 表 rowsecurity=true、13 条 policy、handle_new_user trigger 在 a/b 注册时自动写 profile、A 模拟 session 看不到 B、B 模拟 session 看不到 A（set local role + request.jwt.claim.sub 三段验证全过）

#### 🎫 P0-0-6 · Vercel 部署 ✅（生产 URL `https://tempo-six-neon.vercel.app`，Steven 2026-09-02 实测冒烟通过）
- **做什么**：Vercel 部署 + 生产环境变量 + 冒烟测试
- **改哪些文件**：0 代码改动（纯基础设施）；Vercel Dashboard 环境变量
- **关键约束**：`SUPABASE_SERVICE_ROLE_KEY` 等密钥只在服务端、无 `NEXT_PUBLIC_` 前缀；生产变量不含任何密钥
- **代码改动**：0

**✅ 已完成（Bud + Steven 配合）**
- GitHub 仓库 `stevenli2007-del/tempo`（Private）已建 + 推送
- Vercel Import 仓库 → 2 个 env vars（Production scope，Config 类型不要勾 Secret）→ 部署成功
- 生产 URL：**`https://tempo-six-neon.vercel.app`**
- Supabase URL Configuration：Site URL = 生产 URL；Redirect URLs 含 `http://localhost:3000/**` + `https://tempo-six-neon.vercel.app/**`
- 生产冒烟通过：landing page 可访问、注册新账号直接进 `/dashboard`、登出回 `/login`、未登录访问 `/dashboard` 弹回 `/login`

**⚠️ 四个已踩过的坑（下次别再掉进去）**
1. **git author 邮箱必须匹配 GitHub 账号** —— 否则 Vercel 判「冒名顶替」直接 **Blocked**，不报 build 错。修复：
   ```bash
   git config user.email "stevenli2007@berkeley.edu" && git config user.name "Steven Li"
   git commit --amend --author="Steven Li <stevenli2007@berkeley.edu>" --no-edit
   git push --force-with-lease origin main
   ```
2. **Server Client 里 `cookies()` 必须在 `getSupabaseEnv()` 之前调用**（不是之后）。顺序反了的话，env 缺失时会在 `cookies()` 之前就抛错，Next 看不到 `cookies()` 调用 → 误判 `/dashboard` 为静态页强行预渲染 → `prerender-error`。**修复套路**：所有 session 依赖页加 `export const dynamic = 'force-dynamic'`。（修复溯源：commit `8f408d8`）
3. **env vars 保存 ≠ 已注入当前 deployment** —— 先 Deploy 后加 env vars，旧 build 不带变量，页面 500。**加完必须手动 Redeploy**，让 Vercel 重跑 build 把变量烤进 bundle。
4. **`NEXT_PUBLIC_*` 变量在 Vercel UI 应选 Config 不要选 Secret** —— Vercel 会红框警告，公开值用 Secret 是误导且徒增混淆。

**⏭ 下一步**：进入 **P0-1 M1 — 静态理解（syllabus 解析）**，第一个 task 是 **P0-1-1 · 文件存储**。

---

## P0-1 M1 — 静态理解（syllabus 解析）

> 目标：验证"学生愿意上传 syllabus 且认可 AI 解析价值"。**这一阶段零外部依赖、零合规风险，是最该先跑通的部分。**
>
> ⚠️ **表格行顺序 ≠ 执行顺序**：实际先做 `P0-1-7`（课程 CRUD）再做 `P0-1-1`（上传），原因见[进度指针的顺序调整说明](#当前进度指针)。**表格行序保持编号顺序不动，只为编号可读性。**

| 编号 | 任务 | Owner | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **P0-1-1** | 文件存储：syllabus 上传入口 + Supabase Storage + 类型/大小校验（PDF / docx / pptx） | Bud | P0-0-6, **P0-1-7** | 可上传并取回文件；非法类型被拒绝且有提示 | ✅ |
| **P0-1-2** | 文本提取管线（PDF / docx / pptx），抽不出时**明确降级提示**而非静默返回空 | Bud | P0-1-1 | 三种格式各测一份真实文件；扫描件走降级提示不崩溃 | ✅ |
| **P0-1-3** | LLM provider 抽象层（`lib/llm`）：默认 DeepSeek adapter + JSON schema 结构化输出 + 错误处理 | Bud | P0-0-6 | 抽象层可用；切换 provider 只改配置不动业务代码（[ADR-003](./Decisions.md#adr-003)） | ✅ |
| **P0-1-4** | 五板块抽取 prompt v1：Grade Composition / Course Outline / Test Dates / Office Hours / Submission Policy，**拆成独立抽取任务** | Bud | P0-1-3 | 每板块独立调用；输出符合 schema；缺失字段返回 null 不编造 | ✅ |
| **P0-1-5** | 解析 API 路由 + 结果落库 + **修正 diff 存储**（保存原始解析 vs 修正后 + 差异字段） | Bud | P0-1-2, P0-1-4 | 数据库同时存有原始与修正版本，可追溯差异 | 🔵 5a ✅ 已验收 / 5b 进行中 |
| **P0-1-6** | 可编辑表单 UI：五个板块逐项编辑 / 补全 / 覆盖 + 保存 | Bud | P0-1-5 | 可修改任一字段并保存；TBD 状态可正常展示与编辑 | ⚪ |
| **P0-1-7** | Workspace CRUD：创建（学期 + 课程名必填，编码/教师选填）、列表按学期分组、编辑、删除 | Bud | P0-0-6 | 建课后出现在总览页与列表；删除有二次确认 | ✅ |
| **P0-1-8** | 课程详情页：展示五板块最终信息 | Bud | P0-1-6, P0-1-7 | 保存后的数据完整展示；缺失项显示 TBD 而非空白 | ⚪ |
| **P0-1-9** | 总览页 v1：课程卡片（显示近期 1-2 个任务）+ 跨课程近期任务列表（仅 syllabus 数据，按日期排序） | Bud | P0-1-8 | 能看到"最近 7 天所有课程要做的事"；可跳转课程详情 | ⚪ |
| **P0-1-10** | 冷启动：**Demo Workspace**（预置示例课程，含已解析 syllabus 与示例任务） | Bud | P0-1-9 | 新用户从进入站点到看到有内容的总览页 ≤ 30 秒 | ⚪ |
| **P0-1-11** | 解析过程可视化：上传后先显示文本预览，再逐步填充五个板块 + 进度提示 | Bud | P0-1-6 | 用户不再干等；每一步有明确状态反馈 | ⚪ |

---

### P0-1 执行卡（AI 开工最小上下文）

> 与 P0-0 一样：领 task 时只读对应执行卡 + `TechStack.md` 第 2 节版本矩阵，不必重读全部文档。

#### 🎫 P0-1-1 · syllabus 上传入口 + Supabase Storage + 类型/大小校验 · ✅ 已完成，勿重做
- **做什么**：能上传一份 syllabus 并存进 Supabase Storage，能取回来；非法类型/超大小被拒绝且有提示。
- **⚠️ 前置（Steven 手动，走 Dashboard UI，不走 SQL Editor）**：`supabase/migrations/20260902220000_storage_syllabi.sql` 的头部写了完整步骤。**不能在 SQL Editor 整段执行** —— `CREATE POLICY on storage.objects` 会报 `42501: must be owner of table objects`（该表 owner 是平台内部的 `supabase_storage_admin`，SQL Editor 的 postgres 角色不是 owner，而建策略要求 owner）。正确做法：① Dashboard → Storage → New bucket（`syllabi`，私有，limit 20MB）→ ② Storage → Policies 建四条。**不执行的话上传会 500**（RLS 拒绝一切 insert，且该检查发生在"桶是否存在"之前，报错文案是 `new row violates row-level security policy`，**不是** "bucket not found"，别被误导）。验收用的两条 SELECT 在 SQL Editor 可以正常跑，写在迁移文件末尾。
- **改哪些文件**：
  - `supabase/migrations/20260902220000_storage_syllabi.sql` —— 桶 + 4 条 RLS 策略（**SSOT 是 `Database.md` 7.3，先补文档再出迁移**）
  - `types/syllabus.ts` —— `Syllabus` / `SyllabusUploadTicket` / `CreateSyllabusInput` / `SyllabusDownloadUrl`
  - `lib/syllabi.ts` —— `SyllabusRow` + `SYLLABUS_COLUMNS`（**必须写字面量字符串，不能 `.join()`**，否则退化成 `string`，supabase 推不出返回行类型，`data` 会被推断成 `GenericStringError`）、`toSyllabus()`、`validateUploadInput()`、`buildStoragePath()`
  - `lib/api/client-error.ts` —— `readApiErrorMessage()`，从错误响应取用户可读文案
  - `app/api/v1/courses/[id]/syllabus/route.ts` —— 两步式直传第 1 步：校验 → 签 `createSignedUploadUrl` → 建 syllabi 行
  - `app/api/v1/syllabi/[id]/download/route.ts` —— 签 60 秒下载 URL
  - `components/courses/syllabus-upload.tsx` —— 选文件 → 前端预校验 → 取票据 → `uploadToSignedUrl` 直传 → `router.refresh()`
  - `components/courses/course-card.tsx` / `app/(routes)/dashboard/page.tsx` —— 卡片嵌入上传入口；dashboard 按 `in(course_id)` **一次**取回 syllabi（避免 N+1），取每课最新一份
- **关键约束**：
  - **两步式直传（ADR-009）**：`POST .../syllabus` 收 JSON `{fileName, fileSize}`，不是 multipart。文件不经服务端。
  - **服务端是唯一权威**：前端也校验一遍，但那只为体验 —— 前端上报的 `fileSize`/`fileName` 全不可信。
  - **类型按扩展名判，不按 MIME**：docx/pptx 在真实浏览器里常报 `application/octet-stream`，桶层面设 `allowed_mime_types` 会误拒（`Database.md` 7.3）。
  - **路径首段必须是 `auth.uid()`**：`storage.objects` 的 RLS 靠它判定归属，由服务端生成，前端不可控。
  - **先签票据再建行**：签失败就不留悬挂行。
  - **越权统一 404**（ADR-010），不返回 403。
  - `file_url` 列存的是**对象路径不是 URL**（私有桶无永久 URL），对外字段改名 `filePath` 把语义纠正过来。
- **自测（Bud，2026-09-02）**
  - `NODE_OPTIONS= npx tsc --noEmit` ✅ ｜ `NODE_OPTIONS= npm run lint` ✅（0 warning）｜ `NODE_OPTIONS= npm run build` ✅（新增 2 个 ƒ 动态路由）
  - **API 冒烟 19 项，18 项通过**：未登录 401 / 非法 uuid 400 / 非 JSON 400 / 5 项入参校验 400 / 2 项类型错误 415 / 超限 413 / 课程不存在 404 / **B 给 A 的课传文件 404（越权隔离 ✅）** / 下载端点 400·404·401 / `x-request-id` 回传 ✅
  - **复测（2026-09-02 Steven 执行 Storage 后）✅ 19/19 全绿**：原唯一未过的 201 正常路径已通过。另做 **Storage 端到端直探 7/7**：签名上传（RLS INSERT 放行）→ 直传 → 签下载 URL → 真实取回内容一致 → **B 传 A 的路径被拒** → **B 下载 A 的文件被拒** → A 删除自己的对象（RLS DELETE 放行）。
  - 顺带修了冒烟基建的两个坑：① 沙箱里 `signUp` 的 **PKCE code challenge 生成会抛错**，测试脚本一律先 `signInWithPassword`（不走 PKCE）；② `@supabase/ssr` 的 `setAll` 回调收到的是 **`{name, value}` 对象数组**，不是元组。
- **✅ 浏览器 UI 已由 Steven 本地验收通过（2026-09-02，与 P0-1-2 合并验收）**：上传交互、提取状态展示、文本预览与错误提示文案均正常。
- **已知留白**：**上传中断会留悬挂行**（已由 P0-1-2 的 409 + 置 `failed` 兜住，见下卡）；未新增 `file_size`/`mime_type` 列（Diff First，需要时再加）；端点总表里 `GET /api/v1/health` 实际未实现（返回 404，属 P0-0-6 遗留）。

#### 🎫 P0-1-2 · 文本提取管线（PDF / docx / pptx）· ✅ 已完成，勿重做

- **做什么**：上传流程的第 3 拍——把 Storage 里的文件读回来，抽成纯文本存进 `syllabi.raw_text`，返回前 1000 字符的预览。
- **✅ 已完成**（commit 见变更记录）。**验收：API 端到端 57 项全绿 + 生产环境实测通过**。
- **改哪些文件**：
  - `lib/extract.ts`（新）—— 三格式提取器，**纯函数层：不碰 DB 不碰网络**，可单独测
  - `app/api/v1/syllabi/[id]/extract/route.ts`（新）—— 取行 → 签下载 URL → 拉文件 → 提取 → 写回 → 返回
  - `types/mammoth.d.ts`（新）—— mammoth 无自带类型且 `@types/mammoth` **不存在**（404），手写最小声明
  - `lib/api/params.ts`（新）—— `UUID_PATTERN`，原散在 3 个路由里各写一份，第 4 次出现时抽出
  - `next.config.mjs` —— `serverExternalPackages: ['unpdf']` + `outputFileTracingIncludes` 把 `pdfjs-dist` 的 `standard_fonts/**`、`cmaps/**` 打进函数包
  - `types/syllabus.ts` —— 新增 `SyllabusExtractResponse`
  - `lib/syllabi.ts` —— 新增 `SYLLABUS_COLUMNS_WITH_TEXT`（多 `raw_text` 一列）+ `isStorageObjectNotFoundError()`（download / extract 共用）
  - `app/api/v1/syllabi/[id]/download/route.ts` —— 补 `404 file_missing`（原本抛 500）
  - `components/courses/syllabus-upload.tsx` —— 第 4 拍：直传成功后调 extract，展示预览 / 降级提示
- **🔴 踩过的坑（下一个人别再踩）**：
  1. 🔥🔥 **PDF 提取器只能用 `unpdf`。`pdf-parse` 与 `pdfjs-dist`（现代构建、legacy 构建）三个都在 Vercel 上炸。**
     三者死在同一处：pdfjs 在 Node 下的**模块作用域**就要 `new DOMMatrix()`，而 `DOMMatrix` 靠 `require('@napi-rs/canvas')`（Skia 原生二进制）补 —— **canvas 加载失败时只 warn 不赋值，紧接着顶层就崩**。
     本地 macOS 装了 23MB 的 `@napi-rs/canvas-darwin-arm64`，所以**本地全绿**；Vercel 函数包里没有这个原生二进制 → **该路由 import 即 500**，响应体为空，连不碰 PDF 的分支（非法 uuid → 400）也 500。
     `unpdf` 正是给这个坑打的补丁：重新打包 pdfjs，字符串替换剥浏览器 API、worker 内联、补全局对象，**零运行时依赖、不需要 canvas**。详见 [ADR-011](./Decisions.md#adr-011)。
     → **通用教训一**：本地能跑不代表线上能跑，差别往往在**原生依赖**。依赖变更后必须到生产环境打一次。
  2. 🔥 **验证这类库，本地必须先 `delete globalThis.DOMMatrix` 再 import。**
     本地残留的 canvas 会掩盖问题 —— 我第一轮看到「legacy 构建 OK、`DOMMatrix: function`」就断定已修好，**其实那还是 canvas 提供的**，白推了一次部署。
     → **通用教训二**：本地验证环境与生产环境若差一个「恰好存在的依赖」，结论就是不可信的。先主动把那个依赖从全局抹掉再验。
  3. **不要用 `result.text`，要用逐页拼接**（保留条目，供对照）。pdf-parse 2.x 会在 `text` 里注入 `-- N of M --` 分页标记。换 unpdf 后由 `extractText(mergePages: false)` 逐页返回、内部按 `hasEOL` 补换行（实测与手写拼接一致），但**「提取结果里不能出现解析器自己注入的标记」这个原则仍然成立**。
  4. **`createSignedUrl` 会检查对象是否存在**，不存在时返回 `StorageApiError { statusCode: '404', code: 'NoSuchKey' }`。这是悬挂行的判定信号，**不能当服务端错误抛出去**（否则用户看到 500 而不是"文件没传完"）。
     ⚠️ **这个判定极易漏**：extract 端点修了，download 端点漏了同一处，被端到端冒烟抓到才补上。
     → 谓词统一收在 `lib/syllabi.ts` 的 `isStorageObjectNotFoundError()`，**两处共用，不许各写一份**。注意 `statusCode` 是**字符串** `'404'`，只判数字 404 永远命中不了。
  5. **`extract_method` 有 CHECK 约束**：只能是 `pdf_text` / `docx` / `pptx` / `manual`。注意 `docx`/`pptx` **没有** `_text` 后缀（初版遗留，未为此改生产表），写 `docx_text` 会被 DB 拒绝。
  6. **取不到线上的错误就别猜。** 本次先猜了两轮（worker 文件没打包 → 加 `outputFileTracingIncludes`），全错。
     **有效手段是临时加一个诊断路由**，把 `import` 逐个 try/catch 并把错误消息回传，一次就定位到 `DOMMatrix is not defined`。
     ⚠️ 顺带：App Router 里 **下划线开头的目录（`app/api/v1/_diag/`）是私有目录，不会建路由**，诊断路由要叫 `diag-tmp` 这种名字。
- **关键约束**：
  - **提取失败返回 200，不是 HTTP 错误** —— 文件存下来了，只是读不出文字。前端走 `notice`（提示色）而非 `error`（错误色），文案要写「上传成功，但…」。
  - **取文件用当前用户会话签的 URL，不用 service role** —— 这样下载仍受 `storage.objects` 的 RLS 约束，查询逻辑写错也取不到别人的文件。
  - **幂等**：已 `extracted` 的行直接返回既有结果（文本只依赖不可变的文件内容）。
  - **`raw_text` 写但列表不读**：几 MB 的全文不能进列表响应，只有 extract 端点读它取预览。
- **自测（Bud，2026-09-02）：57/57 全绿** —— 三格式提取正确（含 method / 页数 / pptx 按 slide 数字排序而非字典序）、多页 PDF 页序正确、PDF 行内换行保留、非嵌入标准字体（Times-Roman）可抽、扫描件降级（200 + failed + 原因 + `previewText=null` + method=null）、幂等、**悬挂行 409 `file_missing` + DB 里确认置 failed**、download 悬挂行 404、越权 404、未登录 401、非法 uuid 400、类型不支持 415 / 超限 413、`x-request-id` 回传、Storage 端到端（直传 → 签名下载 → 跨用户被拒 → 测试数据清理）。
- **生产验证（2026-09-02）**：`extract` 未登录 401 / 非法 uuid 400 / download 401 全部恢复正常（此前一律 500）；诊断路由在 **linux + node 24 + DOMMatrix 未定义**的条件下实测提取出正确文本。
  - 测试文件用 python `zipfile` 手工生成最小合法 pdf / docx / pptx（docx、pptx 本质都是 zip + XML），不依赖任何 Office 工具。
- **✅ 浏览器 UI 已由 Steven 本地验收通过（2026-09-02，与 P0-1-1 合并验收）**。
- **已知留白**：① 提取失败的行没有「重试提取」入口（Phase 0 无存量数据，重新上传即可）；② `maxDuration = 60` 是为 20MB PDF 留的，Vercel 套餐若更低需下调。

#### 🎫 P0-1-4 · 五板块抽取 prompt v1 · ✅ 已验收通过（2026-09-02 晚，Steven 验收），勿重做
- **做什么**：把 syllabus 全文解析成五个结构化板块（Grade Composition / Course Outline / Test Dates / Office Hours / Submission Policy）。**只做抽取，不碰 DB**（落库是 P0-1-5）。
- **改哪些文件（全部新增）**：
  - `types/parse.ts` —— 五个板块的对外类型（camelCase），字段与五张表一一对齐
  - `lib/parse/schemas.ts` —— 五个 JSON Schema，模块级 `as const`
  - `lib/parse/prompts.ts` —— 五个板块的 system 指令 + 共通铁律
  - `lib/parse/index.ts` —— `parseSyllabusSections()` 编排 + `PROMPT_VERSION`
- **关键设计**：
  - **每个条目都带 `sourceExcerpt`**（≤200 字原文逐字摘录）。三层作用：① 逼模型为每条结论找依据，编不出来就填 null；② 用户可悬停核对"这句话哪来的"；③ 直接对应五张表都有的 `source_excerpt` 列，P0-1-5 落库零转换。**这是本 task 抗幻觉的核心手段。**
  - **五块各一次独立 LLM 调用，并发执行**。不合并成一次大 JSON：一次跑偏会污染整个响应，且拆开后可单块重试、可按板块统计准确率定位要改哪个 prompt。
  - **`ExamDate.status` 由 `examDate` 派生，不让模型填** —— 否则一定会出现「日期是 null 但 status 写 confirmed」的矛盾数据。
  - **日期必须是 `YYYY-MM-DD`**，格式不合法一律置 null 退化成 TBD。理由：格式错的字符串既进不了 `exam_dates.exam_date`（`date` 列），展示给用户也是误导。
  - **文本少于 200 字符直接拒绝解析**（`text_too_short`，不发起 LLM 调用）—— 扫描件走到这里就该停，而不是让模型编一份课表出来。
  - **所有字段保留原文语言，不翻译**：抽取层的首要目标是可核对，译文无法与原文比对；翻译不可逆，抽取层丢掉的原文找不回来。展示层要翻译是后话。
- **🔴 踩过的坑 / 实测结论**：
  1. **模型确实会翻译**。第一版没写语言规则，submission policy 的 `description` 被翻成中文，而 `examName` / `topic` 等逐字字段仍是英文 —— 同一份结果里语言不一致。补了铁律第 5 条后恢复一致。
  2. **反幻觉测试必须主动埋陷阱**。测试样例里故意写了「Final: 按校历安排，没有确切日期」和「practical exam 日期见 bCourses」，模型两次都正确返回 `null` + `tbd`，**没有编造日期**。不埋这种陷阱就测不出"禁止编造"到底成不成立。
  3. **占比不等于 100% 时不要补项**是 prompt 里必须写死的一条 —— "为了凑满 100 分而补一条原文没有的构成项"是最典型的编造，模型默认倾向这么做。
  4. 同一类考核多次出现（每周 homework）会被合并成一条并把规则写进 `notes`，符合预期。
- **自测（Bud，2026-09-02）：全绿** —— 完整 syllabus 五块全成功（评分 4 项权重 20/25/25/30 全对、大纲 15 周顺序与 orderIndex 全对、3 条 office hours 时间正确换成 24 小时制、2 条提交政策）；缺 office hours 的 syllabus 该块返回**空数组而非编造**；两处「日期不明」的考试都退回 `null` + `tbd`；扫描件（17 字符）与空文本都被 `text_too_short` 挡住且**未发起 LLM 调用**；审计 12 行全部 success、`prompt_version` 一致为 `v1`、purpose 按板块区分。
- **验收证据（Bud，2026-09-02 晚，Steven 验收时现场跑）**：临时路由 `app/api/v1/diag-parse`（内嵌 CS 61B 风格 syllabus，1970 字符）→ `NODE_OPTIONS= npm run build` → `npm run start`（后台）→ curl → 删路由 → 重建。**全程本地，不部署不推送**，路由已删、`git status` 干净。
  - **五板块全 ok，耗时 3.2s**（五块并发），`meta.promptVersion: v1`、`truncated: false`。
  - **反幻觉两个陷阱全过** —— 「Final Exam: scheduled by the university registrar according to the academic calendar」→ `examDate: null` + `status: tbd`；「Practical Exam: Date and location will be announced on bCourses later」→ 同样 `null` + `tbd`。**模型没有编造日期**，且两条的 `sourceExcerpt` 都逐字摘录了原文整句，可核对。
  - 其余：权重 20/25/25/30 全对且「drop the lowest score」正确进 `notes`；15 周 `orderIndex` 1-15 全对；office hours 时间正确转 24h（2:00-3:30 PM → `14:00-15:30`、4:00-5:00 PM → `16:00-17:00`）；submission policy 的 `description` **保留英文原文未翻译**（语言铁律生效），`platformName: Gradescope`。
  - ⚠️ 本次审计行**没写进 `llm_runs`**（脚本用假 userId、无会话，RLS 拒掉）—— 属预期，审计落库与 RLS 隔离已由 P0-1-3 单独验过。
  - **没有 tsx / ts-node / esbuild**（devDeps 只有 typescript + eslint + tailwind），直接跑 TS 会引入新依赖违反 Diff First，所以走临时路由 + `next build`/`next start` 这条路。
- **已知留白**：① 超长文本（>30000 字符）从尾部截断，而 office hours / 提交政策常写在文末 —— 正确做法是分块 + 合并，Phase 0 先只做 `meta.truncated` 标记；② 没有"占比之和≠100"的校验提示（留给 P0-1-5 的 UI）；③ 没有单块重试（Phase 0 由调用方按 `retryable` 决定）；④ **提交政策粒度偏粗（2026-09-02 晚 Steven 裁定：接受，Phase 0 不改）**：验收实测里 syllabus 的 HOMEWORK POLICY 段含两条规则（迟交扣分 + 代码格式），模型**合并成 1 条** policy。可辩护（同属一个 section），不是正确性问题。**不升 `PROMPT_VERSION`**（仍为 `v1`）。触发重开条件：真实 syllabus 跑下来显示粒度影响可用性 —— 届时单独立项升 `v2`，不在本卡里改。

#### 🎫 P0-1-3 · LLM provider 抽象层（`lib/llm`）· ✅ 已完成，勿重做
- **做什么**：按 [ADR-003](./Decisions.md#adr-003) 建可插拔 LLM 抽象层，默认 DeepSeek；结构化输出走 JSON schema；每次调用落 `llm_runs` 审计。
- **改哪些文件（全部新增）**：
  - `lib/llm/types.ts` —— `LLMProvider` 接口 + `LLMResult<T>` 判别联合 + `LLMErrorCode` + JSON Schema 子集
  - `lib/llm/env.ts` —— 环境变量读取与校验，缺 key / 坏值抛 `LLMConfigError`（明确中文，可直接照做）
  - `lib/llm/schema.ts` —— `validateJsonSchema()`，校验模型输出是否符合 schema，返回带 JSON Pointer 的中文错误
  - `lib/llm/providers/deepseek.ts` —— DeepSeek adapter，**原生 `fetch`，不引厂商 SDK**
  - `lib/llm/index.ts` —— `getLLMProvider()` 唯一入口
  - `lib/llm/run.ts` —— `runStructured()`：调模型 + **每次调用写 `llm_runs`**（成功与失败都写）
  - `.env.example` / `.env.local` —— 登记 `LLM_PROVIDER` / `DEEPSEEK_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT_MS`
- **关键约束**：
  - **业务代码只依赖 `LLMProvider` 接口**，不许 import 厂商 SDK —— 换 provider 只改 `LLM_PROVIDER`。
  - **厂商异常绝不穿透**：配置错误 / 网络失败 / 非 2xx / 非法 JSON / 不符 schema，一律收敛成 `LLMResult` 的 error 分支。
  - **`llm_runs` 只存元数据，不存 prompt 与响应原文**（`Security-Privacy.md` 第 8 节）；`error_message` 只有错误分类 + 精简说明，截断 500 字符，不含 syllabus 内容。
  - **审计失败不影响调用结果**：度量表写不进去，不该让用户这次解析白跑一遍。用会话 client（不是 service role），即便 `user_id` 传错也只是写不进去，不污染别人数据。
  - **`providers/claude.ts` 故意不写**：一段从未调通过的死代码比明确报错更危险。要切 Claude 时先写 adapter + 自测。
- **🔴 踩过的坑（下一个人别再踩）**：
  1. 🔥 **`llm_runs.model` 必须记「实际服务的模型」，不能记「请求时填的模型」。** 实测请求 `deepseek-chat`，响应里回来的是 `deepseek-v4-flash`。别名会静默指向不同底座，记别名的话将来按模型维度对比解析准确率就失真了。只有拿不到 usage 时才退回配置值。
  2. **环境变量覆写做分支测试时，每个 case 前必须先恢复原值。** 本次诊断路由的循环只在中途恢复一次，导致「缺 key」「坏 timeout」两个 case 实际测到的都是上一个 case 泄漏的 `LLM_PROVIDER=openai`，报错全变成「provider 名不合法」，把真实错误掩盖了。
  3. **改完路由要重建再测**：删掉路由后 `.next/types/validator.ts` 仍留着旧引用，`tsc --noEmit` 会报 `Cannot find module '.../diag-tmp-llm/route.js'`。这不是代码问题，重建一次即可。
- **自测（Bud，2026-09-02）：全绿**。配置读取、schema 校验器 7 个用例（含可空字段 / 数组项 / 枚举 / integer 当 number）、4 类配置错误各有明确中文报错、真实调用成功（MATH 53 样例抽出 4 项权重全对，920ms）、`schema_mismatch`（retryable=true）、错误 key → `provider_error`（retryable=false）、1ms 超时 → `request_failed`（retryable=true）、审计成功行与失败行都落库、**RLS 跨用户隔离**（user2 查 `llm_runs` 得 0 行，user1 得 3 行）。
- **✅ Steven 手动项已完成（2026-09-02）**：
  1. **Vercel 环境变量**：`DEEPSEEK_API_KEY` 已加（Production），已 Redeploy。
  2. **测试账号已删**：`llm-diag@test.dev` / `llm-diag2@test.dev`（Bud 无 service role key，删不掉）。`llm_runs` 测试行已清空。
  3. **已 push**：`de7c02d`（P0-1-3）+ `85ab88f`（P0-1-4）已到 `origin/main`。
- **⚠️ 生产验证并入 P0-1-5（2026-09-02，Steven 拍板 Option A）**：
  - **原因**：`lib/llm` 是**纯库层，零 HTTP 出口** —— 现有 6 个端点没有任何一个 import 它，唯一引用方是 `lib/parse/index.ts`（同样无路由引用）。**打生产域名验证不到它**，第一个真正调 LLM 的端点是 P0-1-5。
  - **为什么可以延后**：`lib/llm` 用原生 `fetch`，**无原生二进制、无浏览器 API、无 worker/wasm** —— 与当初 PDF 那个坑（缺 `@napi-rs/canvas` 原生二进制导致 import 即 500）性质完全不同，本地绿但线上炸的概率低。残留风险只剩「key 是否真注入 deployment」，而它的失败方式是**响亮的**（抛中文 `LLMConfigError`），不是静默错误数据。
  - **P0-1-5 验收时必须补做**：真实调一次 DeepSeek，确认 ① key 注入生效 ② adapter 在 Vercel runtime 跑通 ③ `llm_runs` 审计行落库。
- **已知留白**：① 没有重试逻辑（Phase 0 由调用方决定是否重试，`retryable` 字段已给出依据）；② 没有并发/限流控制；③ `syllabus_parse` 的 prompt 本体在 P0-1-4。

#### 🎫 P0-1-5a · 解析 API 路由 + 五板块落库（`/parse` / `/reparse`）· ✅ 已完成，勿重做

- **做什么**：上传流程第 4 拍 —— 拿 `syllabi.raw_text` 调 LLM 抽五板块，**落进五张板块表**，返回带 id 的板块数据。
- **依赖**：P0-1-2（文本）、P0-1-4（抽取）、P0-1-7（课程）。
- **改哪些文件**：
  - `types/sections.ts`（新）—— `StoredXxx` 五个「已落库记录」类型 + `StoredSections`（**键可选**：解析失败的板块不给空数组）
  - `lib/{grade-components,course-outline-items,exam-dates,office-hours,submission-policies}.ts`（新）—— 各表的 `*_COLUMNS` 字面量 + `Row` 类型 + `toXxx()` + `toXxxInsert()`。**每张表只有自己这个文件知道 DB 列名**
  - `lib/parse/persist.ts`（新）—— 落库编排：逐表「先删后插」，只处理 `sections.<k>.ok` 的板块
  - `lib/parse/endpoint.ts`（新）—— `/parse` 与 `/reparse` 共用的处理逻辑（两个路由文件各 4 行）
  - `app/api/v1/syllabi/[id]/{parse,reparse}/route.ts`（新）
  - `lib/parse/index.ts` —— `SECTION_CONFIG.purpose` 拆成 `purposeSuffix`，新增 `purposePrefix` 入参（区分 `syllabus_parse` / `syllabus_reparse`）
  - `types/syllabus.ts` —— 新增 `SyllabusParseResponse`
- **🔴 关键约束（改动前必读）**：
  1. **判断"有没有可落库的结果"看 `okSections.length`，不是 `ok`** —— 五块全成才 `ok=true`，部分成功是常态。
  2. **`ExamDate.status` 由 `examDate` 派生**（`lib/parse/index.ts` 的 `normalizeExam()` 已做），落库时**不要重算**，直接沿用。同一件事算两遍迟早算出不一致。
  3. **`lib/parse/index.ts` 不碰 DB** —— 落库只在 `persist.ts`。
  4. **落库写入规则（最终版，③ 被 5a 冒烟实测推翻后修订）**：① 只对成功的板块动刀（失败的保留上一轮数据）；② 只删 `source='syllabus'` 的行，整体替换；③ `source='manual'` 的行保留。~~原第三条「`is_confirmed=true` 不删」已废弃~~ —— 它会导致同一条目在重解析后出现两份（旧行保留 + 新行插入），完整理由见 `persist.ts` 头部注释与 ADR-012。
  5. **`parse_status` 只有 `completed` / `failed` 两态** —— 契约里的 `partial` 不在 DB CHECK 约束内，写进去会被拒。部分失败用 `parse_error` 表达。
  6. **同步 200，不是 202**（[ADR-012](./Decisions.md#adr-012)）；`parseStatus` 已是 `completed` 时 `/parse` 返回 **409 `already_parsed`**，重跑走 `/reparse`。
- **验收命令**：`NODE_OPTIONS= npx tsc --noEmit` ｜ `NODE_OPTIONS= npm run lint` ｜ `NODE_OPTIONS= npm run build`（新增 2 个 ƒ 路由）｜ `next start` + 会话 cookie 打 curl 冒烟 ｜ 生产域名实跑一次。
- **✅ 自测结果（2026-09-03）**：本地 curl 冒烟 **44/44**；生产验证 **14/14**。
  - 正常路径：建课 → 上传 → 提取 → 解析全链路通；成绩 4 项、考试 4 项（**反幻觉陷阱 2 项仍返回 null + tbd**）、大纲 15 周、OH 3 条（时间转 24h）、提交政策带 Gradescope；每条都带 `sourceExcerpt`；`x-request-id` 回传。
  - 幂等 / 覆盖：重复 parse → **409 already_parsed**；`reparse` 强制重跑；`source='manual'` 的行不被冲掉；`syllabus` 来源的行整体替换旧 id 全部消失且**无重复**。
  - 异常路径：未登录 401 / 非法 uuid 400 / 不存在 uuid 404 / B 解析 A 的 syllabus 404 / extract 未完成 **409 text_not_ready**。
  - 全失败路径：文本 47 字符 → **HTTP 200** + `parseStatus='failed'` + 五块全 `text_too_short`（不发起 LLM 调用）。
  - 生产：`/parse` 端到端 **4.4 秒**，`llm_runs` 落 5 条 success（模型 `deepseek-v4-flash`，单块 2.3~3.5 秒）。
- **⚠️ 验收时必须补做 P0-1-3 / P0-1-4 的生产验证**：`lib/llm` 与 `lib/parse` 都是零 HTTP 出口的纯库层，此前只在本地验过，P0-1-5a 是第一个能打到它们的端点。已于 2026-09-03 补做完毕（见上）。
- **已知留白**：① **无跨表事务**（supabase-js 不支持），逐表先删后插，中途失败会留下部分写入（失败即 500，重试可自愈）；② `llm_run_id` 归因不在五张板块表上（表无此列），只在 `parse_corrections`（P0-1-5b）；③ `GET /parse-status` 不实现（同步模式无中间态）。
- **P0-1-5b 接着做**：5 个 `PUT` 板块保存端点 + `parse_corrections` diff + `exam-dates → tasks` 派生（`syncExamToTask()`）。

#### 🎫 P0-1-5b · 五板块保存端点 + 修正 diff + 考试派生 · 🟡 代码完成 / 本地 56/56 + 生产 18/18 / 待 Steven 验收
- **做什么**：`PUT /api/v1/courses/:id/{grade-components,outline-items,exam-dates,office-hours,submission-policies}`（API-Contract §4），全量替换 + 幂等 + 字段级 diff 留痕 + exam → tasks 派生。
- **改哪些文件**：
  - `lib/parse/save.ts`（新）—— 共用编排 `handleSectionSave()`：课程校验 → 解析输入 → 读现有行 → diff → 插/改/删 → 写修正 → exam 派生 → 返回 `{ data: [...] }`。路由文件只是 15 行的分发壳。
  - `lib/parse/corrections.ts`（新）—— diff 核心：按 id 匹配，`edit`（变更字段逐条）/ `add`（新行有值字段逐条）/ `delete`（被删行原有值逐条）三类修正；归因 = 最新 syllabus 的最近一次成功 `llm_run`；**幂等保存不写任何修正行**。
  - `lib/sync/exam-tasks.ts`（新）—— `syncExamToTask()`：ADR-004 派生规则唯一落点。`status='done'` 不被重置；考试删 → 派生 task 物理删除；`due_date` = 当日 23:59:59（`exam_time` 自由文本 Phase 0 不解析）。
  - `lib/api/input.ts`（新）—— 五个校验器共用的文本/id/日期/百分数助手（`lib/courses.ts` 的老副本不动）。
  - 五个 `lib/<表名>.ts` —— 各加 `parseSave*Input()` 校验器 + `to*SaveInsert/Update()`（插入行 `source='manual'`、`is_confirmed=true`；大纲 `order_index` 由数组位置派生）。
  - `lib/parse/persist.ts` —— **5a 代码的一处新增**：解析落库 exam 后也调 `syncExamToTask()`（否则解析成功后总览页永远缺考试，直到用户手动保存一次考试板块）。
  - `app/api/v1/courses/[id]/{五个板块}/route.ts` —— 5 个新路由。
- **🔴 关键约束（改动前必读）**：
  1. **diff 只看内容字段**：`order_index` 不进修正（重排序不是解析错误）；`is_confirmed` / `source` / `source_excerpt` 也不进（不是用户编辑的对象）。
  2. **表单带库里没有的 id → 400**（`details.staleIds`），不当新增处理 —— 否则并发修改会造出重复行。
  3. **修正只在 `parse_corrections`**（五张板块表无 `llm_run_id` 列，ADR-012）；无 syllabus 的课程归因为 null，不阻断保存。
  4. **`syncExamToTask()` 是 `tasks` 里考试派生行的唯一写入口**（Database.md 5.3），别在别处零散 insert。
- **自测（Bud，2026-09-03）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅（5 个新 ƒ 路由）｜ 冒烟 **56/56**（真实 `/parse` 一条：syllabus 来源行编辑后修正带非 null `llm_run_id` 且在 `llm_runs` 真实存在）。
- **✅ 生产验证（2026-09-03，`a959d45` 部署 success 后实跑）**：冒烟 **18/18**——路由存在、grade-components 全流程（含 edit 修正 `weight_percent 20→25` 落库）、exam 派生（23:59:59 / tbd→null / 派生标记）、真实 `/parse` + 归因（`llm_run_id` / `syllabus_id` 均 non-null）、未登录 401 / 跨用户 404 / 非法日期 400、测试数据清干净。本次部署创建很快（未复现 13 分钟延迟）。
- **已知留白**：① 无跨表事务（与 5a 同），插/改/删 + 修正 + 派生分步执行，中途 500 重试自愈；② 测试账号 `p15b-a/p15b-b@test.dev` + 生产 `p15b-prod/p15b-prod2@test.dev` 留在 auth.users 待 Steven 手动删（业务数据已清干净）。

#### 🎫 P0-1-7 · Workspace CRUD（课程创建 / 列表 / 编辑 / 删除）· ✅ 已完成，勿重做
- **做什么**：课程 CRUD。列表按学期分组展示；删除 = 归档，带二次确认。
- **改哪些文件**：
  - `types/course.ts` —— `Course`（对外形状，camelCase）/ `CreateCourseInput` / `UpdateCourseInput` / `ApiErrorBody`
  - `lib/courses.ts` —— `CourseRow` + `COURSE_COLUMNS`（唯一知道 DB 列名的地方）、`toCourse()` 行→响应映射、`parseCreateCourseInput()` / `parseUpdateCourseInput()` 校验、`toCourseInsert()` / `toCourseUpdate()` 列映射
  - `lib/api/response.ts` —— `jsonOk` / `jsonError` / `internalError` / `getCurrentUser`，含 `x-request-id` 原样回传（契约 1.5）
  - `app/api/v1/courses/route.ts` —— `GET` 列表 / `POST` 新建
  - `app/api/v1/courses/[id]/route.ts` —— `PATCH` 更新 / `DELETE` 归档
  - `components/courses/{course-form,course-card,course-create-panel}.tsx`
  - `app/(routes)/dashboard/page.tsx` —— 改为课程列表页（**没有新增 `/courses` 路由**）
- **关键约束**：
  - **删除 = 归档**：`courses` 表没有 `is_deleted` 字段，只有 `is_archived`（`Database.md` 4.4 软删除约定）。`API-Contract.md` §2 对 `DELETE` 的描述也是 `is_archived=true`，两边一致。
  - **PATCH 语义**：`undefined` = 该字段不改，`null` = 清空该字段。`semester` / `courseName` 是 DB `NOT NULL`，**不允许被清空**，传 null 返回 400。
  - **✅ 契约偏离已被接受并升格为 ADR-010**：契约 1.2 原要求"资源不属于当前用户返回 403"，但 RLS 让别人课程在当前会话下查不出来，服务端无法区分「不存在」与「不是你的」；用 service role 绕过 RLS 探测存在性反而制造泄漏口子，与 403-not-404 的意图相悖 → **统一返回 404**，文案「课程不存在或无权访问」。**Steven 于 2026-09-02 拍板接受**，已写入 [ADR-010](./Decisions.md#adr-010) 并同步改 `API-Contract.md` §1.2 / §1.4（403 标为 Phase 0 不使用）。**适用于所有受 RLS 保护的资源端点，后续 task 不再逐个论证。**
  - **GET 列表返回扁平 `data`**，分组在前端做；**暂不含 `upcomingTasks` 字段**（P0-1-9 总览页时补）。刻意不返回硬编码 `[]` —— 那样将来"有任务却显示空"是静默错误数据。
  - **越权不在应用层判断**：RLS 已保证只能看到自己的行，`getCurrentUser()` 只负责判登录。
  - **前端校验只管体验**，服务端 `parseXxxInput()` 才是权威（ADR-009 已把这条写进评审清单）。
  - `toCourse()` 对约束外的 `sync_status` 是 **抛错**而非给兜底值 —— 该字段会直接展示成同步状态，编一个出来就是假数据。DB 有 CHECK 约束，正常不会触发。
- **自测（Bud，2026-09-02）**
  - `NODE_OPTIONS= npx tsc --noEmit` ✅ ｜ `NODE_OPTIONS= npm run lint` ✅ ｜ `NODE_OPTIONS= npm run build` ✅（4 个新端点均为 ƒ 动态路由）
  - **API 层 16 项 curl 冒烟全过** —— 沙箱里 `next dev` 起不来但 `next start` 能起（见 `CodingRules.md` §5），配合临时脚本导出真实会话 cookie 打穿了：建课 / 改名 / 归档 / 列表、6 条异常路径（缺字段、类型错、`semester=null`、空 PATCH、非法 uuid、不存在的 uuid）、跨用户越权隔离、`x-request-id` 回传。
- **✅ 浏览器 UI 已由 Steven 本地验收通过（2026-09-02）**：建课表单、编辑切换、删除二次确认三个交互 + 列表展示均正常。
- **已知留白**：列表不显示 syllabus 状态（P0-1-1 之后才有意义）；`upcomingTasks` 待 P0-1-9；`GET /api/v1/courses/:id` 详情（含五板块）属 P0-1-8。

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
| 2026-09-02 | P0-0 基础设施全部完成：P0-0-3 Auth ✅（Next 16 middleware 改名为 proxy）+ P0-0-4 13 表迁移 ✅ + P0-0-5 RLS + handle_new_user ✅ + P0-0-6 Vercel 部署 ✅（生产 URL `tempo-six-neon.vercel.app`，Steven 实测生产冒烟通过）；进度指针推进至 P0-1 M1（syllabus 静态理解）。**记录四个部署坑**：git author 不匹配 GitHub / `cookies()` 顺序错 / env vars 保存≠注入 / `NEXT_PUBLIC_*` 别勾 Secret |
| 2026-09-02 | **执行顺序调整（Steven 拍板）**：`P0-1-7` 课程 CRUD 提前至 `P0-1-1` 上传之前（`syllabi.course_id` 为 NOT NULL，无课则无上传落点）。**task 编号一律不变**，顺序以「当前进度指针」为准，表格行序仅服务编号可读性。同日决策：上传改浏览器直传（新增 [ADR-009](./Decisions.md#adr-009)）；Storage 桶规范并入 P0-1-1 交付 |
| 2026-09-02 | **P0-1-7 交付并验收通过 ✅**（commit `494c9ec` + `f380ef0` + `8e466f7`，已推 origin/main 并自动部署）。API 层 16 项 curl 冒烟全过，浏览器 UI 由 Steven 本地验收通过。**403→404 契约偏离经 Steven 拍板接受，升格为 [ADR-010](./Decisions.md#adr-010)**，`API-Contract.md` §1.2 / §1.4 同步修改，适用于所有受 RLS 保护的资源端点。进度指针推进至 `P0-1-1` |
| 2026-09-02 | **P0-1-1 开发完成（待 Steven 执行 Storage 迁移后终验）**：新增 `Database.md` 7.3 Storage 小节 + 迁移 `20260902220000_storage_syllabi.sql`；上传改两步式直传（[ADR-009](./Decisions.md#adr-009)）；新增 `GET /api/v1/syllabi/:id/download`；`API-Contract.md` §3 的 multipart 契约作废改写为两步式。**API 冒烟 19 项过 18 项，唯一未过的 201 正常路径卡在迁移未执行**（RLS 拒绝一切 `storage.objects` insert）。新增 P0-1-1 执行卡 |
| 2026-09-02 | **Storage 迁移执行方式修正**：`CREATE POLICY on storage.objects` 在 SQL Editor 报 `42501: must be owner of table objects`（该表 owner 是平台内部的 `supabase_storage_admin`）。迁移文件改写为 **Dashboard UI 操作步骤 + SQL 语义留档 + 可跑的验收 SELECT**；`Database.md` 7.3 与 P0-1-1 执行卡同步修正 |
| 2026-09-02 | **P0-1-1 复测全绿 ✅**：Steven 通过 Dashboard UI 建好桶与 4 条策略后，API 冒烟 **19/19** + Storage 端到端直探 **7/7**（含跨用户隔离）。测试数据已清理。P0-1-1 与 P0-1-2 的浏览器 UI **合并验收**（共用同一组件） |
| 2026-09-02 | **P0-1-2 文本提取管线完成 ✅**：新增 `lib/extract.ts`（pdf / docx / pptx 三格式）+ `POST /api/v1/syllabi/:id/extract`；`TechStack.md` 登记 `pdf-parse` 2.4.5 / `mammoth` 1.12.2 / `jszip` 3.10.1；`API-Contract.md` 新增 extract 端点并**修正「201 响应带 previewText」的设计错误**（签票据时文件还没传上来）；抽出 `lib/api/params.ts` 的 `UUID_PATTERN`；`next.config.mjs` 加 `serverExternalPackages: ['pdf-parse']`。**端到端冒烟 27/27 全绿**。进度指针推进至 `P0-1-3` LLM provider 抽象层 |
| 2026-09-02 | 🔥 **生产事故修复：PDF 提取器由 `pdf-parse` 2.4.5 换成 `pdfjs-dist` 5.4.296（legacy 构建）**。`pdf-parse` 模块顶层无条件 `new DOMMatrix()`，DOMMatrix 靠 `require('@napi-rs/canvas')` 补、加载失败只 warn 不赋值 → **Vercel 上 extract 路由 import 即 500（空响应体）**，本地 macOS 因装有 23MB 原生二进制而全绿。排查手段：临时诊断路由逐个 `import` 抓错误消息（**下划线目录 `_diag` 是私有目录不建路由，改名 `diag-tmp` 才生效**）。连带把 `isStorageObjectNotFoundError()` 抽到 `lib/syllabi.ts` 共用，并修掉 **download 端点漏判 `NoSuchKey` 导致悬挂行返回 500** 的真 bug（冒烟抓到）。`API-Contract.md` 补 download 的 `404 file_missing` 语义与提取器换版记录。**端到端冒烟 41/41 全绿** |
| 2026-09-02 | 🔥🔥 **生产事故修复（第二轮，最终方案）：PDF 提取器定为 `unpdf` 1.8.1**。上一轮的 `pdfjs-dist` legacy 构建**在 Vercel 上同样 500** —— 我此前「legacy 自带 DOMMatrix polyfill」的判断是错的，本地看到的 `DOMMatrix` 其实仍由 `@napi-rs/canvas` 提供，**本地测试环境被同一个「只存在于本地的依赖」污染**。三者（pdf-parse、pdfjs 现代构建、pdfjs legacy 构建）死在同一处：模块作用域 `new DOMMatrix()`，canvas 缺失时只 warn 不赋值。unpdf 自带为 serverless 重打包的 pdfjs（worker 内联 + 剥浏览器 API + 补全局对象），**零运行时依赖、不需要 canvas**。`pdfjs-dist` 保留为**纯数据依赖**（`standard_fonts/` + `cmaps/`，靠 `outputFileTracingIncludes` 打进函数包）。同步新增 [ADR-011](./Decisions.md#adr-011)。**本地端到端冒烟 57/57 全绿；生产实测（linux / node 24 / DOMMatrix 未定义）提取正常，extract 与 download 端点 401/400 均恢复正常** |
| 2026-09-02 | **P0-1-1 + P0-1-2 浏览器 UI 验收通过 ✅（Steven 本地，合并验收，共用 `syllabus-upload.tsx`）**。M1 前三个 task（P0-1-7 / P0-1-1 / P0-1-2）全部收口，两张执行卡标注「勿重做」。进度指针维持 `P0-1-3` LLM provider 抽象层（下一 task） |
| 2026-09-02 | **P0-1-3 LLM provider 抽象层完成 ✅**。新增 `lib/llm/` 六件套：`index.ts`（`getLLMProvider()`）/ `types.ts`（`LLMProvider` + `LLMResult<T>` + `LLMErrorCode` + JSON Schema 子集）/ `env.ts`（缺 key、坏 timeout 抛明确中文 `LLMConfigError`）/ `schema.ts`（`validateJsonSchema()`，报错带 JSON Pointer）/ `providers/deepseek.ts`（原生 fetch，不引厂商 SDK）/ `run.ts`（`runStructured()` 每次调用写 `llm_runs`，成功失败都写）。抽象层硬性要求 5 条全部满足（只依赖接口、切换只改配置、厂商异常不穿透、每次调用记审计、结构化输出走 schema 禁正则解析）。**实测踩到一个真教训**：请求 `deepseek-chat` 回来的是 `deepseek-v4-flash`，因此 `llm_runs.model` 记「实际服务的模型」而非「请求时填的模型」，否则按模型维度对比准确率会失真。自测全绿：配置 4 类错误各有明确中文报错、schema 校验器 7 用例、真实调用成功（MATH 53 权重 4 项全对）、`schema_mismatch` / `provider_error` / `request_failed` 三条错误分支的 `retryable` 判定正确、审计成功行与失败行都落库、**RLS 跨用户隔离**（user2 查得 0 行 / user1 得 3 行）。`TechStack.md` §5.2 同步补齐实际文件结构、环境变量表与错误码表。进度指针推进至 `P0-1-4` 五板块抽取 prompt v1 |

| 2026-09-02 | **P0-1-4 五板块抽取 prompt v1 完成 ✅**。新增 `types/parse.ts` + `lib/parse/`（`schemas.ts` / `prompts.ts` / `index.ts`），`parseSyllabusSections()` 五板块**并发**独立调用、单块失败不影响其余。核心设计 **`sourceExcerpt`**：每个条目带 ≤200 字原文逐字摘录，逼模型给依据 + 用户可核对 + 直接对应五张表的 `source_excerpt` 列。日期处理三条硬规则：`ExamDate.status` 由 `examDate` **派生**（不让模型填，否则必出现"日期 null 但 status=confirmed"）、日期必须 `YYYY-MM-DD` 否则置 null 退化 TBD、文本少于 200 字符直接 `text_too_short` **不发起 LLM 调用**。**自测埋了两个反幻觉陷阱**（Final 只写"按校历安排"、practical exam 日期见 bCourses），模型两次都正确返回 null + tbd，未编造日期；缺 office hours 的 syllabus 该块返回空数组而非编造。**实测踩坑**：未写语言规则时模型把 submission policy 的 `description` 翻成中文，与逐字字段的英文不一致 —— 补铁律「保留原文语言不翻译」（翻译不可逆，抽取层丢的原文找不回来）。自测全绿，进度指针推进至 `P0-1-5` 解析 API 路由 + 落库 + 修正 diff |
| 2026-09-03 | **P0-1-5 拆为 5a / 5b 两张执行卡**（Steven 拍板，编号不变）。**P0-1-5a 开工并完成代码**：新增 `types/sections.ts`、五张板块表的 DB 映射层 `lib/{grade-components,course-outline-items,exam-dates,office-hours,submission-policies}.ts`、落库编排 `lib/parse/persist.ts`、共用逻辑 `lib/parse/endpoint.ts`、`POST /api/v1/syllabi/:id/{parse,reparse}` 两个端点。**契约偏离两项并已升格为 [ADR-012](./Decisions.md#adr-012)**：① `/parse` 同步返回 200（契约原写 202 异步 + 轮询，但实测五板块并发仅 3.2s，且 `llm_runs` 没有板块级进度的存储落点）；② `syllabi.parse_status` 只有 completed/failed 两态，契约原写的 `partial` 不在 DB CHECK 约束内。`GET /parse-status` 标注为 P0-1-11 待定。落库最终规则（初版「`is_confirmed=true` 不删」被冒烟实测推翻，会造成重复数据）：**只动成功的板块 / 只删 `source='syllabus'` 的行整体替换 / `manual` 来源保留**。`GET /parse-status` 标注为 P0-1-11 待定。本地冒烟 44/44，生产验证 14/14（`/parse` 端到端 4.4s，`llm_runs` 落 5 条 success，`deepseek-v4-flash`），P0-1-3/1-4 挂账的生产验证就此关闭。**Steven 验收通过，测试账号已清理**，进度指针推进至 P0-1-5b（开工提示见进度指针区） |
| 2026-09-03 | **P0-1-5b 代码完成（待 Steven 验收）**：5 个 `PUT` 板块保存端点 + 字段级 diff（`lib/parse/corrections.ts`，edit/add/delete 三类统一，`order_index` 除外）+ `syncExamToTask()`（`lib/sync/exam-tasks.ts`，ADR-004 唯一落点）+ `persist.ts` 接入派生（解析后也产 task）。实现期决策（写入 `API-Contract.md` §4 变更记录，无需 ADR）：request 不含 `status`（由 examDate 派生）、response 为 `{ data: [...] }`、归档课程保存 404、归因取「最新 syllabus 最近一次成功解析」。本地冒烟 56/56（含真实 `/parse` 归因验证）。进度指针推进至 P0-1-6（纯前端，后端全部就绪） |
| 2026-09-03 | **P0-1-5b 生产验证通过**：两个 commit（代码 `638a331` + 文档）push 后 Vercel 部署 success，生产冒烟 **18/18**（路由存在 / grade-components 全流程含 edit 修正 / exam 派生 23:59:59 + tbd→null / 真实 `/parse` + `llm_run_id`·`syllabus_id` 归因 / 401 / 跨用户 404 / 非法日期 400 / 数据清理）。临时脚本已删，测试账号留 auth.users 待 Steven 手动删（本地 `p15b-a/b@test.dev`、生产 `p15b-prod/prod2@test.dev`） |
