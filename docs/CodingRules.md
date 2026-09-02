# CodingRules.md — Tempo 开发宪法

> ⚠️ 任何写代码的人（包括 AI）在开始工作前，必须先完整阅读本文档和 `TechStack.md`。
>
> **阅读策略（避免每个 task 都重读全部文档、拖慢执行）**：
> - **首次开工**：完整读一遍本文档 + `TechStack.md`（尤其第 2 节的版本锁定矩阵）。
> - **之后每个 task**：只读 `Phase-0-MVP.md` 里该 task 的**执行卡**（内含做什么 / 改哪些文件 / 关键约束 / 验收命令 / 交接点），外加用到的版本号，**不必重读全部文档**。
> - **架构级 task**（新增抽象层、改数据模型、改 API 契约等）才需要回到对应实现文档（`TechStack.md` / `Database.md` / `API-Contract.md`）核对细节。
>
> **职责边界**：本文档管「怎么干活」（流程、规范、红线）；`Decisions.md` 管「为什么这么定」（决策与理由）；`Tempo_产品总蓝图.md` 管「往哪去」（战略）；`PRD.md` 管 Phase 0「做什么」；`TechStack.md` / `Database.md` 管「用什么实现」。
>
> 冲突处理：通用规范与具体决策（ADR）冲突时，以 ADR 为准，并同步回来更新本文档。禁止四份文档各说各话。

---

## 1. 五条铁律（不可协商）

### 1.1 Diff First — 先说清改动，再动手

任何非平凡的改动（新增文件、重构、改数据结构、改 API 契约），**先把「要改什么、为什么改、影响面」讲清楚，拿到确认后再执行**。

禁止「我觉得顺手就一起改了」。

### 1.2 No Silent Refactors — 不做未被要求的重构

任务说改 A，就只改 A。顺手重命名变量、调整目录、优化无关代码——**一律不做**。

确实发现需要重构的地方，单独提出来作为下一个 task 讨论，不在当前 task 里夹带。

### 1.3 No Unapproved Dependencies — 不引入未批准的第三方依赖

技术栈已在 `TechStack.md` 锁定。新增任何 npm 包 / 第三方服务 / 付费 API，**必须先说明理由和必要性，获批后再动**。

「这个库更好用」「大家都用这个」不构成理由。有效理由要说清：现有方案为什么不行、新依赖的维护状况与体积/成本。

### 1.4 密钥永不出现在前端和仓库

`.env.local` 必须进 `.gitignore`。

Canvas token、LLM API Key、Supabase 密钥、加密密钥——**只允许存在于服务端环境变量**，禁止硬编码、禁止提交、禁止传给前端 JS。

所有对外部 API 的请求（Canvas、LLM）必须在服务端发起。

### 1.5 技术栈已锁定，不允许自行替换

`TechStack.md` 选定的框架/库，不允许因为「我认为另一个更好」而替换。要换，先改 `TechStack.md` 并在 `Decisions.md` 记一条 ADR。

---

## 2. 命名与代码风格

| 场景 | 规则 | 示例 |
|---|---|---|
| 数据库表名 | 复数、snake_case | `courses`, `grade_components` |
| 数据库字段名 | snake_case | `user_id`, `due_date` |
| TS 变量 / 接口字段 | camelCase | `userId`, `dueDate` |
| React 组件文件 | PascalCase | `CourseCard.tsx` |
| 工具函数 / 库文件 | kebab-case | `canvas-client.ts` |
| API Route 目录 | kebab-case | `app/api/canvas-sync/route.ts` |
| 布尔字段 | `is_` / `has_` 前缀 | `isConfirmed`, `hasSynced` |
| 时间字段 | `_at` 结尾，类型 `timestamptz` | `createdAt`, `expiresAt` |

表名与字段名一律以 `Database.md` 为准，**不允许自行发明**。

**TypeScript 规范**

- 不用 `any`。确实类型不确定时用 `unknown` 并做类型收窄。
- 不用 `@ts-ignore` 绕过类型错误，要么修类型要么修代码。
- 组件 props 必须显式定义 interface，不内联匿名类型。
- 服务端与客户端的 Supabase client 分开建（`lib/supabase/server.ts` / `browser.ts`），不混用。

---

## 3. 目录结构

```
/app                 → Next.js 页面与路由（App Router）
  /api               → 后端 API Routes
  /(routes)          → 前端页面
/components          → 可复用 React 组件
/lib                 → 工具函数、Supabase client、LLM 封装、Canvas client
  /auth              → 认证 Server Actions（signIn / signUp / signOut，见 P0-0-3）
  /api               → API Route 响应辅助（统一错误结构 / x-request-id 回传，见 API-Contract.md 1.3、1.5）
  /llm               → LLM provider 抽象层（可插拔，见 TechStack.md）
/types               → TS 类型定义（与 Database.md 保持一致）
```

新增顶层目录需在此登记，不随意新建。

---

## 4. Git 与提交纪律

- **粒度**：按 task / phase 提交，一个逻辑改动一个 commit，不攒一大坨。
- **Message 格式**：`<type>: <一句话说明>`，type 用 `feat` / `fix` / `refactor` / `docs` / `chore`。
  例：`feat: 新增 syllabus 上传与解析 API`
- **提交前自检**：`git status` 确认改动范围，只 add 该 add 的文件（用窄化路径，**不要用 `git add .` 一把梭**）。
- **提交后复查**：commit 完必须再跑一次 `git status`，确认工作区干净、没有漏掉的文件。
- **敏感文件**：`.env*`、密钥文件、用户数据一律进 `.gitignore`，永不入库。

---

## 5. 开发节奏与验收（硬性流程）

**永远 check 一个 task，通过后才做下一个。** 这不是建议，是流程。

每个 task 交付时必须给出：

1. **改了什么**：文件清单 + 每个文件的关键改动
2. **自测结论**：跑通了什么、没跑通什么、有没有已知问题
3. **下一步建议**

**API 层的自测办法（WorkBuddy 沙箱实测可行，2026-09-02）**：沙箱里 `next dev` 起不来（NODE_OPTIONS 注入的 FS shim 拦 `.next` 写入），但 **`npm run build` + `npm run start` 可以**（清空 `NODE_OPTIONS` 即可）。因此可以：

1. `NODE_OPTIONS= npm run build` 后起 `NODE_OPTIONS= npm run start`
2. 写一个临时脚本用 `@supabase/ssr` 的 `createServerClient` + 假 cookie store（`setAll` 里捕获）注册/登录测试用户，把 cookie 导出成 `Cookie` 头
3. 用 curl 打自己的 API，覆盖正常路径 + 异常路径 + **跨用户越权**

这样 API 层不必留给 Steven 首测；**浏览器 UI 的交互与样式仍然只能由 Steven 本地 `npm run dev` 验收**，交付时要如实区分这两者。临时脚本用完必须删除并提交前 `git status` 复查。

**验收不通过时**：按具体意见修改，不自作主张扩大改动范围。改完重新提交验收。

**任务边界**：做的时候发现了别的问题——记下来作为下一个 task 的候选，**不在当前 task 里顺手改**（见 1.2）。

---

## 6. AI 协作契约

**分工**：AI 写代码和文档；Steven 做决策、跑起来验证、决定下一步。

- **不猜**：需求不清楚就问，不假设意图。
- **不扩大**：不因为「顺手」或「更完整」而超出任务范围。
- **给命令的规范**：交给 Steven 在终端执行的命令，**注释单独写一行，绝对不要写成行内注释**——`#` 后面的中文会被 shell 当作参数传进去，导致命令执行失败。
- **诚实报告**：没跑通就说没跑通，不用「应该没问题」糊弄。自测结论必须基于实际执行结果。
- **不确定就标出来**：对外部 API 行为、第三方库实际效果这类没法本地验证的东西，交付时明确标注「这块我没验证，需要你实测」。

---

## 7. 错误处理与「允许不知道」

- **不吞异常**：`catch` 里必须记录日志或向上抛出，禁止空 `catch`。
- **外部调用必带降级**：调 Canvas / LLM / Supabase 失败时，要有明确的用户可见反馈——不是白屏，也不是静默失败。
- **AI 解析允许失败**：syllabus 解析抽不出的字段，如实留空并提示用户补充，**禁止编造内容填充**。
- **数据模型允许 unknown**：参照 `Database.md`，字段普遍可空。「不知道」是合法状态，不要为了填满而造假数据。

这条原则不只是技术要求——Tempo 的产品信任建立在「它不会骗我」之上，一次编造就足以毁掉。

---

## 8. 文档维护

- **单一事实源**：同一件事只在一处权威定义，其他文档引用而非重复。避免四份文档各自漂移。
- **改代码顺手改文档**：数据结构、API 契约、技术选型发生变化时，同步更新对应文档，不留下「文档说的是 A、代码做的是 B」。
- **重要决策进 `Decisions.md`**：凡影响架构、需要权衡取舍的决策（尤其是「为什么不用 X」），记一条 ADR，写清背景、决策、理由、后果。
- **收工摘要表不得重新归纳**：摘要 / 速查表里的结论必须逐字从根因段落抄，不做二次归纳。写完做**反向代入验证**：把「坑」列的内容代回根因句读一遍，语义成立才算过。踩坑实例：2026-09-02 收工摘要把「cookies() 前置（修法）」归纳成了「坑」，方向写反，随后被照抄进 `Phase-0-MVP.md`，污染链跨两个文件才被 Steven 抓出来。

---

## 9. 明确禁止清单

- ❌ 引入 `TechStack.md` 之外的前端框架（Vue / Angular 等）
- ❌ 绕过 Supabase 另起数据库
- ❌ 密钥进前端、进 Git、进日志
- ❌ 为了「图方便」引入未经讨论的第三方付费服务
- ❌ 未经批准的大范围重构
- ❌ 用 `git add .` 一把梭提交
- ❌ 在终端命令里写行内中文注释
- ❌ 用「应该没问题」代替实际自测结论

---

*创建：2026-09-01 ｜ 最近更新：2026-09-02（新增「阅读策略」，避免每个 task 重读全部文档）*
