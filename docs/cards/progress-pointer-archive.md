<!-- 出处：docs/Phase-0-MVP.md L30–L195｜当前进度指针（166 行全量留档）｜2026-09-18 拆分，逐字保留 -->

## 当前进度指针

**当前 task**：**`P0-3-12` 全站视觉统一扫尾**（**必须排在所有 UI 改动之后**）→ 然后 **`P0-3-13` freeze（出口门）**。**✅ 第 30 张卡 `P0-3-20`（大纲漂移检测）Steven 验收通过 2026-09-18**（M3 新执行链第 6 张；依赖 `P0-3-19` ✅ 与 `P0-3-27` ✅ 均已验收）—— 交付 `6fe260e`（代码）+ `3908dcd`（迁移注释修正），均已 push + Vercel success。**✅ 迁移 `20260923000000_syllabus_drift.sql` 已由 Steven 手跑 + 两条腿复核生效**（① 他截图里第二条查询拿到 **1 行 `FOREIGN KEY → course_files`**；② `probe:syllabus-drift` 打真接口读到「✓ 两列都在（共 6 门课）」，`42703` 消失）。**验收用真实入口代跑 + 零残留播种走完全链**：①「第 9 步」两轮 `baselined=1 / proposed=0` → `unchanged=1 / proposed=0`（幂等 ✓ / 锚点落在**文件的 `modified_at`** 而非 `now()` ✓ / **0 条新消息** ✓）；② A 方案把锚点写旧 → `proposed=1` 建提案 → 懒补 diff `clean · 正文 13947 字符 · deepseek-flash` → 确认（刻意空写入）→ `exam_dates` 逐 id 与基线一致，重跑懒补 `eligible=0`（幂等）；③ **零残留播种**把标准 ① 的「新增 X / 变动 Y → 确认 → 写入 → 撤销还原」走通，**全程不碰任何真实行**。⚠️ **唯一仍未被真实数据验的一环 = 「模型从一份真的内容变过的大纲里读出差异」**（库里那份与 `exam_dates` 本就一致）。**本卡开工第一件事改了卡面的抓取时机**：卡面原案写「**同步时**按需抓 syllabus 文件 → 抽文本 → diff」，与 **ADR-026**（批量/后台零下载）冲突，且定时同步跑在 service role + 无 cookies 下写不进 `llm_runs` 审计（实测 `cookies was called outside a request scope`）；停手问 Steven 后**三问拍板**（懒补 diff / 只改未确认的 syllabus 行 / 锚点存 `courses` 两列），详见下方详细卡。**✅ **`P0-3-23`（practice test 生成 · 类型 A 忠实自测）Steven 验收通过 2026-09-18**（原话"验收没有问题了"）—— 第 31 张卡，由并行窗口交付：`e00710d` 代码 + `8060656` 迁移复核 + `48a7120` 收尾共享面五处 + `4f62e64` 坑索引，四笔均已 push + Vercel success；迁移 `20260924000000_practice_tests.sql` 已由 Steven 手跑 + **零残留探针五查全过**（两表在 / 29 列点名 / 枚举 CHECK + 对照组 + `locale='fr'` 反向断言 / RLS 双向含两跳 / 唯一键 `23505`）。见 **ADR-027**。**🔴 下一张 = `P0-3-12` 全站视觉统一扫尾（必须排在所有 UI 改动之后）→ `P0-3-13` freeze（出口门）**。**最近一张 `P0-3-19b`（资料索引 · **文件夹树** + **一键总结**）** ✅ **Steven 验收通过 2026-09-18**（原话"验收没问题了，通过"；3-19 验收后 Steven 追加两项修改：① 文件按老师的分类进文件夹 ② 每个文件旁出「一键总结」跳 HTML 页）。交付 `015dc46`（代码）+ `3069376`（迁移生效复核），均已 push + Vercel success；**迁移 `20260922000000_file_summaries.sql` 已由 Steven 手跑并逐条复核生效**（`probe:schema` 12/12 + 13 列点名 + 真跑写入路径 `cached=false→true` + RLS 双向 anon 0 行 / 用户会话 1 行）。**✅ Steven 验收通过 2026-09-18**（原话"验收没问题了，通过"）。决策见 **ADR-026**。**上一张 `P0-3-19`（资料索引 · Canvas 文件元数据）** ✅ **Steven 验收通过 2026-09-18**（原话"可以了"；代码 `faf6323` 已 push + Vercel success）。迁移 `20260921000000_course_files.sql` 经 Steven 手跑，**且不信面板 `Success`、逐条打真接口复核生效**（新列 `courses.files_scanned_at` / 新表 `course_files` / 去重键抽样 / `anon` 读空返回，四查全过）；本地用**真实同步入口** `runCanvasSync(trigger:'manual')` 代跑一次 → **6 门课 271 个文件落库**（18.3s，`coursesScanned 5 / coursesSkipped 1`＝MATH 53 未开 Files 区）；**幂等复验**（连跑两次，第二次 `0/0/0`）；**以真实用户会话读 `course_files` = 271 行**（`service role` 绕过 RLS，证明不了页面读得到，故补此一验）；验收标准 ①Chem 1A 分层 10/6/5 ②外链 `/courses/1555045/files/95459083` ③403 跳过 sync 不挂 —— 三条全部在库内真实行上命中。**上一张 `P0-3-27`（M3.5 · URL 自动抓取）** ✅ **Steven 验收通过 2026-09-18**（`e372424` + `a49f9bc` 已 push + Vercel success）。**上一张 `P0-3-26`（M3.5 · 回执 + 撤销）** ✅ **Steven 验收通过 2026-09-18**（`684607e` 已 push + Vercel success；迁移 `20260918000000` 经 Steven 手跑 + `probe:schema` 确认 `undone` 被接受、对照组仍被拦）。**上一张 `P0-3-25b`（M3.5 · 公告要点 AI 总结）** ✅ **Steven 验收通过 2026-09-18**（原话"Nice Job，没有问题了，验收通过"；`08670d0` 已 push + Vercel success；迁移 `20260920000000` 经 Steven 手跑 + 只读复核表在 + **anon key 验 RLS 空返回**；代码为懒生成 + 落库缓存、**只对仍待处理的公告消息**生成，见 **ADR-024**）。**`P0-3-25`（M3.5 · 公告自动进站）** ✅ **代码完成并已上线**（`002522b` + C 口径 `07d810a` + 窗口收窄/课程色 `2bedddd`，均已 push + Vercel success；迁移 `20260919000000` 已由 Steven 跑 + 只读探针确认 `announcement` 放行、`material` 老值没丢）。**✅ 产品口径已拍板（2026-09-18 Steven 选 C，ADR-022）**：C = **有落点逐条进消息栏 + 无落点全部合并成一条摘要（可展开看逐条原文入口）**。**✅ 验收修正已实现（2026-09-18 晚，ADR-023）**：① 窗口起点改为**跟锚点**（上次成功同步那天），常态只抓"当天 + 昨天"（实测 48 条 → 5 条 → **真正新增 0 条**）、断更自动回补、14 天上限 —— 直接改成"只抓当天"会漏掉「cron 跑完后又发布」的公告且无任何提示；② 消息栏课程标签改**彩色徽标**（`COURSE_TONES`，逐条/摘要两条通道同色）。实测真账号 14 天窗口 **48 条公告**（40 条无落点、8 条判"有落点"里只有 2 条真能写出字段）—— 每条各进一次 = 48 次操作，与 ADR-016「用户操作量趋零」冲突；C 口径下消息栏**只新增 9 条**（8 逐条 + 1 摘要）而**一条不漏**。（三个候选 A/B/C 与实测数据留档见下方「freeze 前闭合」表 —— 已拍板走 **C**，决策记于 **ADR-022**。）**上一张 `P0-3-24`** ✅ **Steven 验收通过 2026-09-17 晚**（原话"现在效果非常完美"；`405cd37` + `3801dca` 已 push + Vercel success；迁移 `20260918000000` 已跑 + 只读探针确认 `'canvas'` 放行、CHECK 仍在拦非法值）。⚠️ 验收时 Steven 报出的衍生需求（Gradescope 成绩手报 + 外平台已完成仍显逾期）已**评估后决定暂不做**，结论留档见下方「freeze 前闭合」表。**上一张 `P0-3-18`（消息栏）** ✅ **Steven 验收通过 2026-09-17 晚**（代码 `3fff155` 会话式版面 + `1cdbe85` 课程下拉修复，均已 push + Vercel success；`messages` 建表 SQL 经 Steven 手跑 + 只读探针确认表/RLS 就位）。**🔴 M3.5 段（O-13，Steven 2026-09-17 晚拍板四项：§14 改 / OH 去掉 / 撤销 24h / 轮询每日 2 次）**：`3-24 考试可编排+写入器 ✅ → 3-25 公告自动进站 ✅ → 3-25b 公告要点 AI 总结 ✅ → 【下一张】3-26 回执+撤销 → 3-27 URL 抓取` → 之后回 `3-19 资料索引 → 3-20 大纲漂移 → 3-23 practice test → 3-12 扫尾 → 3-13 freeze`。（3-24/3-25/3-25b/3-26 各有迁移，均【Steven 手动】先跑 SQL 后部署，否则 42703 全挂；3-24 的 `grade_components.source` 加 `'canvas'` 已于 2026-09-17 晚跑完 + 只读探针确认生效；3-25 的 `20260919000000` 与 3-25b 的 `20260920000000` 均已跑完 + 只读确认）。****上一张 `P0-3-17`（课程详情重排 + 抓取信息落地）** ✅ **Steven 验收通过 2026-09-17**（原话"没有任何问题了，验收通过，效果非常好"；迁移 `20260917140000` 已跑 + 只读探针确认三列存在 · push `5435202` → 验收修正 `c285f70` → 分数条分段上色 `9e61f42` · Vercel success）。**`P0-3-16`（Dashboard 精修）** ✅ **验收通过 2026-09-17**（commit `60f0923`；`/dashboard` 原「已到期作业」卡已消失、换成「今日任务」加权切片卡）。⚠️ 进度指针此前误指 `P0-3-12` —— 2026-09-17 16:0x Steven 把 `3-16 / 3-17 / 3-18 / 3-19 / 3-20 / 3-23` **上移进 M3**，`3-12` 视觉扫尾**重排到所有 UI 改动之后**（见下方排序纪律）。上一张 **`P0-3-15`（完成态统一 + 提交态徽标）** ✅ **Steven 验收通过 2026-09-17**（原话"验收通过，效果非常好"；commit `cfc34ef` 已 push + Vercel success）—— 修 `TaskList`「分组用合并判定、行内渲染只看 `status`」的**渲染层判定分叉**（83 条里 **40 条**画错）+ Canvas 已判定完成时勾选框改**静态灰勾不可点** + 任务名后**六态徽标**；**`P0-3-14`（主动提醒 / 优先级）** ✅ **验收通过 2026-09-17**（出站全链路已上线 + 真发已收：迁移 ①/Workers Paid ② 本就已付费/发件地址验证 ③/出站 Worker ④/Vercel env ⑤ 全部就绪；生产真发 `usersReminded:1` + 立刻重打被频控拦下；正文口径收敛为**聚焦版**；验收发现的「可提醒范围误报 86%（漏筛 `submission_state`）」已修）；**`P0-3-11`（邮件通道·入站）** ✅ 代码完成 + **真人真邮件端到端验收通过 2026-09-17**（入站-only：密址绑定 + 纯入站，出站归 P0-3-14）；✅ **部署 8/8 步**（①–⑦ 配置全部生效，⑧ 真人转发真 Gradescope 回执验证 `MX→catch-all→Worker→Vercel` 全链路通过）；**`P0-3-9`（截图档）** 代码完成、真实识别待 Steven 贴 `DASHSCOPE_API_KEY` 后补验；**P0-3-2 已验收**。
- ✅ **O-11 关闭：多模态 provider = Qwen 通义千问**（中国区 DashScope，默认 `qwen-vl-plus-latest`，可用 `LLM_MODEL_VISION` 覆写；需切回 Claude 时设 `LLM_PROVIDER_VISION=claude`）。配套 **ADR-018**：provider **按能力路由** —— 文本仍走 DeepSeek（**现有五板块解析零回归**），视觉走 Qwen。同时解决 **O-08**：两路均中国境内、无数据出境。
- ✅ 另三项决策：**图片不落库**（浏览器压缩后 base64 直传、即用即弃）｜**范围 = 确认完成 + 新增/改期**（完全复用 3-8b 的 `match` + `PATCH`）｜**零迁移**（不新增列）。
- **`P0-3-14`「主动提醒 / 优先级」**（Steven 2026-09-13 同意立项，2026-09-17 开工 → 同日验收通过）—— ✅ **验收通过 2026-09-17**（三路由 + 出站 Worker + 迁移 + Vercel env 全部就绪，生产真发已收，验收发现的误报已修并随本次 dashboard 验收一并通过）。三项拍板：**渠道 = 邮件**（Web Push 排除）/ **优先级 = 截止临近排序**（不碰 Phase 2 权重）/ **正文口径 = 聚焦版**（只列「可行动」项 = 逾期 + 3 天内，其余折叠成一行计数 —— 首版全量平铺生成 63 行而主题写 20，口径打架且属洪水式日报）；ADR-017 点名它是"秘书"最核心的护城河，此前**无对应卡**；与 3-11 的出站范围边界见下方执行卡。
- 上一张 `P0-3-8` + `P0-3-8b` **已验收通过 2026-09-13**（Steven 原话"验收通过，效果非常好"；代码 `45d3bc3` + `5969f55` + follow-up `4f86ab7`）。
- ✅ `P0-3-8` 课程更新对话框（文本档）**用户验收通过 2026-09-13（Steven 原话"验收通过，效果非常好"；代码 `45d3bc3` + 3-8b `5969f55` + follow-up `4f86ab7`）**：全局浮窗 FAB + `POST /api/v1/tasks`（手动任务）+ `DELETE /api/v1/tasks/:id` + `POST /api/v1/tasks/parse`（LLM 解析·**不落库**）。**用户验收通过 ✅**。
- ✅ `P0-3-8b` 对话框**检索/更新档** **用户验收通过 2026-09-13**：新增 `lib/tasks/match.ts`（**确定性匹配，不用 LLM**）+ `GET /api/v1/tasks/search`（候选检索）+ `PATCH` 放开手动任务内容编辑（非 manual 返回 `source_not_editable`）。浮窗流程升级为「解析 → **先检索现有任务** → 0 命中新增 / 有命中**列举让用户选** → 确认」。**用户验收通过 ✅**。
- 🆕 **新增决策 `ADR-017`**：产品定位「**每个人的电子秘书（Jarvis）**」，**不是又一个日历 App**（本卡一并落盘，写死）。
上一张 `P0-3-7b` 总览页收纳 ✅ **已验收 2026-09-13**（Steven 原话"验收通过，效果非常好"；代码 `ba361c4` 已 push）—— 新增 `app/(routes)/courses/page.tsx` / `lib/courses/course-list.ts` / `lib/tasks/format.ts`；`/dashboard` 瘦身为纯任务视图（`<h1>` 改「接下来」）。**Steven 拍板两个决定**：① 侧栏**单入口**「我的课程」→ `/courses`（不内嵌课程列表）；② 课程卡**原样搬**、保持 2 列。**命名修正**：侧栏那项不是「单科详情」（该页早已存在于 `/courses/[id]`），而是课程目录。
> ⚠️ **3-7b 是 3-7 的收纳 follow-up，不是新功能** —— 它把 3-7 交付的 dashboard 从「任务 + 课程混装」收敛成纯任务视图。**结构改动 → 排在 3-12 视觉扫尾之前。**
上一张 `P0-3-7` 总览页可视化 ✅ **已验收 2026-09-13**（Steven 看过真实渲染效果后认可，原话"现在做的很好"；代码 `6c8b3b2` 已 push）。执行中的两处偏离（「进度条」→「已到期作业」负担卡、追加「最近的考试」条）见下方 3-7 执行卡。
后续可开：`P0-3-9`（截图档，仍依赖 O-11）/ `P0-3-11`（邮件通道，3-8 已验收通过 2026-09-13）/ 🆕 **建议立项「主动提醒 / 优先级」** —— 按 **ADR-017**，它是"秘书"最核心的护城河能力，目前无对应卡。
> ⚠️ **3-8 / 3-9 原排在 3-10 之后**：3-10 已于 2026-09-13 完成验收 → **3-8（依赖 3-4 已完成）亦可开**；截图档 3-9 仍依赖 O-11（多模态 provider），O-11 未解决前不要硬上。
上一张 `P0-3-6` 总览页列表收敛 ✅ **已验收 2026-09-13**（Steven 眼球验收 + Bud 本地 build 验证）。
上一张 `P0-3-4` 解析质量修复 ✅ **已验收 2026-09-13**（回归门 4/4 PASS，commit `ed143f1` 已 push，Vercel 部署）。
上一张 `P0-3-3` 设计基线 ✅ **已验收 2026-09-13**（commit `c4bc1e0` 已 push）。
上一张 `P0-3-2` 设置与隐私页 ✅ **已验收 2026-09-13**（Bud 用真实登录态 session 探针复验 + Steven 挂了 4 天的浏览器验收项收口）。
**M3 已重定义为「打磨收敛期」（2026-09-13）：13 张卡，出口门 = P0-3-13 版本 freeze，之后不追加。** 实际执行中于 2026-09-13 / 09-17 按 Steven 拍板**另追加** `P0-3-14`（主动提醒 / 优先级，ADR-017 点名的护城河，原清单无卡）与 `P0-3-15`（完成态统一 + 提交态徽标，由 3-14 验收触发）→ **M3 实际 15 张卡**，exit gate 仍是 `P0-3-13`。**截至 2026-09-17：仅剩 `P0-3-12` + `P0-3-13` 两张，之后锁版。**
上一张 `P0-3-1` 已于 2026-09-09 验收：Steven 执行迁移后，生产库实测 `GET /api/v1/metrics` 返 200 + 四项指标（冷启动态：两项 `null`、人均 1.0）。
四项指标：编辑修正率 / 7 日回访次数 / 人均关联课程数 / token 续期完成率；**口径须与 `PRD.md` 定义一致**。

> ⚠️ **验收前有一个【Steven 手动】步骤**：新表 `usage_events` 的迁移
> `supabase/migrations/20260907120000_usage_events.sql` 需在 Supabase Dashboard → SQL Editor 执行。
> 未执行时 `GET /api/v1/metrics` 返回 **500**（这是刻意设计：宁可报错也不返回假 0），
> 埋点写入则被静默吞掉（只 console.warn，不影响页面）。执行后该端点即返回 200 + 四项指标。

> 🔵 **领卡前先做两件事（2026-09-06 定）**：
> ① `grep -rn "// ?" --include=*.ts --include=*.tsx` 扫 Steven 留下的提问标记，先作答再写卡；
> ② 交付时**必须**先给「给 Steven 的三行」（点名 ≤2 个文件 + 一个反直觉的点 + 可点的验收路径），格式与四条硬约束见 `CodingRules.md` §6.1。

> ✅ 上一张 `P0-2-11` 总览页合并 **验收通过（2026-09-05 深夜，第 21 张卡）—— M2 收官 11/11**。执行卡见下方「P0-2-11 总览页合并」。依赖 P0-2-5、P0-1-9（均已验收）。**本卡零功能代码**：合并机制已随 P0-1-9 + P0-2-5 落地，端到端核对 28/28 全绿无缺陷；交付是 2 处契约收口 + Steven 拍板「不加来源标签」。

> ✅ **M2 动态感知 收官（11/11）**：P0-2-1 / 2-1b / 2-2 / 2-3 / 2-4 / 2-5 / 2-6 / 2-7 / 2-8 / 2-9 / 2-11 全部验收通过（P0-2-10 iCal 兜底按 P0-2-1 结论不执行，不计入分母）。**下一阶段 M3（P0-3）验证与收尾。**

> ✅ **P0-2-9 撤销授权入口 验收通过（2026-09-05 21:30，Steven，第 20 张卡）**：浏览器实测 —— 课程详情页「Canvas 关联」区块的撤销入口可见、文案已说明"账号级操作"、确认框正常。**M2 推进到 10/11**。commit `40afd47`（代码）+ `31b47a4`（踩坑沉淀），Vercel 部署 success（生产探针 `DELETE /api/v1/canvas/credentials` → 401）。

> 🔄 **M3 已重定义（2026-09-13，Steven 拍板）**：原「验证与收尾」拆成两段 —— **M3 打磨收敛期**（13 张卡，只打磨、不接触真实用户，产出**可发版**）+ **M4 验证期**（原招募/跑通/反馈/Gate 四张卡下移并重编号为 `P0-4-1 ~ P0-4-4`）。原 P0-3-3「种子用户招募」现在是 **P0-4-1**，owner 仍是 Steven（5-6 人，技术型 2-3 + 非技术型 2-3，覆盖 ≥2 门学科；**构成不对会导致 Gate 0→1 结论不可信 —— 这张卡要早打招呼**）。

> ✅ **P0-2-8 Canvas token 过期提醒 已于 2026-09-05 晚验收通过**（Steven 浏览器验收，第 19 张卡），卡已闭环，执行卡保留在下方。

> ✅ **P0-2-7 验收通过（2026-09-05 15:35，Steven，第 18 张卡）**：浏览器验收通过，3 个 `p027-*` 测试 auth 号已由 Steven 删除干净，本卡无遗留。commit `b70ce71`，Vercel 部署 success。**M2 推进到 8/11。**

> 🔵 **P0-2-7 已开工并完成代码（2026-09-05）**：dashboard 顶部汇总状态条 + 每门课卡片一行；**不轮询、不建 `GET /sync/status`**（服务端组件直读）；失败**分级**（能修→去重新连接 Canvas 且不给重试按钮；只能等→重试 + 说明自动重试）；token 续期提醒剥离给 P0-2-8。新增 `lib/sync/status.ts`（纯函数视图模型）+ `components/sync/sync-status-bar.tsx` + `sync-retry-button.tsx` + `lib/sync/browser.ts`。🔴 **`last_synced_at` 语义修正**：失败不再覆写该列（此前会把"失败那一刻"当成"最后同步时间"，等于把旧数据伪装成新的），已用真实 PAT 端到端验证。自测：纯函数 45/45 + dashboard SSR 28/28 + 真实 Canvas 端到端 16/16。

> ✅ **第一拍已验收通过（2026-09-05，Steven）**：① `/sync/now` 支持可选 body `{trigger: 'manual' | 'app_open'}`（双档节流 30s/60s，服务端权威；`scheduled`/非法值 → 400）；② `components/sync/sync-controls.tsx`（挂载 + `visibilitychange` 自动同步、手动「同步 Canvas」按钮，无关联课程不渲染不触发）；③ dashboard 接线。自测 tsc/lint/build ✅ + 冒烟 18/18。
> ✅ **第二拍（T3 平台定时兜底）已验收通过（2026-09-05，Steven 生产验证）**：`GET|POST /api/v1/sync/scheduled`（CRON_SECRET 恒定时间比较 + fail closed）+ `lib/sync/scheduled.ts`（串行逐用户、聚合统计、240s 预算）+ `lib/supabase/admin.ts`（service role 唯一入口）+ `vercel.json` 两条 cron。**同步层四处查询补强制 `userId` 过滤**（service role 绕过 RLS，靠隐式隔离会跨用户串数据）。**✅ 完整循环实测已补（2026-09-05 傍晚，Steven 交付 service role key 后）**：真 service role 跑完整循环 13/13 —— 跨用户隔离探针通过（B 有凭据有课不关联 → 任务保持 0，A 被清空后由定时扫描拉回 25 条）、二跑幂等 created/updated/deleted 全 0、响应不含 UUID/课程名。**生产端到端验收（2026-09-05 傍晚，Steven 配好 Vercel 两变量并 Redeploy 后）**：无凭证 → `401 unauthorized`；正确 secret → **200**（`usersTotal=1`、`usersSynced=1`、`coursesSynced=3`、tasks 全 0 幂等，真实数据无丢失）。**8 个测试 auth 号已由 Steven 删除干净。**
> ~~migration 补档~~ **2026-09-05 核实推翻**：`sync_runs` / `courses` 同步列 / `canvas_credentials` 全部在 `20260902003000_initial_schema.sql` 里，schema 一直是版本化的（此前结论源于 09-04 诊断时无 service role 读不到生产 DB 的误判）。

> ✅ **P0-2-5 已验收通过（2026-09-04 13:44，Steven 生产验收）**：`POST /api/v1/sync/now`（契约 §6）+ `lib/sync/canvas-sync.ts`（编排：串行 / 重试 / 熔断 / 状态落库）+ `lib/sync/canvas-tasks.ts`（落库：去重 / 增量更新 / 软删除 + 恢复）+ `lib/sync/runs.ts`（`sync_runs` 映射）+ `lib/canvas/assignments.ts`（作业端点与映射）+ `canvasGet` 加 `Link` 翻页能力；`POST canvas-link` 成功后**接上了按课程触发同步**（P0-2-4 刻意留的口子）。
> - **验收方式**：Steven 在 Chem 1A 详情页「解除关联 → 重新关联」，后端立刻按课触发同步 → 作业落库 → 总览卡片出现（CHEM 1A 5 条近 7 天任务）。**坐实了根因**：Chem 1A 是在旧版（canvas-link 未接同步的 P0-2-4）关联的，那次关联不触发同步，之后重登/刷新也从不触发（自动同步是 P0-2-6 的事）→ tasks 表一直空 → 卡片「近期没有待办」。**Math 53 LEC/DIS 都是 0 条作业，「近期没有待办」是正确状态。**
> - **Steven 拍板的三件事**：① **无 due date 的作业照样同步，落库为 TBD**（实测 CHEM 1A 25 条里 9 条无日期：考勤打卡 + 4 个考试）；② **关联成功后立刻触发一次该课程的同步**；③ **跳过 `upcoming_events` 主扫描**，只走逐课 `assignments`。
> - **真实数据实测**：CHEM 1A 25 条 / PHYSICS 7A 6 条 / MATH 53 LEC **0 条**（空课程不是失败态）；一趟同步三门课串行耗时 6.0 秒。
> - **自测 80/80**（本地 52 + 多课程 28）：重复同步 created/updated/deleted 全 0；人为改坏标题 + 日期 + 标记完成后同步 → 标题与日期被改回、**`status=done` 没被覆盖**；幽灵作业 → 软删除且可恢复；假 token → 课程 failed + 凭证置 error + 再次调用 401；一门课失败 → 整批 `partial` 且其他课仍 success。
> - ⏸ **P0-2-6 接手的东西**：手动刷新按钮 / 打开应用自动同步（`app_open`）/ 定时兜底 `/sync/scheduled`（编排函数已支持 `trigger` 与 `App_open` 节流常量，只差触发入口）。
>

> ✅ **P0-2-4 已验收通过（2026-09-04 11:36，Steven 浏览器验收）· 勿重做**：`POST`/`DELETE /api/v1/courses/:id/canvas-link` + `components/courses/canvas-link.tsx`（详情页关联控件：已关联态 / 选择列表 / 解除二次确认）+ `components/courses/canvas-connect-form.tsx`（未连接时内嵌 token 连接表单）+ `lib/canvas/group-courses.ts`（教学课 / 其他分组）。**接线位置：详情页 `/courses/[id]`「Canvas 关联」区块**（P0-1-8 拍板的「一门课的全部操作集中在详情页」）。
> - **Steven 已拍板的噪音课策略**（P0-2-3 收尾）：教学课正常列 + 其他项单独一组带提示「这些看起来不像课程（入学 / 培训类），需要的话也可以关联」，**用户主动点才关联** —— 不静默过滤、不混排。
> - **真实数据分组结果（13 门）**：教学课 **6 门**（CHEM 1A / Chem 1AL / R4A / MATH 53-DIS / MATH 53-LEC / PHYSICS 7A）+ 其他 **7 门**（GBO-FL26 / GBA-FL26-ENROLLMENT COURSE / GBA:GBP-INTL-FL26 / HazingPrev-FL26 / GBA:L&S-FYR-FL26(A) / PartySafe-AOD-FL26 / SHAPE Student Training），**与 Steven 的描述完全一致**。
> - 🔴 **分组规则里「空格是必需的」**：入学类模块叫 `GBO-FL26` —— 学期限定符 FL26 贴着字母写。课程代码正则若允许可选空格，`FL26` 会命中「字母+数字」→ 入学模块被判成教学课，分组白做。真实课程代码（`CHEM 1A` / `MATH 53`）字母与数字之间都有空格。
> - **三个实现期决策**：① 重复提交同一 ID → **200 幂等**（不是契约原文的 409）；② 关联**不触发**同步（P0-2-5）；③ 解除关联**不动** `last_synced_at` / `sync_status` / `sync_error`（真实历史，且此刻无 canvas 任务）。详见 `API-Contract.md` §6 与变更记录。
> - **「关联」按钮不预拉课程列表**：拉列表要打一次 Canvas（走限流额度），用户可能只是打开详情页看看。代价是已关联的课在未点开前只显示 Canvas 课程 ID —— 刻意取舍，点「更改」即显示课名。
> - ✅ **Steven 浏览器验收（2026-09-04 11:36，生产环境）**：输入 PAT 后 13 门课全部抓出、教学课 / 其他分组符合预期、关联与解除关联均正常；5 个 `p024-*` 测试 auth 账号已由 Steven 手动删除。**本卡收口，勿重做**。

> ✅ **P0-2-3 已验收（2026-09-04，Steven 生产验收）**：`GET /api/v1/canvas/courses`（代理拉课程列表）+ `lib/canvas/courses.ts`（忠实映射 CanvasCourse，不筛选学期）。复用 P0-2-2 的 `canvasGet` / `loadDecryptedCredential`。
> - **真实数据实测**（Steven CANVAS_PAT）：13 门 active 课，其中 **6 门 Fall 2026**（CHEM 1A / Chem 1AL / R4A / MATH 53-LEC / MATH 53-DIS / PHYSICS 7A），**其余 7 门是入学流程/培训类**（term = "Default Term"/"Projects"：GBO / PartySafe / Hazing / SHAPE 等）—— **✅ Steven 拍板（2026-09-04）**：P0-2-4 关联 UI 用「提示 + 询问用户是否拉进 Tempo」呈现，不静默过滤也不混排。代理层忠实返回不筛选。
> - **两个实现期决策**：① `name` 用 Canvas `course_code`（非完整课名）—— 关联 UI 需区分同名 LEC/DIS（Math 53 分两个 id）；② Canvas 上游故障（5xx/超时/网络/坏 JSON）→ **502 `upstream_error`**，不伪装成 Tempo 自己的 500（契约 §1.4 + §6 已补）。
> - **范围收敛**（Steven 拍板）：任务名虽写「拉课程 + 作业」，本卡**只做课程列表**（契约 §6 唯一端点）；作业拉取签名留到 P0-2-5 按同步真实需求再定，避免本卡写死代码无处验收。
> - **错误映射**：未登录 401 `unauthenticated` ｜ 无凭据 404 `not_found` ｜ Canvas 拒 token 401 `credential_invalid` ｜ 限流 429 `rate_limited`。
> - **自测**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅（`/api/v1/canvas/courses` 已进路由表）｜ **本地冒烟 17/17**：401 未登录 ｜ 404 无凭据 ｜ 真实 PAT 存库 → GET 200 返 13 门（Fall 2026 ≥6、MATH 53 两次 LEC+DIS、每项含 externalId/name/term）｜ 伪造 token → 401 `credential_invalid` ｜ POST/GET 响应无 token 泄漏 ｜ x-request-id 回传。
> - **验收 & 交接完成**：本卡**无 UI**，Steven 生产验收 = 登录生产打 `GET /api/v1/canvas/courses`（未存凭据账号返 404 `not_found`，证明路由/鉴权/契约链路通）。**Vercel 已配 `CANVAS_TOKEN_ENCRYPTION_KEY` 并 Redeploy**（P0-2-2 交接点收口）。本地测试账号 `p023-a/b-*@example.com` ×2 已由 Steven 删除。

> ✅ **P0-2-2 已验收（2026-09-04 10:14，Steven 验收）**：AES-256-GCM 加密 + `POST/GET /api/v1/canvas/credentials` + `lib/canvas/client.ts` 请求封装。63/63 自测全绿（冒烟 42 + 集成 8 + crypto 负向 13）。
> - **Steven 侧两个交接点 ✅ 全部 2026-09-04 实测收口**：① Vercel 加环境变量 `CANVAS_TOKEN_ENCRYPTION_KEY`（值与本机 `.env.local` 同） + 手动 Redeploy；② 迁移 `20260904100000_canvas_credentials_constraints.sql` **早在生产就位** —— Steven 重复执行遇 `42P07 already exists`，用 `information_schema` 验证 `expires_at` 已是 `NOT NULL` 且 `canvas_credentials_user_id_key` UNIQUE 约束存在。
> - **本卡无 UI**，验收靠 API 证据 + 数据库直查，无需浏览器点击 —— 数据库验证方式：用自己账号的 access_token 直查 `canvas_credentials.secret_encrypted`，应看到 `v1:...` 四段密文。
> - 顺带产出：P0-2-1b 实测结论已统一进 6 份文档（token 过期上限 **90 天**、强制必填）；**O-07 查清**（bCourses 确实返回 `x-rate-limit-remaining`）。

> ✅ **P0-1-10 已验收通过（2026-09-04 09:18，Steven 浏览器验收）**：点「先看看效果」成功产生 CHEM 1A 示例课程。**P0-1-9 + P0-1-10 双收口，M1 静态理解 + Demo Workspace 冷启动全部完成**。
> - 期间修复一个生产 500（commit `0f922c3`）：删 auth 测试账号会经 `profiles.auth.users` 外键 **ON DELETE CASCADE** 连带删掉该 user 的 profiles 行，但浏览器 session 仍有效 → seed/course-create 写库时外键违反 500。新增 `lib/profiles.ts` 的 `ensureProfile()`（幂等 upsert），在 `demo/seed` / `demo` / `courses` POST 三个 handler 顶部调用兜底。本地复现（删 profile → seed 原 500、修后 201）验证通过。
> - ⚠️ **清理遗留测试 auth 账号时注意**：Dashboard 删 `@example.com` 测试号若删到你当前登录的账号，会连带清 profile（现已自动兜底重建，但会造成困惑）。调试遗留号：`debug-seed-*` ×2、`orphan-profile-*` ×1、`ui-check-*` ×1（均 `@example.com`），待下次清理。
>
> ✅ **P0-1-9 已验收通过（2026-09-03 16:10，Steven 浏览器验收）**：三个端点/UI 全部通过，测试账号已由 Steven 删除。**M1 静态理解链路完整收口**（上传 → 提取 → 解析 → 落库 → 编辑 → 展示 → 总览 → 标记完成）。commit `8022643`/`1b4864c`/`f5065b7`/`777712c`，Vercel 部署 `1b4864c` success。
>
> ✅ **P0-1-10 实现完成（2026-09-03，Bud）**：Demo 数据源 = Steven 提供的真实 syllabus `Syllabus 2.pdf`（CHEM 1A Fall 2026，选项 A）。五板块由 `lib/parse` 真实解析结果固化进 `lib/demo/seed-data.ts`（非手写），seed 端点复用 `persistParsedSections` 落库 + `syncExamToTask` 派生考试任务（与正常上传解析同一套落库逻辑）。无 LLM 实时调用。冒烟 14/14 + SSR 渲染验证通过。
> - **Steven 拍板两处留空**：① `courseOutline` 留空（真实 syllabus 用 L1–L40 讲座编号，解析器 prompt 未覆盖该格式、稳定漏抽，已记 bug 归 P0 期后改进卡）；② `officeHours` 留空（原文只写 "see calendar on bCourses"，模型正确返回空）。
> - ⚠️ **遗留真 bug（非本卡范围）**：courseOutline 对 L 编号课表稳定漏抽，是解析器 prompt 缺陷，真实用户传同类 syllabus 也会丢课表 → 建议开 P0 期后改进卡（修 prompt + 加回归样例）。
> - 演示课程**不建 syllabi 行**（`file_url`/`file_name` 为 NOT NULL，避免悬挂 Storage 对象 + 失效下载链接）；卡片显示「还没有 syllabus」属预期。
> - 🔜 **下一张卡**：M2 动态感知（Canvas 同步），入口 `P0-2-1` 已 ✅，待 Steven 定 P0-2 序列开工。

> 🛑 **本轮收工状态（2026-09-04 09:18，Steven 收工）**：**P0-1-10 验收通过 ✅ → 冷启动闭环完成，M2 待开工**。Steven 在新会话点「先看看效果」成功产生 CHEM 1A 示例课程，P0-1-10 浏览器验收通过。期间修复生产 500（`ensureProfile` 兜底，commit `0f922c3`，见上）。**下一张卡 = M2 动态感知（P0-2 Canvas 同步），入口 P0-2-1 已 ✅**，Steven 将在新会话定 P0-2 序列开工。调试遗留测试号 `debug-seed-*` ×2 / `orphan-profile-*` ×1 / `ui-check-*` ×1（`@example.com`）**✅ 已由 Steven 在 Supabase Dashboard 删除（2026-09-04 截图确认：生产 Authentication → Users 只剩 stevenli2007@berkeley.edu）**。

> 🛑 **历史存档 · 勿据此行动（2026-09-03 16:12，Steven 收工）**：**P0-1-9 验收通过 ✅ → M1 静态理解链路完整收口**。本轮 Bud 两次按 `CodingRules.md` §5 在模糊指令「Please continue.」处停下确认（未越界开工）。下一张卡 **P0-1-10 Demo Workspace**，Steven 将在**新会话**开工，开工前需先定示例数据来源（A 真实公开 syllabus / B 合成示例）。
> - ✅ **测试账号已全部清理（2026-09-03 16:10，Steven 手动删）**：`p19-a/b@test.dev`（本地）+ `p19-prod-a/b@test.dev`（生产）已从 auth.users 移除。**auth.users 现在无测试残留**。
> - 工作区干净（无 `.tmp-*` 残留），`origin/main` 已同步到 `777712c`。

> 📌 **P0-1-5b 已验收通过 ✅（2026-09-03 11:50，Steven 验收）**：5 个 `PUT /api/v1/courses/:id/{板块}` 端点 + `lib/parse/save.ts`（编排）+ `lib/parse/corrections.ts`（字段级 diff + 归因）+ `lib/sync/exam-tasks.ts`（`syncExamToTask()`）+ `persist.ts` 接入派生。本地冒烟 **56/56**、生产验证 **18/18**（真实 `/parse` 归因、`llm_run_id`/`syllabus_id` 非 null 且真实存在）。commit `638a331`/`a959d45`/`54590cd`。
> - **实现期决策（已写进 `API-Contract.md` §4 变更记录，无需 ADR）**：① request 不含 `status`（由 examDate 派生）；② 修正粒度 = 字段级（add/delete 也按字段拆，`order_index` 除外）；③ 归档课程保存 → 404；④ 归因取「最新 syllabus 最近一次成功解析」。
> - ~~**留白**：测试账号待删~~ ✅ **已于 2026-09-03 11:58 由 Steven 删除**。
>
> 📌 **P0-1-6 已验收通过 ✅（2026-09-03 11:50，Steven 浏览器验收）**：`lib/sections.ts`（服务端直查五表）+ `components/sections/`（编辑器 + 五个表单 + 共用 hook）+ `syllabus-upload.tsx` 补解析触发（开始 / 重试 / 重新解析带二次确认）。无头冒烟 17/17。commit `953658a`/`515807c`。
> - **两个 Steven 拍板**：① 编辑 UI 放**课程卡片内折叠面板**（不新增路由）—— ⚠️ 此决策已被 P0-1-8 推翻，编辑器现居详情页；② **「重新解析」带上、带二次确认**。
> - ~~**留白**：测试账号待删~~ ✅ **已于 2026-09-03 11:58 由 Steven 删除**。
>
> 📌 **P0-1-8 已验收通过 ✅（2026-09-03 11:50，Steven 浏览器验收）**：`GET /api/v1/courses/:id`（契约 §2，合成大对象）+ `lib/course-detail.ts`（读逻辑唯一一份，端点与页面共用）+ `app/(routes)/courses/[id]/page.tsx` + `components/sections/section-view.tsx`（TBD 展示层）+ SectionEditor 双模式 + 卡片瘦身。无头冒烟 34/34。commit `1796d56`/`3331b06`。
> - **两个 Steven 拍板**：① **全部操作搬到详情页**（上传 / 解析 / 五板块编辑 / 课程信息编辑），卡片只留摘要 + 入口 + 删除；② 路由 `/courses/[id]`（列表页仍在 `/dashboard`）。
> - **契约收敛（§2）**：`syllabus` 返回**完整 Syllabus 对象**（超集，UI 需要 `extractStatus` / `parseError`）；已归档课程按 404 处理。
> - **顺手解决**：P0-1-6 留下的「dashboard 一次性加载所有课程五板块」开销随卡片瘦身一起消失。
> - ⚠️ **1-6 与 1-8 的验收是同一次会话** —— 1-8 把编辑器从卡片搬到详情页后，1-6 的验收标准（改任一字段并保存 / TBD 展示与编辑）在详情页上验。
> - ~~**留白**：测试账号待删~~ ✅ **已于 2026-09-03 11:58 由 Steven 删除**。

> 📌 **P0-1-5a 已验收通过 ✅（2026-09-03，Steven 验收；测试账号已清理）**。代码 commit `bcd5a20` + 文档 commit（生产验证 14/14 + §10 部署延迟条目），均已 push。本地冒烟 44/44、生产验证 14/14（真实调 DeepSeek 4.4s、`llm_runs` 落 5 条 success）。

> ✅ **P0-1-9 开工提示（2026-09-03 已执行完毕，以下为留档）**：总览页要「每门课近期 1-2 个任务 + 跨课程近期任务列表（按日期排序，仅 syllabus 数据）」。**两个端点已新建、`upcomingTasks` 已补、卡片与 dashboard 已接线**，当前状态是代码完成待浏览器验收。
> - **数据**：考试派生 task 由 `syncExamToTask()` 写入（ADR-004）；**读它的两个端点此前不存在，本卡新建**。
> - **契约**：`GET /api/v1/tasks?range=7d&limit=50&offset=0`（§5）、`PATCH /api/v1/tasks/:id`（§5）。
> - **卡片**：`upcomingTasks`（§2 列表响应字段）已补上 —— **此前确实没返回**，不是"已实现"。
> - **范围边界**：仅 syllabus 数据 —— **未做**手动任务的新增 / 删除（§5 的 `POST` / `DELETE` 不在本卡）。
>
> ✅ **两个产品问题拍板结论（2026-09-03 11:58，Steven）—— 已按此实现**：
> ① **包含「标记任务完成」** → `PATCH /api/v1/tasks/:id`，**只允许改 `status`**；`isDerived = true` 的任务传 `title` / `dueDate` → `422 derived_task_immutable`，错误信息引导去课程页改 `exam_dates`（ADR-004 在接口层的强制点）。
> ② **已完成的任务：横线划掉 + 折叠起来**（不是隐藏，也不是置灰混排）。

> 🛑 **历史存档 · 上一轮收工状态（2026-09-03 12:00，Steven 收工）—— 已被上方「本轮收工状态」取代，仅留档勿据此行动**：**P0-1-5b / P0-1-6 / P0-1-8 已验收通过 ✅**。M1 静态理解链路（syllabus 上传 → 提取 → 解析 → 落库 → 编辑 → 展示）全部打通，下一 task 为 **P0-1-9 总览页 v1**。
> - ⚠️ **本轮发生过一次越界**：Steven 的停止指令是 P0-1-5b，Bud 收到模糊的「continue」后一路做到 P0-1-8。已写进协作约定 —— **Done Report 之后的模糊指令一律回读原始停止点**。
> - ✅ **测试账号已清理（2026-09-03 11:58，Steven 手动删除）**：8 个 `p15b-*` / `p16-*` / `p18-*` `@test.dev` 账号全部从 auth.users 移除。
> - 🔜 **P0-1-9 的两个阻塞问题已拍板**（① 包含「标记完成」② 已完成划掉 + 折叠），**但 Bud 未开工** —— Steven 未下达开工指令。
>
> 🛑 **更早一轮（2026-09-02 23:00，Steven 收工）**：P0-1-4 已验收通过。
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

