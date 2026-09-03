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

**踩坑速查**：本条套路之外的环境 / 依赖 / 部署陷阱见 **§10 踩坑库**（通用方法论在 10.1，按主题的坑索引在 10.2）。自测跑不通时先去那里翻一眼。

**验收不通过时**：按具体意见修改，不自作主张扩大改动范围。改完重新提交验收。

**任务边界**：做的时候发现了别的问题——记下来作为下一个 task 的候选，**不在当前 task 里顺手改**（见 1.2）。

**🔴 停止点以指令原文为准，不要用「continue」推进下一张卡**（2026-09-03 教训）：
Steven 说「完成 P0-1-5b 就收手」，Bud 交付 5b 后收到含糊的「Please continue.」，
一路连做 P0-1-6 → P0-1-8，在 P0-1-9 开工前才被叫停。
**规则**：Done Report 之后的模糊指令（continue / 继续 / 嗯 / 收到）一律**回读 Steven 的原始停止点**，
停在交接点复述「已完成 X，下一步是 Y，要我开工吗？」，等他明确说下一张卡再动。

> ✅ **2026-09-03 二次验证（已确认是稳定模式，不是偶发）**：本轮 P0-1-9 Done Report 后 Steven 又发了一句
> 措辞**完全相同**的「Please continue.」，按本条停下确认 —— 这次 Steven 的回应是「验收通过，今天到这，
> 我在新对话框里开下一张卡」。**证明这类「continue」是他对 Done Report 的习惯性收尾，不是开工指令。**
> 补充一条更强的拦截理由：**当前 task 尚未验收通过时，流程上根本不具备开下一张卡的条件**（§1「一个 task
> 通过后才做下一个」）—— 即使他说的真是「继续开工」，也该先提醒他去验收。

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
- **踩坑按归属落位**：新踩到的坑，能归到某个主题文档（执行卡 / ADR / TechStack / Database / API-Contract）的就写进主题文档，再到 `CodingRules.md` **§10.2 坑索引**加一行；只有跨 task 通用的排查方法论才写进 §10.1。细节不复制，避免四处漂移。
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

## 10. 踩坑库（环境 / 依赖 / 部署）

> **本节的定位**：索引 + 通用方法论，**不复制细节**。
> - **10.1 通用排查方法论** —— 跨 task 通用、没有单一主题归属的套路，只写在这里。
> - **10.2 坑索引** —— 「坑 → 权威文档位置」的指路表。细节**一律留在它所属的主题文档**（执行卡 / ADR / TechStack / Database / API-Contract），本节只给一句话 + 位置，避免同一件事在几份文档里各写一份然后漂移。
>
> **新增坑的规矩**：能归到某个主题文档的 → 写进主题文档，再在 10.2 加一行索引；只有通用方法论才写进 10.1。**禁止把细节抄进本节。**

### 10.1 通用排查方法论

1. 🔴 **「线上 500 但响应体为空」= 模块加载失败，靠猜猜不出来。**
   特征：整个路由 500，连完全不碰该依赖的分支也 500，响应体 `content-length: 0`。
   有效手段：临时加一个诊断路由，把可疑 `import` 逐个 try/catch 并把错误消息回传，一次定位。
   ⚠️ **App Router 里下划线开头的目录是私有目录、不建路由**（`app/api/_diag/` 无效，要用 `diag-tmp` 这种名字）。

2. 🔴 **验证「依赖里含原生二进制 / 浏览器 API」的库，本地必须先 `delete globalThis.DOMMatrix` 再 `import`。**
   本地 macOS 常装着这类原生依赖（如 `@napi-rs/canvas-darwin-arm64`，23MB），会掩盖问题 —— 曾因此误判「换库已修好」白推一次部署。**本地全绿 ≠ 线上能跑。**

3. **含 worker / wasm / 二进制资源的 npm 包，一律考虑 `serverExternalPackages`。** 危害是静默的：HTTP 仍 200，只是业务结果变成"失败"。排查口诀：**构建绿 + 接口 200 但结果不对 → 先看服务端日志有没有 module not found。**

4. **用环境变量覆写做分支测试时，每个 case 前必须先恢复原值。** 否则上一个 case 的值泄漏进下一个 case，报错全变成别的样子，把真实错误掩盖掉。

5. **删掉路由 / 文件后要重建再跑 `tsc`。** `.next/types/validator.ts` 会残留旧引用，报 `Cannot find module '...route.js'` —— 不是代码问题，重新 `npm run build` 即可。

6. **验纯库层（无 HTTP 出口的模块）**：仓库**没有 tsx / ts-node / esbuild**（devDeps 只有 typescript + eslint + tailwind），直接跑 TS 会引入新依赖，违反 1.3。走 §5 的套路：临时诊断路由 + `npm run build` / `npm run start` + curl，验完删路由并重建。
   起后台服务**必须用 `run_in_background: true`**；写成 `(cmd &)` 的话，工具调用一结束进程就被回收，下一轮 curl 全是 502（不是代码问题）。关服务用 `lsof -ti:3000 | xargs kill`（沙箱里 `ps` 被拒）。
   临时路由 / 脚本**用完必须删除**，提交前 `git status` 复查。

7. 🔴 **新端点在生产 404，先确认「部署到底建了没」，别急着查代码。**
   Vercel 偶发延迟（实测最长约 13 分钟才创建部署），期间生产服务的是**旧 build**：
   新路由 404，而同目录的旧路由正常（如 `/extract` 仍返回 401）。反复 curl + 加 cache-busting 参数都无用。
   **正确姿势（不用登 Vercel）**：
   ```bash
   gh api repos/stevenli2007-del/tempo/deployments --jq '.[0] | {sha: .sha[0:7], created_at}'
   gh api repos/stevenli2007-del/tempo/deployments/<id>/statuses --jq '.[] | {state, description}'
   ```
   看不到刚推的 commit → 是部署延迟，等或让 Steven 手动 Redeploy；
   `state: success` 但端点仍 404 → 才是代码 / 构建问题。
   另注：临时脚本与生成的测试文件一律 `.tmp-` 前缀（`.gitignore` 已忽略），否则 `git add -A` 会把它们误暂存。

8. 🔴 **拿 SSR 的 HTML 做断言时，两个 React 渲染事实会让"看起来对"的字符串匹配失败。**
   ① **相邻文本节点之间会被插入 `<!-- -->`**：`已完成 {n} 项` 渲染成 `已完成 <!-- -->1<!-- --> 项`，
   整句 `includes('已完成 1 项')` 永远不成立 —— 断言要按片段写（`/已完成[\s\S]{0,40}?项/`）。
   ② **条件渲染的内容默认不在 DOM 里**：折叠区块收起时里面的条目根本没渲染，
   搜它的 `className`（如 `line-through`）搜不到 —— **这是正确行为，不是 bug**，别为此改实现。
   写断言前先想清楚「这个元素此刻到底会不会在 DOM 里」。

9. 🔴 **React：「服务端数据变了要让表单跟上」→ 用 `key` 重挂载，别在 effect 里 setState。**
   本项目的 eslint（`react-hooks` 编译器规则）会连开两枪：`react-hooks/set-state-in-effect`
   拦 effect 里的同步 setState；改用 `useRef` 存标志又被 `react-hooks/refs` 拦（render 期不能读写 ref）。
   **正解（React 官方「用 key 重置状态」）**：父组件给子组件 `key={JSON.stringify(该板块数据)}`，
   数据一变直接重挂载，非受控状态自动重置。
   ⚠️ **key 必须用数据序列化，不能用 props 数组身份** —— props 每次渲染都是新数组，靠身份会天天重挂载。
   代价：服务端数据变化时未保存的编辑会丢（P0-1-6 的重新解析有二次确认并写明此点）。
   相关：**保存成功后要用响应里的 `data` 重建 draft**，否则新行没有 id，第二次保存会重复 insert。

### 10.2 坑索引（细节在各自文档）

| 坑 | 一句话 | 权威位置 |
|---|---|---|
| Next 16 动态路由判定 | `cookies()` 必须写在 `getSupabaseEnv()` **之前**，否则 env 缺失时 Next 看不到 `cookies()` → 误判静态页 → build `prerender-error` | `Phase-0-MVP.md` P0-0-6 执行卡 |
| Vercel git author 不匹配 | commit 邮箱 ≠ GitHub 主邮箱 → Vercel 判冒名顶替 **Blocked**（不报 build 错） | `Phase-0-MVP.md` P0-0-6 执行卡 |
| env vars 保存 ≠ 已注入 | 加完/改完环境变量 **必须手动 Redeploy**，否则旧 build 不带变量 → 生产全站 500。**build 绿 ≠ runtime 通** | `TechStack.md` §5.2、`Phase-0-MVP.md` P0-0-6 执行卡 |
| Vercel Environment 只能单选 | 新增变量时 Production / Preview **不能两个都勾**。本项目只需 Production（部署流程是 push main → 自动部署到 Production，没有 Preview 环节） | 本节（无其他归属） |
| Vercel 部署延迟 | 新端点生产 404 但同目录旧端点正常 = 部署还没建，不是代码问题。**先用 `gh api .../deployments` 确认，别反复 curl 猜** | 本节 10.1 第 7 条 |
| PDF 提取只能用 `unpdf` | `pdf-parse` / `pdfjs-dist`（现代与 legacy）在 Vercel 上一律 import 即 500；释放文档用 `pdf.cleanup()`（v5 改名，非 `destroy()`） | `Decisions.md` **ADR-011**、`TechStack.md` §2、`Phase-0-MVP.md` P0-1-2 执行卡 |
| Storage 平台 schema DDL 走 UI | `storage.objects` 建策略报 `42501 must be owner`（owner 是 `supabase_storage_admin`）→ 只能 Dashboard UI。UI 会加策略名后缀，验收看 `pg_policies` 语义 | `Database.md` §7.3、`Phase-0-MVP.md` P0-1-1 执行卡 |
| `createSignedUrl` 会检查存在性 | 对象不存在返回 `NoSuchKey`，`statusCode` 是**字符串** `'404'` —— 这是「悬挂行」判定信号，别当 500 抛。谓词收在 `lib/syllabi.ts` 的 `isStorageObjectNotFoundError()` | `API-Contract.md` §download、`Phase-0-MVP.md` P0-1-2 执行卡 |
| `extract_method` CHECK 约束 | 取值 `pdf_text` / `docx` / `pptx` / `manual`；`docx` / `pptx` **没有** `_text` 后缀 | `Phase-0-MVP.md` P0-1-2 执行卡 |
| supabase-js `*_COLUMNS` 常量 | **必须写字面量字符串**，不能 `.join()` —— 退化成 `string` 后推不出返回行类型，`data` 被推断成 `GenericStringError` | `lib/syllabi.ts` 注释、`Phase-0-MVP.md` P0-1-1 执行卡 |
| LLM 模型别名 | 请求 `deepseek-chat`，实际服务的是 `deepseek-v4-flash`。`llm_runs.model` 记**实际服务模型**，否则按模型维度对比准确率会失真 | `TechStack.md` §5.2、`Phase-0-MVP.md` P0-1-3 执行卡 |
| 抽取层保留原文语言 | prompt 必须写死「不翻译」—— 译文无法与原文核对，且**翻译不可逆**，抽取层丢掉的原文找不回来 | `TechStack.md` §5.5、`Phase-0-MVP.md` P0-1-4 执行卡 |
| PostgREST 构造器别抽成泛型函数 | 把带 `.select()` 的查询构造器当参数传给辅助函数 → `TS2589: Type instantiation is excessively deep`。排序这类几行的链式调用**各写一份**，比绕类型便宜 | `Phase-0-MVP.md` P0-1-9 执行卡、`lib/tasks.ts` 注释 |
| `.lte()` 会吃掉 NULL 行 | 时间窗口过滤 `due_date <= X` 对 NULL 求值结果是 NULL（不成立），TBD 行整批消失。要显式 `or('due_date.lte."X",due_date.is.null')`（值含 `:` `+`，双引号包住） | `API-Contract.md` §5、`Phase-0-MVP.md` P0-1-9 执行卡 |
| `tasks` 的 RLS 不看 `is_archived` | 策略 `tasks_via_course_all` 只经 `courses.user_id` 判定，归档课程的任务照样放行 → 总览页/单条查询都必须先取未归档课程 id 再 `.in('course_id', …)` | `lib/tasks.ts` 文件头注释、`Phase-0-MVP.md` P0-1-9 执行卡 |

---

*创建：2026-09-01 ｜ 最近更新：2026-09-03（新增 §10 踩坑库：从 `.workbuddy/memory/MEMORY.md` 迁入，改为「方法论 + 索引」制，细节留在各自主题文档）*
