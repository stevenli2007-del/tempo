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
  /email             → 邮件入站编排（token 解析 / LLM 解析 / 决策 / 编排，P0-3-11）
/types               → TS 类型定义（与 Database.md 保持一致）
/workers            → 边缘部署单元（Cloudflare Worker 等），各自有独立 package.json，**不进 Next 构建**（如 `workers/inbound-email/`）
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

### 6.1 交付必附「给 Steven 的三行」（2026-09-05 新增）

**背景**：Steven 不写代码、也读不懂多少代码，但他要签字验收。当前 Done Report 是给记录看的实现笔记
（`canvas-sync.ts:100-107` 这种粒度），对他等于盲签 —— 2026-09-05 P0-2-9 那次他截生产图问「为什么看不到
新入口」，来回数轮才发现是两个 commit 没 push。**问题不在他不认真，在于他不知道该看哪里。**

**规则**：每张卡交付时，在实现笔记**之前**先给一段给 Steven 的人话。与 §5 的自测结论并列，不替代它。

```markdown
## 给 Steven
**只看这 N 个文件**：`<路径>` — <一句话：这个文件多了什么 / 改了什么>
其余 M 个是机械改动，不用看。
**值得知道的一点**：<一两句，说清为什么这么写而不是那么写——尤其是反直觉的那个决定>
**怎么验收**：<打开哪个页面 → 点哪里 → 应该看到什么>
```

**四条硬约束**：

1. **点名文件不超过 2 个。** 说「改了 7 个文件」等于没说。挑真正承载逻辑的 1-2 个，其余一句带过。
2. **「值得知道的一点」只写反直觉的。** 不需要解释常规实现，只写「为什么不是另一种写法」——
   那才是 Steven 会问、也最值得他知道的东西（例：撤销授权不能把密文置空，否则同步从优雅跳过退化成 500）。
3. **「怎么验收」必须可点。** 写「打开任一已关联课程的详情页 → 拉到底 → 应看到 X」，
   不要写「验证撤销入口可见」。他不知道入口在哪，这正是 P0-2-9 那次事故的根因。
4. **先确认上线再让他看**（与「报功能缺失前先确认代码已上线」同一条纪律）：
   交付时如涉及生产验证，先说清 commit 是否已 push、Vercel 是否 success。

**`// ?` 提问标记**：Steven 看不懂的行，直接在上一行写 `// ?我不懂这里为什么…`。
（`// ?` 会被 Better Comments 高亮成蓝色。）**下次会话开工前先 `grep -rn "// ?" --include=*.ts --include=*.tsx`
扫一遍并统一作答**，再开始新卡。

**改代码的时间窗口（防撞车）**：Steven 只在我**交付之后到他验收之前**动代码（改一行看效果、标 `// ?`）。
我在写卡的时候他不动文件 —— 两边同时改一个文件会互相覆盖。交付时明确说「现在可以看了」。

**明确不做（都是主动砍掉的，别再捡回来）**：

- ❌ **不铺代码注释**。只在「只看这 N 个文件」点名的文件里写必要的说明，其余一律不写。
  注释会腐烂，21 张卡的项目里堆积过期注释是真实的质量问题。主力是上面那段 markdown，不在代码里。
- ❌ **不做 CodeTour 导览**（2026-09-05 评估后砍掉）。导览绑具体行号，而 Tempo 每周改几十个文件，
  行号会漂；**过期的导览比没有导览更糟**（把人指到错误的行还让人信以为真）。
  等结构稳定后再评估。

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

6. **验纯库层（无 HTTP 出口的模块）**：仓库**没有 tsx / ts-node / esbuild**（devDeps 只有 typescript + eslint + tailwind），装它们会引入新依赖，违反 1.3。
   ✅ **首选：Node 22 自带类型擦除** —— `node --experimental-strip-types script.mjs` 可以**直接 import `.ts`**（`import type` 会被擦除，因此不解析 `@/` 别名也能跑；前提是**被验函数不带运行时依赖**）。比建诊断路由快一个数量级。
   报 `MODULE_TYPELESS_PACKAGE_JSON` 只是警告，不影响执行。
   要验的函数依赖服务端环境（DB / 环境变量）时，才退回 §5 的套路：临时诊断路由 + `npm run build` / `npm run start` + curl，验完删路由并重建。
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

10. 🔴 **验证「加解密往返正确」，别把明文打进响应或日志 —— 让解密结果去做一件"只有解对了才会成功"的事。**
    密封 credential 时最容易犯的错是为了验证而把明文 echo 出来，等于亲手把密钥写进日志/响应。
    正确做法：**拿解密出的 token 去真实调一次外部 API**，调通即证明往返正确（解错了对方必然 401）。
    响应里只返回「是否成功 + 解密后长度 + 对方返回的业务字段」，**永远不返回明文本身**。
    配套：断言只读"调用成功"这一个信号，长度可用（长度不是秘密，明文才是）。

11. 🔴 **服务端代理类接口，`domain` / `url` 入参必须做 SSRF 校验，这不是可选项。**
    只要服务端会拿用户填的 host 去发请求，不校验 = 开放内网探测
    （`169.254.169.254` 云元数据、`10.0.0.0/8`、`localhost`）。
    最小实现：只接受纯主机名（正则 + 拒绝协议/端口/路径），并显式拒绝 IP、localhost 与内网段。
    本项目实现见 `lib/canvas/validate.ts`。

12. 🔴 **节流 / 限流类检查要排在「是否真的会消耗那个资源」的判定之后。**
    限流保护的是某个具体资源（外部 API 额度、发信额度）。若把它排在最前面，
    **一个请求都不会发的情形也会被拦，而它盖住的往往是真正可行动的错误** ——
    实测反例：同步端点原本先查节流，结果 token 已失效的用户点同步看到的是
    「同步太频繁，27 秒后重试」，而正确提示应是「凭证失效，请重新生成 token」。
    **顺序原则**：先判定"这次到底要不要消耗资源"（有没有目标、凭证能不能用），
    确认要消耗了再校验频率。这样每种返回都指向用户真正能做的那个动作。
    本项目顺序：锁 → 凭据是否存在 → 凭据是否可用 → 有没有目标 → 节流。

13. 🔴 **写「外部源 → 本地表」的同步，三条不变量，缺一条就会出事故。**
    ① **删除判定必须绑定"本次拉取是否完整"** —— 翻页被熔断截断 / 中途失败时
    把没拿到的行判成"外部已删除"，是同步里最伤用户的一类事故（数据凭空消失）。
    宁可晚一轮再删，也不要在不完整的结果集上做删除。
    ② **时间比较用 epoch 不用字符串** —— 同一个时刻有两种合法写法
    （Postgres 回 `2026-09-04T06:59:00+00:00`、Canvas 给 `2026-09-04T06:59:00Z`），
    直接 `===` 会永远判成"变了"，导致每次同步把全表重写一遍。
    ③ **写入字段是封闭集合，绝不含用户可改的字段** —— 整行 upsert 会把用户
    标记的"已完成"打回未完成（这个 bug 在这类应用里最常见）。
    配套：删除用软删除且**支持恢复**（外部误删后恢复很常见，软删除能自愈）。

14. 🔴 **「加载中 / 成功 / 失败」三态语义不能用 JS 的 `undefined` 隐式承载。**
    「`Map.get(key)` 不存在」「数组 `.find()` 没找到」「`await` 返回 undefined」
    在 JS 里**长得一样**，但语义分别是「这 key 没数据」「没匹配项」「查询挂了」。
    用其中任何一种 `undefined` 当"加载失败"信号，**第一次出现"该实体不存在"的
    正常场景时就会误报成错误**。
    正确做法：分两个独立 prop / 状态传 —— 一个传数据（永远收数组或显式 null），
    另一个传错误（来自上游的真实 error.message）。
    反例（P0-2-5 实测踩到）：`loadUpcomingTasks` 返回的 Map 里只放"有任务"的课，
    `Map.get(course.id)` 在无任务的课上是 undefined，调用方却 `toUpcomingViews(undefined) → null`
    让卡片渲染「近期任务加载失败」。**所有关联 Canvas 后还没拉到任务的课都误报**。
    修法：卡片永远收数组（`[]` = 无任务），真错误由独立的 `loadError` prop 控制。
    **这类 bug 在没引入"中间态数据"之前不会暴露**（P0-1-9 没暴露是因为课程都
    还没关联 Canvas；P0-2-5 引入中间态才暴露）。
    本项目实现见 `lib/sync/canvas-tasks.ts` 文件头。

15. 🔴 **聚合"最近一次成功"这类指标时，遍历源不能只挑状态好的那部分。**
    直觉写法是「从成功的实体里取最大值」，但**失败的实体同样带着它上一次成功的信息** ——
    只有一门课且它刚失败时（2 小时前成功过），按"只看成功课"算会得出 `null`，
    UI 于是说「还没有成功同步过」，与事实相反。
    反例（P0-2-7 SSR 冒烟抓到）：`summarizeSyncStatus` 初版只遍历 `success` 的课，
    「全部失败」场景下"数据停留在 X"直接退化成"从没成功过"。
    **修法：聚合遍历全集**，状态只用于判定等级，不用于过滤"谁有资格贡献数值"。
    同类陷阱：求"最近登录时间"时把被封禁的用户排除掉、算"最低价"时把已下架商品排除掉 ——
    先问一句「我要的到底是'当前状态最好的那个'，还是'历史上最近的那次'」。
    本项目实现见 `lib/sync/status.ts` 的 `summarizeSyncStatus`。

16. 🔴 **给状态枚举新增一个取值时，要回头把所有消费该字段的地方过一遍。**
    状态机扩展的回归几乎从不发生在"新增的那处代码"里，而发生在**老代码没覆盖新取值** ——
    老代码写的时候那个值还不存在，逻辑上完全正确，只是世界变了。
    反例（P0-2-9 领卡时抓到）：`toCredentialExpiryView`（P0-2-8 写的）只在
    `status === 'error'` 时返回 null，因为写它的时候只有 `active`/`expired`/`error` 三种。
    P0-2-9 引入 `revoked` 后，撤销过的凭据仍会算出「令牌将在 X 天后过期，记得去
    bCourses 重新生成」—— 用户刚主动断开，却被催着重连。
    **检查方法**：改完枚举，全局搜该字段名，逐个问「新取值进来会走到哪个分支，这个行为对不对」。
    特别留意"返回 null / 跳过"这类**否定式分支** —— 它们是"不提示"，漏了不报错、只静默出错。
    反之同理：P0-2-9 靠这条反过来确认了两处不用改 —— `runCanvasSync` 用
    `status !== 'active'` 兜底（revoke 自动停同步）、T3 只扫 `.eq('status','active')`
    （revoke 不会被误翻 expired）。**否定式与白名单式判定对新增取值天然安全。**
    本项目实现见 `lib/sync/expiry.ts`。

17. 🔴 **上游平台的「不知道」不等于「未完成」——展示层必须区分「确定未完成」与「我们看不到」。**
    当外部源拿不到某个状态时，真相可能只是"我们看不到"（平台没接口、没回传、权限不足），
    而不是"用户没做"。把它显示成"未完成"等于**诬告用户** —— 这正是「允许不知道」（§7）要防的事。
    正解是显式的第三态：**「待确认」**（Stride 里的 `availability: unknown`）。
    反例（Steven 2026-09-13 实测）：Chem 1AL「Lab 1: Airbags」(due 9/9) 交在 Gradescope，
    Canvas 却报 `unsubmitted` —— 按"未完成"渲染就是诬告。
    🔴 **同一平台的信号要分方向对待**：`external_tool` 类的**正信号**（`graded`/`submitted`/`pending_review`）
    是 LTI 回传的**事实**，照常采信；**负信号**（`unsubmitted`/`missing`）是 Canvas 的**推断**
    （它看不见外部平台的提交动作，只等成绩回传），一律降级为「待确认」。
    ⚠️ 反过来把 `external_tool` 一刀切成「待确认」也是错的 —— 那会把 Homework 1–4 这些**已评分**的作业全标成"未知"。
    同一规则的另一半：`submission_types` 为 `none` / `not_graded` / `on_paper` 的作业
    （考勤打卡、纸质作业）在 Canvas 里**压根不存在完成态**，这类必须永远保留手勾，不能被自动判成未完成。
    本项目实现见 P0-3-10 执行卡、`Database.md` §3.9。

18. 🔴 **日期展示与"今天"的判定必须读 `profiles.timezone`，禁止硬编码 `'UTC'`。**
    "按 UTC 取日期不会差一天"这个论证**只对被硬编码成 `T23:59:59` 的考试派生任务成立**；
    Canvas 的真实 `due_at` 带时区（`2026-09-09T23:59 PDT` = `2026-09-10T06:59Z`），按 UTC 渲染就**必然差一天**。
    而**作业几乎都在晚上截止 → 几乎全部显示晚一天**。
    反例（Steven 截图发现）：Canvas 写「Due Sep 9 at 11:59pm」，Tempo 显示「9/10 周四（已逾期）」。
    注意 `isOverdue` 用时间戳比较是对的 —— 不是"判断错了"，是**标签印错了日子**。
    本项目实现见 `Database.md` §3.1、P0-3-10 执行卡。

19. 🔴 **CSS 自定义属性是惰性求值的：同名覆盖会静默污染引用它的变量 —— 「字看不见」先查它是不是解析成了底色。**
    `--muted-foreground: var(--muted)` **不是**把当时的 `--muted` 抄一份，而是在**使用点**再去解析
    `--muted` 的**最终**值。所以在同一个选择器块里，**后面**再写一次 `--muted` 就把它改了，
    而前面所有引用它的变量会跟着一起变 —— 没有任何警告。
    反例（P0-3-3 实测，我自己写出来的）：把 Stride 的 `--muted`（文字灰 `#758078`）与 shadcn 的
    `--muted`（底色 = `--surface2`）用了**同一个名字**，末尾为迁就 shadcn 写了
    `--muted: var(--muted-bg)` → `--muted-foreground` 静默变成 `#f2f4ef`，而页面底色是 `#f7f8f4`。
    结果全站 `text-muted-foreground` / `text-ink-muted`（侧栏标签、卡片副标题、说明段落）**一起消失**。
    **`next build` 全绿、零警告**，只有肉眼看截图才发现。
    **铁律：底色 token 与文字 token 绝不重名。** 本项目命名 —— `--muted` 是**底色**；
    文字灰一律叫 `--ink-muted`。同理 `--on-lime`（恒定：放在 lime **底色**上的字）与
    `--lime-dark`（浅底上的品牌绿字，暗色下会被调亮）是两种语义，混用就会出现"浅绿压浅绿"。
    **排查手法**：看到"字糊了"，把该工具类在产物 CSS 里 grep 出来，**逐层把 `var()` 解析到最终字面值**，
    再与背景值算对比度。别信眼睛，更别信 build 绿。本项目实现见 `app/globals.css` 文件头。

20. 🔴 **同一份数据在多个页面渲染时，展示层判定（日期格式化 / 状态归桶）必须共用一份，不能各写一份。**
    复制的成本很低（几十行），代价很高：两个副本的口径**不会同时被改**。
    本项目实例（P0-3-7b）：课程卡从 `/dashboard` 搬到 `/courses` 后，卡片的日期标签 `formatDue`、
    "是否算完成"判定若各留一份，迟早出现**同一条作业在两个页面显示不同日期** ——
    而这正是第 18 条刚修过的 bug（差一天），会在另一个入口原样复活。
    **做法**：这类纯函数提到 `lib/`（本项目 `lib/tasks/format.ts` / `lib/courses/course-list.ts`），
    并在**原位置留一行注释指明新家**，否则下一个人会在旧文件里重新实现一遍。
    **判据**：问自己「给 A 页加的修复，B 页会自动也有吗？」—— 答案是否，就该抽出来。

21. 🔴 **同一个「算不算完成」的判定在一个组件里出现两次、字面不同 —— 分组对、渲染错，这是最难自查的一类 bug。**
    反例（P0-3-15，Steven 2026-09-17 截图抓到）：`TaskList` 的分组用 `isEffectivelyDone()`
    （用户手勾 **或** `isCanvasDone()`），而行内 `TaskRow` 写的是 `status === 'done'`。
    于是 **Canvas 已评分的作业被分进「已完成」折叠盒，却画出空勾选框、无删除线** ——
    用户看到的是一条"待办"，实际它已经在已完成区里。实测 83 条任务里 **40 条**如此。
    ⚠️ **`tsc` / `eslint` / `next build` / 全部回归脚本都是绿的** —— 因为两处各自都"没错"，
    错的是它们**说的不是同一件事**。
    **自查手法**：任何一个"数据 → 视图分区"的判定函数，`grep` 它在**同一个组件文件里出现几次**；
    出现两次且写法不同就是分叉。正解是让两处调用**同一个函数**（本次把三值 OR 收成 `isCanvasDone()`）。
    **延伸**：该判定若还被别的页面消费（本项目的 `dashboard/page.tsx` / `lib/courses/course-list.ts`），
    副本数会继续长 —— 见第 20 条「给 A 页加的修复，B 页会自动也有吗」。
    反过来也成立：**派生视图要显示"为什么这样分区"时，别在渲染层重新推一遍逻辑** ——
    徽标文案与分区判定走同一份口径（本项目 `lib/tasks/submission.ts`）。

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
| supabase-js `*_COLUMNS` 常量 | **必须写字面量字符串**，不能 `.join()` —— 退化成 `string` 后推不出返回行类型，`data` 被推断成 `GenericStringError`。⚠️ **已在 P0-1-1 与 P0-2-2 两次独立踩到**，加新映射层时先去 P0-1-1 卡看一眼 | `lib/syllabi.ts` 注释、`Phase-0-MVP.md` P0-1-1 执行卡 |
| supabase client 参数类型 | 映射层函数签名用 `Awaited<ReturnType<typeof createClient>>`（项目约定别名 `ServerSupabase`），**不要用裸 `SupabaseClient`** —— 后者缺 Database 泛型，`.select()` 返回类型同样退化成 `GenericStringError` | `lib/tasks.ts` / `lib/courses.ts` 写法、`Phase-0-MVP.md` P0-2-2 执行卡 |
| LLM 模型别名 | 请求 `deepseek-chat`，实际服务的是 `deepseek-v4-flash`。`llm_runs.model` 记**实际服务模型**，否则按模型维度对比准确率会失真 | `TechStack.md` §5.2、`Phase-0-MVP.md` P0-1-3 执行卡 |
| 抽取层保留原文语言 | prompt 必须写死「不翻译」—— 译文无法与原文核对，且**翻译不可逆**，抽取层丢掉的原文找不回来 | `TechStack.md` §5.5、`Phase-0-MVP.md` P0-1-4 执行卡 |
| PostgREST 构造器别抽成泛型函数 | 把带 `.select()` 的查询构造器当参数传给辅助函数 → `TS2589: Type instantiation is excessively deep`。排序这类几行的链式调用**各写一份**，比绕类型便宜 | `Phase-0-MVP.md` P0-1-9 执行卡、`lib/tasks.ts` 注释 |
| `.lte()` 会吃掉 NULL 行 | 时间窗口过滤 `due_date <= X` 对 NULL 求值结果是 NULL（不成立），TBD 行整批消失。要显式 `or('due_date.lte."X",due_date.is.null')`（值含 `:` `+`，双引号包住） | `API-Contract.md` §5、`Phase-0-MVP.md` P0-1-9 执行卡 |
| `tasks` 的 RLS 不看 `is_archived` | 策略 `tasks_via_course_all` 只经 `courses.user_id` 判定，归档课程的任务照样放行 → 总览页/单条查询都必须先取未归档课程 id 再 `.in('course_id', …)` | `lib/tasks.ts` 文件头注释、`Phase-0-MVP.md` P0-1-9 执行卡 |
| 同步的三条不变量 | ① 删除判定绑定「本次拉取是否完整」；② 时间比较用 epoch 不用字符串（同刻两种写法）；③ 写入字段封闭、不含用户可改字段 | 本节 10.1 第 13 条、`lib/sync/canvas-tasks.ts` 文件头、`Sync-Strategy.md` §7 |
| 节流检查的位置 | 排在「是否真的会发请求」之后，否则会盖住真正可行动的错误（token 失效被说成"太频繁"） | 本节 10.1 第 12 条、`Sync-Strategy.md` §4 |
| `courses.sync_status` 没有 `partial` | CHECK 只放行 never/success/failed。`partial` 是**一批**同步的属性，记在 `sync_runs.status`；逐课只有成功/失败。别为此改表结构（改 CHECK 要 Steven 手动跑 SQL） | `lib/courses.ts` `toSyncStateUpdate()` 注释、`API-Contract.md` §6 |
| `last_seen_at` 只在变化时刷新 | `tasks` 上有 `trg_tasks_updated_at` 触发器，任何 UPDATE 都刷 `updated_at` —— "每次同步刷 last_seen_at"与"不刷 updated_at"物理上不可兼得，实现选了后者 | `lib/sync/canvas-tasks.ts` 文件头、`Sync-Strategy.md` §7 |
| 三态语义别用 `undefined` 隐式承载 | `Map.get` 不存在 / `.find` 没找到 / 查询挂了 在 JS 里**长得一样**，用其中任何一种 `undefined` 当"加载失败"信号，第一次出现"该实体不存在"的正常场景就会误报 | 本节 10.1 第 14 条、`components/courses/course-card.tsx` 注释 |
| 聚合"最近一次成功"要遍历全集 | 只从状态好的实体里取最大值 → 全部失败时退化成"从没成功过"。**失败的实体也带着上次成功的信息** | 本节 10.1 第 15 条、`lib/sync/status.ts` `summarizeSyncStatus` |
| `last_synced_at` = 最后一次**成功**同步 | 失败不推进该列（P0-2-7 修正）。否则失败后 UI 把失败时刻当"最后同步时间" = 旧数据伪装成新的 | `Database.md` §3.2、`Sync-Strategy.md` §9、`lib/sync/canvas-sync.ts` `writeCourseState()` |
| 撤销凭据 = 占位密文覆盖，不是置空 | `secret_encrypted` 是 NOT NULL，且 `runCanvasSync` 顺序是**先解密再判 status**（`canvas-sync.ts:100-107`）→ 置空/空串会让解密抛错，同步从"优雅跳过"退化成整趟 500。正确写法 `encryptSecret('revoked')`：格式合法→解密成功→随后被 status 拦下 | `API-Contract.md` §6 `DELETE /canvas/credentials`、`lib/canvas/credentials.ts` |
| 撤销后过期提醒必须消失 | `toCredentialExpiryView` 对 `revoked` 也要返回 null，否则凭据行仍在 → 用户刚主动断开，dashboard 却催他"记得去 bCourses 重新生成 token" | `lib/sync/expiry.ts` 注释、`Phase-0-MVP.md` P0-2-9 执行卡 |
| 端点成功响应的包装不统一 | `jsonOk` 直接返回数据、不包装：单资源端点（`POST /courses`、`POST\|DELETE /canvas/credentials`）返回**扁平对象**，列表端点（`GET /canvas/courses`、`GET /tasks`）返回 `{data, meta}`。写断言前先 grep `jsonOk` 调用，别默认 `body.data.x` | `lib/api/response.ts` |
| 状态类视图要覆盖**全部**状态枚举 | 新增状态时（`revoked`），所有消费该字段的纯函数/UI 都要回头过一遍 —— 只判了 `error` 漏了 `revoked`，是"状态机扩展"最常见的一类回归 | 本节 10.1 第 16 条、`lib/sync/expiry.ts` |
| 写端到端脚本先核对请求字段名 | `canvasDomain`（不是 `domain`）／ `externalCourseId`（不是 `canvasCourseId`）／ Canvas 课程对象的 id 是 `externalId`（不是 `id`）。传 `undefined` 时字符串 `"undefined"` **能过** `[A-Za-z0-9_-]` 校验并"关联成功"，只在同步时报「Canvas 上找不到该资源」，极易误判成上游的锅 | 本节（无其他归属）、`types/canvas.ts`、`API-Contract.md` §6 |
| 关联成功会**自动触发一次同步** | 脚本里接着再打手动同步必撞 30s 节流（429）。要么等过窗口，要么直接复用关联那次的结果 | `API-Contract.md` §6 `POST canvas-link`、`Phase-0-MVP.md` P0-2-5 执行卡 |
| 两个写入方共用一张表时，按 `source` 收口 | 总览页只有 `tasks` 一张表，考试派生与 Canvas 同步各写各的 `source`。**任何一条查询/更新/删除漏了 `.eq('source', …)`，就会把对方的行当"缺席"删掉** —— 这是合并展示里最贵的一类事故 | `lib/sync/canvas-tasks.ts` / `exam-tasks.ts` 文件头、`Phase-0-MVP.md` P0-2-11 执行卡 |
| Next 路由文件夹**禁用 `_` 前缀** | `_` 开头 = **私有文件夹**，Next 直接把它排除出路由系统：`app/(routes)/_shell-preview/page.tsx` 请求得到 404，而且 **`next build` 不报任何错**、路由静默消失（build 绿 ≠ 路由存在）。预览/临时页文件夹名去掉下划线；确实必须保留 `_` 时写成 `%5Ffolder`。判据是 **curl 状态码**，不是 build 是否通过。P0-3-3 实测踩到 | 本节（无其他归属） |
| 主题脚本会让 `<html>` 报 hydration mismatch | 无闪烁主题脚本必须在 React 水合**之前**给 `<html>` 加 `.dark`，服务端 HTML 里必然没有它 → React 报 mismatch，**开发环境报错浮层把整页压暗一层**（看起来像"配色变丑了"，极具误导性）。修法：`<html suppressHydrationWarning>`，它只豁免 `<html>` 自身属性，不掩盖子树里的真实问题 | `app/layout.tsx` 注释、本节 10.1 第 19 条 |
| `tsx` 独立脚本不加载 `.env.local` | `npm run` 跑的 `tsx scripts/...` **不会**自动注入 `.env.local`（那是 Next 的特权）。脚本若要读 `DEEPSEEK_API_KEY` 等密钥，必须自己解析 `.env.local`（`scripts/regress-course-outline.ts` 的 `loadEnvLocal()` 是零依赖范例：读 `.env.local` → 逐行塞 `process.env`，已存在的真实环境变量优先、值去引号）。另：独立脚本**没有 Next 请求上下文**，`cookies()` 会抛 "outside a request scope"，调 `runStructured()` 需传 `record:false` 跳过 `llm_runs` 审计，避免刷屏 + 污染生产库。P0-3-4 回归脚本实测踩到 | 本节（无其他归属）、`scripts/regress-course-outline.ts` |
| Cloudflare Email Worker **没有 `message.text()`** | `ForwardableEmailMessage` 只有 `.raw`（原始 MIME 流）→ 写 `await message.text()` 抛 `TypeError` 被 `try/catch` 吞 → `textBody` 恒空 → **入站静默失效**（页面/日志都不报错）。用 `postal-mime`（实测 2.7.6）`PostalMime.parse(raw)` 取 `.text`，缺失时兜底剥 `.html` | `EMAIL_INBOUND_SETUP.md` 附 A、`workers/inbound-email/src/index.ts` 文件头 |
| Cloudflare 入站四个开通门槛 | ① 建任何规则前必须**先有已验证的「目标地址」**（哪怕邮件进的是 Worker）；② 密址带 `+`（`inbound+<token>@`）**必须开 Subaddressing**，否则 `+detail` 不保留在 `message.to`；③ 每用户动态地址**只能用 catch-all**（固定 local part 兜不住）；④ 面板入口已挪到 `Compute > Email Service > Email Routing` | `EMAIL_INBOUND_SETUP.md` §2–§6 |
| Worker devDep 与 wrangler 的 peer 范围冲突 | `@cloudflare/workers-types` 必须落在 wrangler 的 peer 范围内（wrangler 4.134 → `^5.x`）。钉 `^4` 会让 `npm install` **ERESOLVE 直接失败 → 部署卡死**，且**只在安装时报错**，极易误判成网络问题。离线自检：`npx wrangler deploy --dry-run --outdir /tmp/x`（不需要登录） | `EMAIL_INBOUND_SETUP.md` §5、`workers/inbound-email/package.json` |
| 入站邮件**不认 `From`** 绑定身份 | `From` 可伪造 —— 用它会退化成「任何人冒充 Gradescope 就能改你的任务」。只认收件地址里的**密址 token**（hex 全小写）。配套：webhook **永远返回 2xx**（含内部错误），否则邮件网关重试风暴 / 退信循环；失败落审计表而非抛 500 | `Decisions.md` **ADR-019**、`EMAIL_INBOUND_SETUP.md` 附 A |
| 🔴 **附加能力的 403 ≠ 凭证失效** | 实测 14 门课里 **8 门** `/files` 返回 **403**（压根没开 Files 区），同一 token 打它们的作业/文件夹全是 200。把它判成 `unauthorized` → `markCredentialFailed` → **停掉该用户全部同步**（凭证明明有效却被连坐）。**凭证有效性只由作业同步判定**；附加能力的 401/403 只跳过该资源、绝不写凭证状态。P0-3-19 实测踩到 | `Sync-Strategy.md` §8 的例外说明、`lib/sync/canvas-files.ts` 文件头 |
| Canvas 的 `hidden` 是 **`null` 不是 `false`** | 表示"未隐藏"时给 `null`。判据必须写成 `=== true`，任何"取 truthy"之外的写法都可能把正常条目判成隐藏 → **整门课的资料/作业消失且零报错**。P0-3-19 实测（Chem 1AL 55 个文件夹里 24 个真 hidden） | `lib/canvas/files.ts` `toCanvasFolders()` |
| 🔴 Canvas 文件的外链要**自己拼** | `/files` 返回的 `url` 是 `/files/{id}/download?...&verifier=…`，**需 Bearer**，浏览器点开 401。可用形态是 `https://{domain}/courses/{cid}/files/{fid}`（实测 200；`?preview=1` 与 `/files/{id}/download` 都 302） | `lib/canvas/files.ts` `filePreviewUrl()` |
| 🔴 **Canvas 的 `url` 是能力凭据（capability URL），不是链接** | **2026-09-18 实测修正上一条**：单文件端点返回的 `url`（`https://{domain}/files/{id}/download?download_frd=1&verifier=…`）**不带任何 `Authorization` 头直接 GET 也返回 200 与文件本体**。它不是"指向文件的链接"而是"打开这个文件的钥匙" → **既不能落库也不能下发浏览器**（谁拿到谁就能下全部课件），只在服务端当次请求内即时解析、即时用完。**推论：下载端口只能用这个 `url`** —— 试 `/api/v1/courses/:cid/files/:fid/download` → **404**。P0-3-19b 实测踩到 | `Decisions.md` **ADR-026**、`lib/course-files/summary/generate.ts` `resolveDownloadUrl()` |
| 对 JSON Schema **必填字段**，prompt 只能说"内容为空"，绝不能暗示"可以不要这个字段" | 摘要 prompt 加了句「材料里可能没有任何公式：那种情况返回空数组」→ 模型**整个省略 `formulas` 字段** → `schema_mismatch: $ 缺少必填字段 formulas`，**同一版 prompt 下 3 个文件全挂**（不是偶发）。改成「字段本身必须存在（三个字段都不能省略），只是内容为空」即恢复。**⚠️ 注意与「空数组也合法」的区别：schema 允许空数组 ≠ 模型可以省略该键** | `lib/course-files/summary/prompt.ts` `buildSummaryMessages()` |
| 「大模型输出超量 → 就地裁掉」要**计数并留痕**，否则是静默降级 | 实测 `PracticeMidterm1KEY_F23.pdf` 产出 **16 条要点**（要求 3–8 条），第一版实现直接 `slice(0, MAX)` → 用户看到 8 条以为就是全部。正解：`validateSummaryOutput()` 裁掉**并返回 `dropped` 数量**，先修 prompt 再观察；`dropped > 0` 是 prompt 需要收紧的信号，不是"输出正常" | `lib/course-files/summary/prompt.ts` `validateSummaryOutput()` |
| 🔴 **表是空的时候，「anon 读 → 空数组」证明不了 RLS** | 它无法区分「RLS 在拦」与「表里本来就没数据」—— 两条路都返回 `[]`。这一条在 P0-3-19 时不会暴露（那时 `course_files` 有 271 行真数据），到 P0-3-19b 的新表就骗人了。**必须先有一条真行再去读**：用线上同一条路径落一行（本例 `ensureFileSummary` → `ready/cached=false`），然后 anon 必须 0 行、**真实用户会话必须 1 行**。三步缺一不可 | 本节 10.1「RLS 有两半」、`supabase/migrations/20260922000000_file_summaries.sql` 验收记录 |
| 探针查"零残留"时 `select=id` 会让**没有 id 列的表假绿成 0 行** | `file_summaries` 的 PK 是复合键 `(course_file_id, locale)`，压根没有 `id`。点名查不存在的列，PostgREST 回的是**错误对象**而不是数组 → `Array.isArray(rows)` 判假 → 计数退化成 0 → 报告显示 ✅。**正解：用 `select=*`，并对"不是数组"单独报出来**（那是查询本身失败，不能伪装成"没有残留行"）。同理，兜底删除也不能假定有 `id` 列 | `scripts/probe-schema-constraints.ts`（`deleteBy` 字段 + RESIDUE 段注释） |
| 枚举 CHECK 探针的 `23503` 是**双证据** | 它表面说的是"CHECK 放行、被外键拦住"，但同时证明了**那个外键真的存在且指向预期表** —— 若 FK 不存在，插入会成功（`res.ok`）并触发兜底删除告警。所以看到 `23503` 就不必再单独查一遍 FK | `scripts/probe-schema-constraints.ts` 文件头 |
| Canvas `modified_at` ≠ `updated_at` | 同一文件实测差 1.5 小时（`00:28Z` vs `01:56Z`）：改的是元数据不是内容。拿 `updated_at` 当"内容变了"会让差量解析白跑一遍（安静地烧钱） | `types/canvas.ts` `CanvasFile.modifiedAt` |
| 断言里 `includes("page=")` 会误伤 `per_page=` | 写"路径不含 page 参数"的断言时，`per_page=100` 里就含 `page=` → 断言假失败。用 `/(?:[?&])page=/`。**先怀疑断言再改实现**（本卡第一版就是这样把两条绿的实现判成红的） | `scripts/regress-course-files.ts` |
| 纯逻辑要能被脚本 import，就**不能**和 `lib/supabase/server` 同文件 | 本卡初版把 `groupByFolder` 与查库函数写进同一个 `lib/course-files.ts`，而它 import 了 `createClient`（→ `next/headers`）→ 回归脚本用 Node 类型擦除根本跑不起来。拆成 `grouping.ts`（零依赖）+ `load.ts`（服务端），与 P0-3-25 的 `lib/messages/registry.ts` 同一条 | `lib/course-files/grouping.ts` 文件头、`lib/messages/registry.ts` |
| `wrangler secret put` **必须在 `deploy` 之后** | secret 是给**已存在的 Worker** 追加一个新版本；Worker 不存在时直接 `not found`。正确顺序：`login → deploy → secret put`。另：**Agent 侧跑不了 `wrangler login`** —— OAuth 回调要交互式终端，非交互环境直接报 `Not logged in ... the environment is non-interactive`，此步只能由人工在本地终端执行（或改用 `CLOUDFLARE_API_TOKEN` 环境变量） | `EMAIL_INBOUND_SETUP.md` §5 |
| 管道喂 secret 时**末尾不能带换行** | 交互式粘贴 secret 极易在末尾混进 `\n` → Worker 发 `Bearer <密钥>\n` → Vercel 逐字比对失败 **401**，而面板里看不出任何区别。用 `printf '%s' '<secret>' \| npx wrangler secret put NAME`（`printf` 而非 `echo`，`echo` 会补换行） | `EMAIL_INBOUND_SETUP.md` §5 |
| catch-all 规则**只能走专用端点** | Email Routing 的 catch-all 是**规则表里一条 `matcher=all` 的普通形状记录**，但用通用端点 `PUT /zones/{zone}/email/routing/rules/{rule_id}` 更新（哪怕填的就是它的 id）会返回 **409 `Invalid rule operation`**。必须用 `GET/PUT /zones/{zone_id}/email/routing/rules/catch_all`。且它是 **zone 级**资源 —— `/accounts/{acc}/email/routing/rules/catch_all` 返回 `404 page not found`（而 `/accounts/{acc}/email/routing/rules` 列表端点却是通的，极易带偏）。回滚 = 同端点 PUT `{"actions":[{"type":"drop"}],"enabled":false}` | `EMAIL_INBOUND_SETUP.md` §6 |
| `wrangler login` 之后 **Agent 可接管全部 Cloudflare 操作** | OAuth 凭据落盘在 `~/Library/Preferences/.wrangler/config/default.toml`（字段 `oauth_token`，沙箱可读），因此**只要人工做过一次 `wrangler login`**，Agent 侧就能直接跑 `wrangler deploy` / `secret put` / `whoami`，并用该 token 打 Cloudflare REST API（curl `Authorization: Bearer $TOKEN`，含 `email_routing` 等 scope）。反之未登录时 `whoami` 报 `Not logged in ... the environment is non-interactive` —— 别把这句当成"网络不通" | `EMAIL_INBOUND_SETUP.md` §5/§6 |
| 一次改多个 Vercel env → **触发多个部署，中间那个会先上线** | 实测：同一轮加 `INBOUND_EMAIL_SECRET` + `INBOUND_EMAIL_DOMAIN`，结果**前者立刻生效、后者报 `inbound_not_configured`**，看着像"变量名打错/值没保存"。真相：每加一个变量触发一次部署，先加的那个（部署 A）先构建完成为 Production，后加的那个（B）还在构建 → **"一半生效"的中间态**。面板按「最近更新」**倒排**，所以**最上面那行是最后加的**（可据此判断顺序）。判据：**别信面板状态，直接打端点**，等 1–2 分钟重打即可。正确做法：多个变量一次性加完再手动 Redeploy 一次，或加完耐心等**最后一个**部署 | `EMAIL_INBOUND_SETUP.md` §7 |
| 审计表**不是**"邮件到没到"的判据（无效 token 不落审计） | `unknown_address` 在 `lib/email/inbound.ts` 里**早退**——此时还没解析出 `user_id`，而审计行 `user_id` 非空，没处挂 → **只体现在 webhook 的 HTTP 响应体**，审计表里查不到。同理 `no_text` 也不落审计。**"审计表没有"≠"邮件没进系统"**：先看 webhook 响应体 / `wrangler tail`，再看审计表 | `EMAIL_INBOUND_SETUP.md` §9 | 
| 用**有副作用**的请求去探测"新部署上线了吗" | 探测请求会打到**旧部署**上并**真的改数据**（本日实测：轮询入站 webhook 判部署，第 1 发落在旧部署 → 把 `Homework 9` 从 pending 标成 done，只能手工回滚） | 判部署新鲜度要用**零副作用**信号：无鉴权的 GET / 只读端点 / 带**无效凭证**的请求（必被拒），或干脆等固定时长。**别用"能触发写操作"的请求当探针** —— 轮询 N 次的第 1 次几乎必然打在旧部署上。另：写了数据要**保留审计行**（那是真实发生过的事），但必须在日志里记下手工回滚 |
| 用"看起来很安全"的输入当探针 | 以为"不存在的作业名"必然走未命中 —— 实测它模糊命中了真实作业；以为"带后缀的长标题"必然不失配 —— 实测 **LLM 解析层会把后缀剥掉**、抽出干净标题照样命中 | ① 探针输入要取**语义上不可能存在**的值（如纯数字哨兵）；② 更需要先**真跑一遍**（真函数 / 真端点）再下结论，而不是推理"应该不会命中"。**"我猜它不会命中"不是安全论证。** 本日因此连续两次改动真实数据 | `EMAIL_INBOUND_SETUP.md` §8.3 / §9、`lib/email/inbound.ts` |
| 交互式召回阈值（0.6）不能套到无人确认的自动落写 | `MATCH_THRESHOLD = 0.6` 是为**对话框列举候选**定的（多列一条用户划掉即可，召回优先合理）。但邮件入站**无人确认、直接写 `status='done'`** —— 同一阈值下 `Homework 9999`（不存在的作业）以 **0.84** 命中 `Homework 9`、`Homework 5` 与 `Homework 2/6/7` **同分 0.89**。根因：`normalizeTitle` 把数字也拼进 token 串，编辑距离 / Dice 对"数字被换掉"极不敏感；且 `matchTasks` 只按分数 `sort`，**同分无确定性 tie-break**（保留候选数组原序 = DB 返回顺序），**破坏了 match.ts 自己声明的"可复现"目标**。 | ✅ **已修（2026-09-17）**：自动写路径改为**归一化后完全相等**（`lib/email/plan.ts` 不再用 `matchTasks`），同名多条时"只剩一条未完成才写 / 全完成则 `already_done` / 多条未完成则 `ambiguous_title` 放弃落写"（绝不按返回顺序猜）。回归 14→23 条。**通用规则：有人确认的路径可以召回优先，无人确认的路径必须精确优先 + 确定性 tie-break。** | `EMAIL_INBOUND_SETUP.md` §8.3、`lib/email/plan.ts` |
| 「算不算完成」的判定在组件里分叉 | 分组用 `isEffectivelyDone()`、行内渲染写 `status === 'done'` → Canvas 已判完成的作业归进「已完成」盒却画着空勾选框（实测 83 条里 40 条）。**`tsc` / `eslint` / `build` / 回归全绿**，只有肉眼看截图才发现 | 本节 10.1 第 21 条、`components/tasks/task-list.tsx` 文件头 |
| Canvas 已判定完成时，勾选框**不可点** | 写 `status` 的任何方向都改变不了 `isEffectivelyDone()` 为真的事实 → 按钮点了没反应 = 静默失败。正解：画成灰色实心勾并禁用，由徽标说明来源；**用户主权只在 Canvas 没有真相时才需要表达** | 本节 10.1 第 21 条、`components/tasks/task-list.tsx` `TaskRow` 注释、`Decisions.md` ADR-015 补充 |
| 🔴「逻辑上永不成立」的守卫 = **判定结果没带回它的依据** | `decideDrift()` 初版只返回 `{ kind: 'baseline' }`，调用方于是被迫写 `if (!candidate) continue` —— 这个 `if` 在业务上不可能成立，它存在的唯一理由是 `tsc` 要求（第一个 `if` 骗过编译器，真分支靠 `!` 断言）。修法不是加 `!` 或 `as`，而是让**判别联合的每个分支携带自己的证据**（`baseline`/`propose` 直接带上 `candidate`），守卫随之消失。**判据：一个分支写不出业务理由、只能写出"编译器要我写"，就该改数据结构。** P0-3-20 实测 | `lib/syllabus-drift/files.ts` `DriftDecision` |
| 🔴 自动化写入的行**必须保持"未确认"**，否则功能在第一次接受之后就死了 | 漂移提案写 `exam_dates` 时标 `source='syllabus'` + **`is_confirmed=false`**（刻意不写 `true`）。写成 `true` 之后，同一份大纲再被这套自动化发现变化时，界面会回「这条你已经确认过」→ **从此再也写不进去**。通用问法：**"这条记录还会不会被同一套自动化再次更新？"** 若会，它就不能被标成"用户已确认"。P0-3-20 实测 | `lib/messages/appliers/syllabus-drift.ts`、`lib/exam-dates.ts` `deriveStatus()` |
| 🔴 撤销里若有 **update**，就**不能按 id 删** —— 必须按"结构化旧值快照"写回 | 公告撤销可以按 id 删新增行；漂移里有**改期**（update），按 id 删会把用户原来那条考试日期一起删掉、等于撤销比不改更糟。正解：确认时把 `exam_date`/`exam_time` 的**结构化旧值**存进 `payload.applied.examRestores`。**⚠️ 不能存界面那句人话 `before`** —— 它拆不回字段。配套：「只更正 1 条、没新增」这一最常见形态要求 `countApplied()` 把还原数也算进来，否则撤销按钮根本不出现 | `lib/messages/undoers/syllabus-drift.ts`、`lib/messages/view.ts` `countApplied()` |
| 客户端懒补结果**只换 payload，不整条替换本地那行** | 懒补后端返回整条 `Message`，但客户端只能按 id 更新 `payload` 字段：本地状态可能比服务端返回的**更新**（用户刚点了确认 / 本地刚撤销），整条覆盖会把 `accepted` 悄悄回退成 `pending`。范式同 P0-3-25b 的公告要点懒补 | `components/messages/messages-view.tsx` |
| 比时间戳**用 epoch，不用字符串** | PostgREST 回 `+00:00`、Canvas 给 `Z` —— 同一个瞬间字符串并不相等 → 差量判定**每轮都误报"变了"**（还安静地重复烧钱/重复下载）。统一走 `sameInstant()`，回归里有专门断言钉着 | `lib/time.ts`、`scripts/regress-syllabus-drift.ts` |
| 探针的启发式正则**必须带词边界**，否则把噪音当信号、结论方向整个反 | 诊断段用 `SUSPECT` 判断"这门课是不是真没传 syllabus"，无 `\b` 时 `info` 命中 R4A 的 `…about Misinformation.pdf` → **4 条全误报**，会得出"名字不匹配"的错误结论。改用**带词边界**的白名单正则（`\b` + `info` / `information` / `overview` / `course` …）后归零，5 门课正确显示"真没有"。**探针的错误结论比没有探针更贵** —— 它会让人去修一个不存在的问题 | `scripts/probe-syllabus-drift.ts` |

---

*创建：2026-09-01 ｜ 最近更新：2026-09-18（**§10.2 新增六行 P0-3-20 坑索引**：「逻辑上永不成立」的守卫 = 判定结果没带回它的依据 / **自动化写入的行必须保持"未确认"**（否则功能在第一次接受之后就死了）/ 撤销里含 **update** 就不能按 id 删、必须按结构化旧值快照写回 / 客户端懒补**只换 payload 不整条替换** / 比时间戳**用 epoch 不用字符串** / 探针启发式正则**必须带词边界**）。此前 2026-09-17 更新（§10.1 新增第 21 条「同一判定在组件里分叉」+ 两行坑索引（分叉判定／Canvas 已判定完成时勾选框不可点）。此前同日更新含 §10.2 邮件入站相关坑索引累计新增：`wrangler secret put` 须在 deploy 之后 / 管道喂 secret 禁带换行 / catch-all 只能走专用端点 / `wrangler login` 后 Agent 可接管 Cloudflare 操作 / **一次改多个 Vercel env 会触发多个部署、中间那个先上线** / **审计表不是"邮件到没到"的判据**（无效 token 早退不落审计）/ **交互式召回阈值不能用于无人确认的自动落写** / **别用有副作用请求当部署探针（会打在旧部署真改数据）** / **"看起来安全"的探针输入也会命中（LLM 会剥后缀）**。更早 2026-09-13 更新含 §10.1 第 17–19 条与六行坑索引）*
