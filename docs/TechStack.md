# TechStack.md — Tempo 技术栈规范

> ⚠️ **给 Coder AI 的强制规则**：本项目的技术选型已经锁定，不允许自行替换成其他框架/库，哪怕你认为某个替代方案"更好"。每次开始新的开发阶段前，先完整阅读本文档。
> 战略方向见 [`Tempo_产品总蓝图.md`](./Tempo_产品总蓝图.md)，需求见 [`PRD.md`](./PRD.md)，选型理由见 [`Decisions.md`](./Decisions.md)，同步细节见 [`Sync-Strategy.md`](./Sync-Strategy.md)。

---

## 1. 总体架构

Tempo 采用 **Next.js 全栈 + Supabase 后端即服务（BaaS）** 的架构，前后端在同一个代码仓库里，适合个人/小团队快速迭代。

```
用户浏览器
   │
   ▼
Next.js App（前端页面 + Route Handlers 后端逻辑）
   │
   ├──► Supabase（PostgreSQL 数据库 + Auth 用户认证 + Storage 文件存储）
   ├──► LLM Provider（可插拔，默认 DeepSeek）
   └──► Canvas REST API（服务端发起，用用户加密存储的 Personal Access Token）
```

**一条贯穿架构的约束**：所有涉及密钥（Canvas token、LLM API key、数据库密钥）的逻辑**只能**在服务端（Route Handlers / Server Actions）执行，绝不能出现在前端代码或响应体中。

---

## 2. 前端

- **框架**：Next.js **16.3.4**（**App Router**，不用 Pages Router；配套 React 19）
- **语言**：TypeScript（不用纯 JavaScript）
- **样式**：Tailwind CSS **4.3.3**（v4 CSS-first，无 `tailwind.config.ts`，配色走 `globals.css` 的 `@theme`）
- **组件库**：shadcn/ui **4.x**（按需复制组件到项目，不是传统 npm 依赖包）
- **状态管理**：优先用 React 自带 `useState` / `useContext` / Server Components 数据获取；除非页面状态非常复杂，否则**不引入** Redux / Zustand 等额外状态管理库

### 🔒 版本锁定矩阵（唯一事实源）

> **强制规则**：以下版本已锁定。安装任何依赖**禁止使用 `@latest`**；新增依赖前先查本表，锁了用锁定的，没锁先提出拍板再装。

| 依赖 | 锁定版本 | 用途 | 关键备注 |
|---|---|---|---|
| `next` | `16.3.4` | 全栈框架 | App Router；16 起 `next lint` 已移除，lint 走 `eslint .` |
| `react` / `react-dom` | `19.2.8` | UI 框架 | Next 16 配套 |
| `typescript` | `5.x` | 语言 | |
| `tailwindcss` | `4.3.3` | 样式 | v4 CSS-first，配 `@tailwindcss/postcss` |
| `shadcn` | `4.x` | 组件库 | base-nova 主题；按需复制组件 |
| `eslint` | `9.39.5` | 静态检查 | **锁 9 不升 10**（ESLint 10 太新，`eslint-plugin-react` 未适配）；flat config `eslint.config.mjs` |
| `eslint-config-next` | `16.3.4` | ESLint 规则集 | 自带 flat config，无需 `@eslint/eslintrc`/FlatCompat |
| `@supabase/ssr` | `0.12.5` | 服务端 Auth client | |
| `@supabase/supabase-js` | `2.112.4` | 浏览器 client | |
| `@tailwindcss/postcss` | `4.3.3` | PostCSS 插件 | Tailwind v4 必需 |

---

## 3. 后端

- **实现方式**：Next.js **Route Handlers**（`app/api/.../route.ts`），**不单独起** Node.js / Express 服务
- **语言**：TypeScript
- **密钥边界**：Canvas token、LLM API key、加密密钥、数据库 service key 只在服务端环境变量中，前端一律不可见

---

## 4. 数据库、认证、文件存储

统一使用 **Supabase**（一站式 BaaS），理由：减少需要接入的服务数量，个人项目迭代快。依据 [ADR-006](./Decisions.md#adr-006)。

- **数据库**：Supabase Postgres，表结构见 `Database.md`
- **用户认证**：Supabase Auth（邮箱 + 密码优先；Google OAuth 作为增强项）
- **文件存储**：Supabase Storage，存放用户上传的 syllabus 原始文件

### ⚠️ 免费层约束（必读，会直接影响架构决策）

| 约束 | 免费层实际限制 | 对 Tempo 的影响 |
|---|---|---|
| **项目自动暂停** | **1 周无活动即被暂停**，需手动恢复 | 学期内每天有用户访问则无碍；**寒暑假数据真空期几乎必然被暂停**——需注意，别把停机误判为故障 |
| 数据库容量 | 500 MB | Phase 0 量级（几十用户 × 几十课程）绰绰有余 |
| 文件存储 | 1 GB | syllabus PDF 按 1-5 MB 计，可存数百份；**需限制单文件大小（建议 ≤ 20 MB）** |
| 活跃项目数 | 2 个（跨组织计数） | 建议只维护 prod 一个，避免 staging 占额度 |

> **建议**：Phase 0 阶段先跑免费层；一旦进入"用户依赖 Tempo 备考"的阶段（约期末前），升级 Pro（$25/月，项目不再暂停 + 每日备份）。**升级的触发条件是"有真实用户依赖"，不是"免费额度用完了"。**

---

## 5. AI / LLM 能力：可插拔抽象层

> 依据 [ADR-003](./Decisions.md#adr-003)：默认 **DeepSeek**，效果不达标可切 **Claude**，切换不改业务代码。

### 5.1 为什么要有抽象层

**LLM 是本项目唯一一个"效果无法提前担保"的外部依赖。** 解析质量直接决定用户体验，而"哪个模型解析 syllabus 更准"这件事**只有跑起来才知道**。因此必须能在不动业务代码的前提下换模型。

### 5.2 抽象层设计（`lib/llm`）

```
lib/llm/
  index.ts          → 对外统一入口：getLLMProvider()
  types.ts          → LLMProvider 接口 + 请求/响应类型
  providers/
    deepseek.ts     → 默认 provider
    claude.ts       → 兜底 provider（自带多模态能力）
```

**统一接口（示意）**

```ts
interface LLMProvider {
  name: string;
  /** 结构化抽取：传入 prompt + JSON schema，返回符合 schema 的对象 */
  extractStructured<T>(params: {
    schema: JSONSchema;
    messages: Message[];
  }): Promise<Result<T>>;   // Result，不抛裸异常
}
```

**硬性要求**

1. **业务代码只依赖 `LLMProvider` 接口**，不得直接 import 任何厂商 SDK
2. 切换 provider **只改环境变量配置**（`LLM_PROVIDER=deepseek | claude`），不改业务代码
3. 返回类型统一为 `Result<T>`（成功/失败），**不允许让厂商异常穿透到业务层**
4. 必须记录**每次调用的 provider、模型、token 消耗、耗时**（用于评估是否要换模型）
5. 结构化输出走 **JSON schema 约束**（DeepSeek 用 JSON Output 模式，Claude 用 tool use / structured output），**禁止"让模型自由描述再写正则解析"**

### 5.3 Provider 选型对照

| 维度 | DeepSeek（默认） | Claude（兜底） |
|---|---|---|
| 结构化输出 | JSON Output 模式 | tool use / structured output |
| 多模态视觉 | ❌ 官方 API 无视觉输入 | ✅ 支持图像输入 |
| 成本 | 显著更低 | 更高 |
| 何时切换 | 默认 | 解析效果不达标 / 需要扫描件解析时 |

### 5.4 扫描件与复杂排版的降级策略

**Phase 0 不为此单独引入 OCR 管线或第二个 LLM。** 处理顺序：

1. 先走常规文本抽取（见第 6 节）
2. 抽取失败或文本量明显过少（判定为扫描件）→ **明确提示用户"这份文件我们读不出来，请手动补充关键信息"**
3. **禁止编造**、禁止静默返回空结果
4. 若扫描件比例超预期，再评估切到 Claude 走多模态（待决事项 O-03）

- API Key 只存服务端环境变量，`.gitignore` 必须包含 `.env*.local`

---

## 6. 文件解析（常规文档）

| 格式 | 库 | 备注 |
|---|---|---|
| PDF | `pdf-parse` | 扫描件会抽出空文本 → 走第 5.4 节降级 |
| Word (.docx) | `mammoth` | 输出 HTML/文本 |
| PPT (.pptx) | `pptx-parser` 或等效库 | **不要**在小众库上耗过多时间，效果不理想就走降级提示 |

**统一约束**：文本抽取必须在**服务端**执行；抽取结果要记录"是否成功 / 抽出字符数"，用于判断是否走了降级。

---

## 7. Canvas 集成

### 7.1 凭据与请求

- **Phase 0 接入方式**：用户在设置页手动粘贴自己生成的 Canvas Personal Access Token
- Token **必须加密存储**（Node.js 内置 `crypto` 模块做 AES 加密，加密密钥存服务端环境变量），**禁止明文**
- 所有 Canvas API 请求**必须在服务端发起**，禁止前端携带 token 直接请求 Canvas
- Canvas API 基础地址：`https://bcourses.berkeley.edu/api/v1/`
  - ✅ **token 生成入口已确认可用**（P0-2-1，2026-09-01 实测：bCourses Settings 中 "+ New Access Token" 存在）
  - ⚠️ **API 域名本身仍待首次联调验证**——若返回 404/重定向，说明伯克利 Canvas 实例用了别的域名，届时以实际响应的重定向地址为准

### 7.2 Token 有效期（事实修正）

**学生 token 的过期时间是强制必填字段**，当前上限约 **120 天**（早期为 30 天，政策在变化，且方向是收紧）。

- ❌ 不要写死"90 天"
- ✅ `expires_at` 使用**用户实际填写的过期时间**
- ✅ 到期提醒基于该字段计算，而非固定天数

### 7.3 Plan B：Canvas Calendar Feed（iCal）—— 不在 Phase 0 实现

✅ **P0-2-1 已实测确认 PAT 入口可用**（2026-09-01），因此 iCal **不在 Phase 0 实现**，仅作为长期 Plan B 保留：若学校将来关闭学生 token 入口，或被 Instructure 要求停止 PAT 接入时启用（降级阶梯见 `Sync-Strategy.md` L3）。

| 维度 | PAT | iCal Feed |
|---|---|---|
| 数据完整度 | 课程、作业、成绩、提交状态 | 仅事件标题 + 时间 + 课程名 |
| 合规性 | 平台政策（ToS）风险 | 官方设计给日历应用的用法 |
| 存储 | 需 AES 加密 | 一个可撤销的 URL |
| Phase 0 是否够用 | 过剩 | **够用**（只要 due date） |

实现要点：`.ics` 解析使用 `node-ical` 或等效库；同样在服务端拉取；同样需要失败可见性。

---

## 8. 定时任务与同步触发 ⚠️

> 完整策略见 [`Sync-Strategy.md`](./Sync-Strategy.md)。本节只说明**平台能力边界**，因为它是选型的前提。

### 8.1 已实测确认的平台限制

| 能力 | 免费层限制 | 来源 |
|---|---|---|
| **Vercel Cron（Hobby）** | **每个任务每天只能执行一次**；触发精度 ±59 分钟；分钟/小时级表达式会**导致部署失败** | Vercel 官方文档 |
| Vercel Cron（Pro） | 最快每分钟一次，精度到分钟 | 同上 |
| Vercel Function 时长 | Hobby 默认与上限均为 **300 秒** | 同上 |
| Supabase 免费层 | **1 周无活动自动暂停** | Supabase 官方文档 |

**这意味着**：如果直接按"定时轮询"的思路做同步，在免费栈上最细只能做到**每天一次**，而且触发时间还会在那一小时内漂移——"前期轮询频率放宽"在免费层是**有硬墙的**。

### 8.2 解法：以"打开时同步"为主，定时兜底为辅

这个约束反而逼出了一个更合适的架构：

| 触发方式 | 频率 | 作用 |
|---|---|---|
| **用户打开应用时同步**（主） | 每次打开 / 手动刷新 | 用户看到的**永远是当前最新数据**——这才是"省心"真正需要的 |
| **定时兜底扫描**（辅） | 每日 1 次（免费层上限） | 捕捉用户不打开期间发生的变化，用于触发通知与保证后台数据不过期 |
| **外部调度器**（可选增强） | 可到分钟级 | 若后续确实需要更高频率，用 cron-job.org / GitHub Actions 等外部调度器定时请求我们的 API 路由，**无需升级 Vercel 即可突破每日一次限制** |

**核心洞察**：Tempo 是低频使用但高频依赖的应用。用户一天打开 2-3 次，而"看到的时候是不是最新的"才是体验命门——**在用户打开时同步，比无脑定时轮询更直接地解决新鲜度问题，且成本为零**。定时轮询的价值在于"用户没打开时也要知道变化"，那是通知与后台一致性的需求，日级足够。

> 具体数值（轮询间隔、并发控制、限流、失败重试）见 `Sync-Strategy.md`（待决事项 O-01）。

---

## 9. 部署

- **Next.js（前端 + 后端）**：Vercel
- **数据库 / 认证 / 存储**：Supabase Cloud
- **版本控制**：Git + GitHub，提交纪律按 `CodingRules.md`（每个 task 一次有意义的 commit，**禁止 `git add .`**）

### 升级触发条件

| 触发条件 | 动作 |
|---|---|
| 有真实用户依赖 Tempo 备考 | 升级 Supabase Pro（避免项目暂停） |
| 需要分钟级定时轮询 | 先用外部调度器；确实不够再升 Vercel Pro |
| 免费额度接近上限 | 评估后再定，不为"图方便"升级 |

---

## 10. 项目结构约定

```
/app                  → Next.js 页面与路由
  /api                → 后端 Route Handlers（含 cron 端点）
  /(routes)           → 前端页面
/components           → 可复用 React 组件
/lib                  → 工具函数
  /supabase           → Supabase client（server / browser 分离）
  /llm                → LLM 可插拔 provider 抽象层
  /canvas             → Canvas API 客户端（服务端专用）
  /sync               → 同步逻辑
/types                → TypeScript 类型定义（与 Database.md 数据字典保持一致）
```

---

## 11. 明确禁止事项

- ❌ 引入本文档未列出的前端框架（Vue / Angular 等）
- ❌ 绕过 Supabase 自建数据库
- ❌ 把任何密钥（API Key、加密密钥、Canvas token）写死在前端或提交到 Git
- ❌ 在业务代码中直接 import LLM 厂商 SDK（必须走 `lib/llm` 抽象层）
- ❌ 在前端直接请求 Canvas API
- ❌ 使用"让 LLM 自由描述再写正则解析"的方式获取结构化数据
- ❌ 未经批准引入新的第三方付费服务

---

## 12. 待确认事项（开发前必须落实）

| # | 事项 | 归属 | 影响 |
|---|---|---|---|
| ~~T-1~~ | ~~bCourses 域名与 token 生成入口是否可用~~ | ✅ **已确认：入口可用**（P0-2-1，2026-09-01）。API 域名待首次联调验证（见 7.1） | 走 PAT；iCal 降级为长期 Plan B |
| T-2 | 轮询具体频率与限流参数 | `Sync-Strategy.md`（O-01） | 同步体验与成本 |
| T-3 | 扫描件处理策略是否启用多模态 | O-03 | 是否切换 provider |
| T-4 | 单文件上传大小上限 | 建议 ≤ 20 MB | Storage 额度 |

---

## 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-09-01 | LLM 从"锁定 Claude"改为**可插拔抽象层，默认 DeepSeek，Claude 兜底** | [ADR-003](./Decisions.md#adr-003) |
| 2026-09-01 | 新增 Supabase 免费层约束表（1 周无活动暂停等） | 实测查证 |
| 2026-09-01 | 新增第 8 节「定时任务与同步触发」，明确 Vercel Hobby Cron 每日一次硬限制，改为"打开时同步为主 + 定时兜底" | 实测查证 |
| 2026-09-01 | Token 有效期 90 天 → 约 120 天，`expires_at` 基于用户填写值 | 事实修正 |
| 2026-09-01 | 新增 iCal Feed 作为 Plan B | [ADR-002](./Decisions.md#adr-002) |
| 2026-09-01 | 扫描件策略改为"降级提示"，不引入 OCR 管线 | 讨论决策 |
| 2026-09-01 | T-1 关闭：token 入口实测可用，Phase 0 走 PAT；iCal 从"条件性实现"降级为"长期 Plan B，不进 Phase 0" | P0-2-1 实测结论 |
| 2026-09-01 | **锁定版本矩阵**：Next `16.3.4` / React `19.2.8` / Tailwind `4.3.3` / shadcn `4.x` / ESLint `9.39.5` / Supabase 客户端；**禁用 `@latest`** | 版本雪崩修复（P0-0-1/P0-0-2） |
