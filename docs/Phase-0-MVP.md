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

**当前 task**：`P0-2-6` 刷新机制 **第一拍（T1 打开应用自动同步 + T2 手动同步按钮）—— 🔵 代码完成 / 自测通过（2026-09-05），待 Steven 验收**。执行卡见 [P0-2-6](#-p0-2-6--刷新机制第一拍t1-打开应用自动同步--t2-手动同步按钮代码完成-2026-09-05-待-steven-验收)。

> ✅ **第一拍已验收通过（2026-09-05，Steven）**：① `/sync/now` 支持可选 body `{trigger: 'manual' | 'app_open'}`（双档节流 30s/60s，服务端权威；`scheduled`/非法值 → 400）；② `components/sync/sync-controls.tsx`（挂载 + `visibilitychange` 自动同步、手动「同步 Canvas」按钮，无关联课程不渲染不触发）；③ dashboard 接线。自测 tsc/lint/build ✅ + 冒烟 18/18。执行卡见 [P0-2-6 第一拍](#-p0-2-6--刷新机制第一拍t1-打开应用自动同步--t2-手动同步按钮代码完成-2026-09-05-待-steven-验收)。
> 🔜 **第二拍（T3 平台定时兜底）代码完成 / 自测 18/18（2026-09-05），待 Steven 验收**：`GET|POST /api/v1/sync/scheduled`（CRON_SECRET 恒定时间比较 + fail closed）+ `lib/sync/scheduled.ts`（串行逐用户、聚合统计、240s 预算）+ `lib/supabase/admin.ts`（service role 唯一入口）+ `vercel.json` 两条 cron。**同步层四处查询补强制 `userId` 过滤**（service role 绕过 RLS，靠隐式隔离会跨用户串数据）。**⚠️ 完整链路（真 service role 跑一遍）尚未自测** —— 等 Steven 把 `SUPABASE_SERVICE_ROLE_KEY` 配进 `.env.local`。
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
| **P0-1-5** | 解析 API 路由 + 结果落库 + **修正 diff 存储**（保存原始解析 vs 修正后 + 差异字段） | Bud | P0-1-2, P0-1-4 | 数据库同时存有原始与修正版本，可追溯差异 | ✅ 5a + 5b 均已验收（2026-09-03） |
| **P0-1-6** | 可编辑表单 UI：五个板块逐项编辑 / 补全 / 覆盖 + 保存 | Bud | P0-1-5 | 可修改任一字段并保存；TBD 状态可正常展示与编辑 | ✅ 已验收（2026-09-03；验收点在详情页，见 P0-1-8） |
| **P0-1-7** | Workspace CRUD：创建（学期 + 课程名必填，编码/教师选填）、列表按学期分组、编辑、删除 | Bud | P0-0-6 | 建课后出现在总览页与列表；删除有二次确认 | ✅ |
| **P0-1-8** | 课程详情页：展示五板块最终信息 | Bud | P0-1-6, P0-1-7 | 保存后的数据完整展示；缺失项显示 TBD 而非空白 | ✅ 已验收（2026-09-03 11:50） |
| **P0-1-9** | 总览页 v1：课程卡片（显示近期 1-2 个任务）+ 跨课程近期任务列表（仅 syllabus 数据，按日期排序） | Bud | P0-1-8 | 能看到"最近 7 天所有课程要做的事"；可跳转课程详情 | ✅ **2026-09-03 验收通过**（本地 64/64 + 生产 26/26）。**M1 收口** |
| **P0-1-10** | 冷启动：**Demo Workspace**（预置示例课程，含已解析 syllabus 与示例任务） | Bud | P0-1-9 | 新用户从进入站点到看到有内容的总览页 ≤ 30 秒 | ✅ **2026-09-04 验收通过**（Steven 浏览器：点「先看看效果」产生 CHEM 1A 示例） |
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

#### 🎫 P0-1-5b · 五板块保存端点 + 修正 diff + 考试派生 · ✅ **已验收通过（2026-09-03 11:50）· 勿重做**
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
- **已知留白**：无跨表事务（与 5a 同），插/改/删 + 修正 + 派生分步执行，中途 500 重试自愈（已确认可接受）。测试账号已于 2026-09-03 11:58 由 Steven 删除。

#### 🎫 P0-1-6 · 五板块编辑 UI · ✅ **已验收通过（2026-09-03 11:50）· 勿重做**
- **做什么**：课程卡片内的五板块折叠编辑器（五个 tab）+ 上传流程缺失的第 5 拍「解析」触发。
- **改哪些文件**：
  - `lib/sections.ts`（新）—— `loadCourseSections()`：服务端直查五张表（每张表一个 `in` 查询，无 N+1），返回 `Map<courseId, StoredSections>`。
  - `components/sections/shared.tsx`（新）—— `useSectionForm()` 状态机 + `SectionFooter` / `ManualBadge` / `TbdBadge`。
  - `components/sections/{grade-components,outline-items,exam-dates,office-hours,submission-policies}-form.tsx`（新）—— 五个表单。
  - `components/sections/section-editor.tsx`（新）—— 折叠面板 + 五个 tab。
  - `components/courses/syllabus-upload.tsx` —— 加 `开始解析 / 重试解析 / 重新解析`。
  - `components/courses/course-card.tsx`、`app/(routes)/dashboard/page.tsx` —— 接线 + 加载失败降级横幅。
- **🔴 关键约束（改动前必读）**：
  1. **五板块没有读取端点**（契约 §4 只有 PUT，`GET /courses/:id` 归 P0-1-8）→ 表单初值走 **dashboard 服务端直查**（与 `loadLatestSyllabi` 同模式），**不是**新增 GET 端点。
  2. **draft 里的 `_` 前缀字段是客户端专用元数据**（`_source` / `_sourceExcerpt`，用于「手动」标记和原文摘录 tooltip），提交前由 `stripRowMeta()` 剥掉 —— 服务端校验器永远只看到契约里的字段。
  3. **服务端数据变了靠 `key` 重挂载同步，不在 effect 里 setState**：`SectionEditor` 给每个表单 `key = JSON.stringify(该板块)`。React 官方的「用 key 重置状态」模式；effect 里同步会被 `react-hooks/set-state-in-effect` 拦下，且 props 每次渲染都是新数组，靠身份判断会天天重置。代价：服务端数据变化时（重新解析 / 别处刷新）**未保存的编辑会丢** —— 重新解析有二次确认且文案写明了这点。
  4. **保存成功后用响应里的 `data` 重建 draft**（新行拿到 id），否则第二次保存会把新行当 insert，造出重复。
  5. `ExamDate.status` 不在表单里（服务端由 `examDate` 派生）；考试行无日期 → 显示 `TBD` chip，date input 留空即可。
  6. 大纲的 `orderIndex` 由数组位置派生，上移/下移直接操作数组，不进 diff（重排序不算解析错误）。
- **自测（Bud，2026-09-03）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅ ｜ 无头冒烟 **17/17**（dashboard SSR 带板块数据、跨用户隔离、PUT 回包结构、清理）。
- **✅ Steven 验收（2026-09-03 11:50，在 P0-1-8 详情页上验）**：展开 / 切 tab / 打字 / 保存 / 上移下移 / 解析按钮全部通过。测试账号已删。
- **剩余留白**（已确认可接受）：① dashboard 一次性加载所有课程的五板块 —— **已随 P0-1-8 卡片瘦身消失**；② 解析触发是同步等待（约 3-5 秒），过程动画归 P0-1-11。

#### 🎫 P0-1-10 · Demo Workspace（冷启动）· ✅ **已验收通过（2026-09-04 09:18，Steven 浏览器验收）· 勿重做**
- **做什么**：新用户一键生成预置示例课程（含已解析 syllabus 与示例任务），标记 `is_demo=true`；可一键清空。让"从进入站点到看到有内容的总览页 ≤ 30 秒"。
- **数据源（Steven 拍板选项 A）**：`Syllabus 2.pdf` = CHEM 1A Fall 2026（Berkeley Dr. Debjani Roy & Dr. Alexis Shusterman），**真实公开 syllabus**。五板块由 `lib/parse` 真实解析结果固化进 `lib/demo/seed-data.ts`（非手写），每条 `sourceExcerpt` 是逐字摘录，抗幻觉不破。
- **改哪些文件**：
  - `lib/demo/seed-data.ts`（新）—— `DEMO_COURSE` + `DEMO_SEED_SECTIONS`（真实解析固化）+ `toDemoSectionsResult()`（包成 `persistParsedSections` 入参形状）
  - `app/api/v1/demo/seed/route.ts`（新）—— `POST`：查重 → 建 `is_demo` 课程 → 复用 `persistParsedSections` 落库 + 派生 exam tasks → 写 `profiles.demo_seeded_at`；失败尽力回滚课程；重复 → `409 already_linked`
  - `app/api/v1/demo/route.ts`（新）—— `DELETE`：删 `is_demo` 课程（级联清五板块 + 派生 tasks）→ 复位 `demo_seeded_at`；无 demo → `200 {deleted:0}`（幂等）
  - `components/courses/demo-controls.tsx`（新）—— 客户端控件：空状态「先看看效果」CTA + 「清空示例数据」小按钮
  - `components/courses/course-card.tsx` —— `isDemo` 时显示「示例」badge
  - `app/(routes)/dashboard/page.tsx` —— 接管 `DemoControls`（`hasDemo` 决定 CTA / 清空按钮）+ 空状态入口
- **🔴 关键约束（改动前必读）**：
  1. **seed 端点不调 LLM**：直接用固化常量 + 复用 `persistParsedSections`，与正常上传解析同一套落库/派生逻辑（单一事实源）。运行时零 LLM 依赖。
  2. **`courseOutline` 与 `officeHours` 按 Steven 拍板留空**：前者是解析器对 L1–L40 讲座编号课表稳定漏抽的真 bug（归 P0 期后改进卡）；后者原文无具体时间，模型正确返回空。
  3. **演示课程不建 syllabi 行**：`syllabi.file_url`/`file_name` 为 NOT NULL，建行必指向 Storage 对象，否则卡片下载入口 404。无 syllabi 行时卡片显示「还没有 syllabus」属预期。
  4. **删 demo 课程靠 `ON DELETE CASCADE`**：五板块 + 派生的 tasks 全对 `courses` 设了级联；`courses` 是 `for all` RLS 策略，`DELETE` 放行，只能删自己的。
- **自测（Bud，2026-09-03）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅ ｜ 冒烟 **14/14**（seed 201 + isDemo、重复 409、五板块落库 + 派生 4 条 exam 任务、卡片近期任务含考试、跨用户隔离、delete 级联清子数据 + 幂等）+ dashboard SSR 渲染验证（课程名 / 「示例」badge / 派生考试均渲染；已 seed 后「先看看效果」入口不出现）。
- **修复（Bud，2026-09-03，commit `0f922c3`）**：生产点「先看看效果」报 500 —— 根因是删 auth 测试账号经 `profiles.auth.users` 外键 **ON DELETE CASCADE** 连带删掉该 user 的 profiles 行（browser session 仍有效），写 `profiles.demo_seeded_at` 撞外键违反。新增 `lib/profiles.ts` `ensureProfile()` 幂等 upsert 兜底，在 `demo/seed` / `demo` / `courses` POST handler 顶部调用。本地复现（删 profile → seed 原 500、修后 201）✅。
- **✅ Steven 验收（2026-09-04 09:18，Steven 浏览器验收）**：点「先看看效果」成功产生 CHEM 1A 示例课程。**P0-1-10 验收通过 · 勿重做**。
- **⚠️ 清理遗留测试 auth 账号时注意**：Dashboard 删 `@example.com` 测试号若删到当前登录账号，会连带清 profile（现已自动兜底重建）。调试遗留号 `debug-seed-*` ×2、`orphan-profile-*` ×1、`ui-check-*` ×1 **✅ 已由 Steven 删除（2026-09-04 确认）**。
- **🔜 下一张卡**：M2 动态感知（Canvas 同步），入口 `P0-2-1` 已 ✅，待 Steven 在新会话定 P0-2 序列开工。

#### 🎫 P0-1-9 · 总览页 v1 · ✅ **已验收通过（2026-09-03 16:10，Steven 浏览器验收）· 勿重做**
- **做什么**：跨课程近期任务列表（按日期排序）+ 卡片近期 1-2 个任务 + 「标记完成」。**这是 M1 的最后一张卡**，做完 M1 静态理解链路完整收口。
- **改哪些文件**：
  - `types/task.ts`（新）—— `Task` / `UpcomingTask` + 三个枚举收窄
  - `lib/tasks.ts`（新）—— `TaskRow` + `TASK_COLUMNS`（唯一知道 DB 列名的地方）、`toTask()`、`loadActiveCourseIds()` / `loadTasks()` / `loadUpcomingTasks()` / `loadTaskById()`
  - `app/api/v1/tasks/route.ts`（新）—— `GET`（契约 §5）
  - `app/api/v1/tasks/[id]/route.ts`（新）—— `PATCH`（契约 §5，只允许改 status）
  - `components/tasks/task-list.tsx`（新）—— 任务列表（标记完成 + 已完成折叠）
  - `types/course.ts` —— `Course` 加**可选** `upcomingTasks`
  - `app/api/v1/courses/route.ts` —— 列表响应补 `upcomingTasks`（契约 §2 早有此字段但一直没返回）
  - `components/courses/course-card.tsx` —— 新增 `UpcomingTaskView`（视图模型，日期已格式化）+ 卡片显示近期任务
  - `app/(routes)/dashboard/page.tsx` —— 加载任务数据 + 「最近要做的事」区块 + 日期格式化
- **🔴 关键约束（改动前必读）**：
  1. **`tasks` 表没有 `user_id`，且它的 RLS 策略不看 `is_archived`** —— 所有查询都必须先取「当前用户未归档的课程 id」（`loadActiveCourseIds()`）再用 `.in('course_id', …)` 收口，否则归档课程的任务会漏进总览页。
  2. **`dueDate` 为 null 的行必须显式保留**：`.lte('due_date', X)` 在 SQL 里对 NULL 求值为 NULL（不成立），TBD 任务会整批消失。用 `or('due_date.lte."X",due_date.is.null')`（值含 `:` `+`，要双引号包住）。
  3. **不要把 PostgREST 的查询构造器抽成带泛型的公共函数**（本次 `applyTaskOrder()` 直接触发 `TS2589: Type instantiation is excessively deep`）。排序那两行在两个查询里各写一份，比绕类型便宜得多。
  4. **日期在服务端按 UTC 格式化成 label 再传给客户端组件** —— 客户端 `toLocaleDateString()` 会让服务端（UTC）与浏览器（用户时区）渲染不一致 → hydration mismatch。
  5. **`upcomingTasks` 字段可缺，不可假**：查失败时不填这个字段（`undefined` → 卡片显示「加载失败」），**绝不填 `[]`**。同理 `meta` 不返回 `staleWarning` / `lastSuccessfulSyncAt`（Canvas 同步状态，Phase 0 无同步，硬编码 false 是静默的错误数据）。
  6. **「已完成」= 折叠 + 删除线，不是隐藏**：GET 照常返回 `status=done` 的任务。折叠用条件渲染，收起时条目不在 DOM 里（因此 SSR HTML 里没有 `line-through`，这是对的）。
- **三个 P0-1-9 的实现期决策（已写进 `API-Contract.md` §5 变更记录，无需 ADR）**：
  1. **`range` 只设上界，不设下界** —— 逾期未完成的必须留在列表里（藏起来 = 帮用户逃避）。
  2. **PATCH 两类拒绝分开**：派生任务传 `title`/`dueDate` → `422 derived_task_immutable`（ADR-004 接口层强制点，错误信息引导去课程页）；非派生任务传 → `400 validation_failed`（本阶段不支持，**明确拒绝而非静默忽略**）。
  3. **`POST` / `DELETE`（手动任务）明确不做** —— P0-1-9 范围是「仅 syllabus 数据」。
- **自测（Bud，2026-09-03）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅（`/api/v1/tasks`、`/api/v1/tasks/[id]` 均为 ƒ 动态路由）｜ 无头冒烟 **64/64**。
  覆盖：7d 窗口内/外、逾期保留、TBD 保留、排序（升序 + null 最后）、`range` 五种取值（含 3 条非法 → 400）、分页（limit/offset/total 独立）、`x-request-id` 回传、跨用户隔离、`upcomingTasks`（最多 2 条 / 只含未完成 / 排除已完成）、PATCH 标记完成与取消、派生任务 422（含 code / message / `details.immutableFields`）、非派生任务 400、**7 条入参与越权路径**、归档课程任务消失、dashboard SSR、清理。
- **自测（Bud，2026-09-03）—— 生产验证补充**：Vercel 部署 `1b4864c` success，**生产冒烟 26/26**（端点已部署、range 窗口与排序、分页、跨用户隔离、`upcomingTasks`、PATCH 标记完成与 422、越权 404、`x-request-id`、dashboard SSR、数据清理）。
- **Steven 验收（2026-09-03 16:10）**：✅ 浏览器交互三项全通过 —— ① 勾 checkbox 标记完成 → 列表刷新；② 展开「已完成 N 项」→ 看到删除线；③ 卡片显示近期任务。测试账号已由 Steven 删除，**本卡无待办**。
- **剩余留白**（已确认可接受，非阻塞）：① 手动任务的新增/删除未做（本卡范围外，契约 §5 的 `POST` / `DELETE`）；② 逾期任务只标红显示，不做"顺延"逻辑（Phase 2）；③ `meta.staleWarning` / `lastSuccessfulSyncAt` 待 P0-2-7 / P0-2-11 才有真实数据。
- **🔜 下一张卡 P0-1-10（Demo Workspace）的唯一阻塞**：**示例数据来源**（真实公开 syllabus vs 合成示例），见「当前进度指针」。

#### 🎫 P0-1-8 · 课程详情页 · ✅ **已验收通过（2026-09-03 11:50）· 勿重做**
- **做什么**：`/courses/[id]` 展示课程 + 五板块最终信息（缺失项显示 TBD），并把一门课的全部操作集中到这里。
- **改哪些文件**：
  - `lib/course-detail.ts`（新）—— `loadCourseDetail()`：课程 + 最新 syllabus + 五板块，一次合成。**端点与页面共用同一份读逻辑**，避免「页面一套查询、接口另一套」的漂移。
  - `app/api/v1/courses/[id]/route.ts` —— 新增 `GET`（契约 §2）。
  - `app/(routes)/courses/[id]/page.tsx`（新）—— 详情页。
  - `components/sections/section-view.tsx`（新）—— 五板块只读展示层（TBD 语义在这一层）。
  - `components/sections/section-editor.tsx` —— 加 **查看 / 编辑双模式**（P0-1-6 只有编辑）。
  - `components/courses/course-actions.tsx`（新）—— 编辑信息 / 删除（从卡片搬来，删除后跳回总览）。
  - `components/courses/course-card.tsx` —— **瘦身**：只留摘要 + 详情入口 + 删除。
  - `components/courses/syllabus-status.ts`（新）—— syllabus 一句话状态（卡片与详情页共用，抽出来防漂移）。
  - `dashboard/page.tsx` —— 去掉五板块预加载（P0-1-6 加的，随卡片瘦身一起删除）。
- **🔴 关键约束（改动前必读）**：
  1. **读逻辑必须走 `lib/course-detail.ts`**，别在页面里重写一遍查询。页面直查 DB（RLS 保护），**不 fetch 自己的 API**（省一次往返）。
  2. **归档 = 删除**：归档课程的详情返回 404（`is_archived = false` 过滤），与 §4 保存端点语义一致。
  3. **缺失项返回 `[]` 不是 `null`**（契约 §2 原文）；**展示层必须把 null 值渲染成 TBD**（验收标准原文：缺失项显示 TBD 而非空白）—— 空白会让用户分不清「syllabus 没写」和「还没解析」。
  4. **列表页在 `/dashboard`，详情页在 `/courses/[id]`** —— 不新增 `/courses` 列表路由（P0-1-7 定的）。
- **自测（Bud，2026-09-03）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅（新增 `/courses/[id]` 动态路由）｜ 无头冒烟 **34/34**。
- **✅ Steven 验收（2026-09-03 11:50）**：查看/编辑切换、点卡片进详情、从详情页删除后跳回全部通过。测试账号已删。
- **剩余留白**（已确认可接受）：详情页没有 syllabus 文本预览（契约 §3 的 `previewText` 只在上传响应里，P0-1-11 再做）。

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
| **P0-2-1b** | **记录实测细节**：是否强制填写过期时间、上限天数、token 可撤销入口位置 | **Steven** | P0-2-1 | 三项信息记录在案（影响 P0-2-8 提醒逻辑的默认值） | ✅ **2026-09-04 完成**：强制必填 / 上限 **90 天** / 撤销在 Access Tokens 同页。已同步进 6 份文档（推翻原"约 120 天"） |
| **P0-2-2** | 凭据加密存储（AES）+ 服务端 Canvas 请求封装（token 绝不出现在前端响应中） | Bud | P0-2-1（可用） | DB 中凭据为密文；抓包确认前端拿不到 token | ✅ **已验收（2026-09-04 10:14）** |
| **P0-2-3** | Canvas API 客户端：拉取课程列表 + 作业列表（含 due date），含限流与错误处理 | Bud | P0-2-2 | 能正确拉取真实数据；API 报错有明确处理不崩溃 | ✅ **已验收（2026-09-04）** |
| **P0-2-4** | 课程关联 UI：手动将 Canvas 课程与 Tempo Workspace 关联（不做自动匹配） | Bud | P0-2-3 | 可选择并关联；关联后状态可见；可解除关联 | ✅ **已验收通过（2026-09-04 11:36，Steven 浏览器验收）** |
| **P0-2-5** | 首次全量同步：Canvas 作业 → `tasks` 表落库（去重 + 更新，不重复插入） | Bud | P0-2-4 | 重复同步不产生重复任务；due date 变更能更新 | ✅ **已验收（2026-09-04 13:44，Steven「效果完美」）· 勿重做** |
| **P0-2-6** | 刷新机制：**打开应用自动同步（T1，主力）** + 手动刷新按钮（T2）+ 后台定时兜底（T3，频率见 `Sync-Strategy.md`） | Bud | P0-2-5 | 打开应用/聚焦标签页自动同步（60s 节流）；手动刷新可用（30s 节流）；定时兜底按配置执行 | 🔵 **第一拍（T1+T2）✅ 已验收（2026-09-05，Steven）**；第二拍（T3）代码完成/自测 18/18，待 Steven 验收 |
| **P0-2-7** | **同步状态 UI**：显示最后同步时间 + **失败可见性**（失败时展示最后成功时间与失败原因，绝不静默展示旧数据） | Bud | P0-2-6 | 断网/token 失效时显示明确错误提示，而非旧数据 | ⚪ |
| **P0-2-8** | Token 过期提醒：基于**用户实际填写的过期时间**（非写死天数）提前提醒 | Bud | P0-2-2 | 用临近过期的测试 token 验证提醒触发 | ⚪ |
| **P0-2-9** | 撤销授权入口：一键断开 Canvas 授权 + 删除已存凭据 | Bud | P0-2-2 | 断开后凭据从库中清除；同步停止且状态正确显示 | ⚪ |
| **P0-2-10** | ~~iCal Feed 兜底（条件性）~~ | Bud | — | ⏸ **不执行**：P0-2-1 判定为可用，条件未触发。保留为长期 Plan B（[ADR-002](./Decisions.md#adr-002)） | ⏸ |
| **P0-2-11** | 总览页合并展示：syllabus 考试日期 + Canvas 作业 due date 合并排序；考试日期以 `exam_dates` 为权威源 | Bud | P0-2-5, P0-1-9 | 两类任务正确合并；**课程页与总览页日期一致**（[ADR-004](./Decisions.md#adr-004)） | ⚪ |

### P0-2 执行卡（AI 开工最小上下文）

> 与 P0-0 / P0-1 一样：领 task 时只读对应执行卡 + `TechStack.md` 第 2 节版本矩阵，不必重读全部文档。

#### 🎫 P0-2-2 · 凭据加密存储 + 服务端 Canvas 请求封装（✅ 已验收，2026-09-04 10:14）

- **做什么**：Canvas PAT 以 AES-256-GCM 密文入库；两个端点（保存 / 读元数据）；服务端请求封装（超时 + 错误分类）。**token 只进不出**。
- **改哪些文件**：
  - `lib/canvas/crypto.ts` —— `encryptSecret` / `decryptSecret`。密文格式 `v1:<iv_b64>:<tag_b64>:<ct_b64>`，**版本前缀为将来密钥轮换留口子**（换密钥时新密文用 v2，旧的仍可读，不必停机重加密全部）。
  - `types/canvas.ts` —— `CanvasCredentialMeta`（**对外唯一形状，类型层面就没有密钥字段**）、`CanvasCourse`。
  - `lib/canvas/credentials.ts` —— `canvas_credentials` 表唯一 snake_case 映射点；`loadCredentialMeta` / `loadDecryptedCredential` / `toCredentialMeta`。
  - `lib/canvas/validate.ts` —— 三项校验（域名含 **SSRF 防护** / token / 过期时间）。
  - `lib/canvas/client.ts` —— `canvasGet()`：10s 超时、错误分类、`x-rate-limit-remaining` 读取。**不写库、不重试**（重试与状态落库是 P0-2-5 同步编排的职责）。
  - `app/api/v1/canvas/credentials/route.ts` —— POST(201) + GET(元数据)。
  - `supabase/migrations/20260904100000_canvas_credentials_constraints.sql` —— `expires_at` NOT NULL + `unique(user_id)`（**2026-09-04 实测已在生产就位**）。
- **关键约束**：
  - 🔴 **密钥环境变量 `CANVAS_TOKEN_ENCRYPTION_KEY`**（base64 32 字节，**绝不加 `NEXT_PUBLIC_`**）。轮换不是改变量 —— 要先解密全部凭证再重新加密。
  - 🔴 **SSRF 不是可选项**：服务端拿用户填的域名发请求，域名不校验 = 开放内网探测。`canvasDomain` 只接受纯主机名，拒绝协议/端口/路径/IP/localhost/`169.254.169.254`。
  - **`expiresAt` 必填**（P0-2-1b 实测：bCourses 强制必填，上限 90 天）。契约原文"未填存 null"已被实测推翻。
  - **列常量必须写字面量字符串，不能 `.join()`** —— 拼出来的 `string` 会让 supabase 推不出返回行类型，`data` 退化成 `GenericStringError`（与 P0-1-1 的 `SYLLABUS_COLUMNS` 同一个坑）。
  - **supabase client 类型用 `Awaited<ReturnType<typeof createClient>>`**，不要用裸 `SupabaseClient`（缺 Database 泛型，select 返回类型会退化）。
  - **保存走"先查后写"不用 `upsert({onConflict})`** —— 后者在 unique 约束未执行时会直接报错；先查后写在约束就位前后都能工作。
- **自测（Bud，2026-09-04）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅ ｜ **冒烟 42/42 + 集成 8/8 + crypto 负向 13/13 = 63/63 全绿**
  - 冒烟：401（POST/GET）｜ 404 未连接 ｜ POST 201 且响应不含 token/密文字段 ｜ **库内密文验证**（用户自己 access_token 打 Supabase REST 直查 `secret_encrypted`，确认 4 段格式 + 以 `v1:` 开头 + 不含明文）｜ GET 元数据字段齐全 ｜ 重复 POST 不产生第二行 ｜ **12 条 400 校验路径**（含 4 条 SSRF：localhost / 169.254.169.254 / 10.0.0.5 / 带路径）｜ 跨用户隔离（userB GET 404 + REST 直查 0 行）｜ `x-request-id` 回传。
  - 集成：临时诊断路由验证**加解密往返** —— 解密出的 token 真去调 Canvas `/users/self` 成功（解错必 401），返回真实 user id + 限流头。**O-07 顺带查清：bCourses 确实返回 `x-rate-limit-remaining`**。
  - crypto 负向：往返正确｜IV 随机（两次加密结果不同）｜**篡改密文 → GCM 认证失败**｜错误密钥抛错｜密钥缺失/长度不对抛明确错误｜**所有错误消息不含明文与密文**（日志红线）。
- **交接清单（2026-09-04 Steven 实测，全部 ✅ 已收口）**：
  1. ✅ **Vercel 加 `CANVAS_TOKEN_ENCRYPTION_KEY`**（值与本机 `.env.local` 同） + 手动 Redeploy → 注入成功。
  2. ✅ **`20260904100000_canvas_credentials_constraints.sql` 早就执行**：2026-09-04 实测重复跑遇 `42P07 already exists`，用 `information_schema` 验证两条约束都已生效（`expires_at.is_nullable=NO`、`canvas_credentials_user_id_key` 存在）。本卡脚本在生产库就位，无需再跑。
  3. ✅ **验收**：本卡**无 UI**，验收靠 API 证据 + 数据库直查，**无需浏览器点击**。生产 401/404 契约正确。
  4. ✅ **测试账号已删**：`p022-a/b-*@example.com` / `p022-diag-*@example.com` 已由 Steven 清理。
- **未实现（明确不在本卡）**：① DELETE 撤销授权 → P0-2-9；② 保存后立即触发同步 → P0-2-5；③ 任何前端 UI → P0-2-4。

#### 🎫 P0-2-3 · Canvas API 客户端：拉课程列表（✅ 已验收 2026-09-04 · 勿重做）

- **做什么**：代理拉取用户 Canvas 课程列表，供 P0-2-4 关联 UI 选择。复用 P0-2-2 交付的 `canvasGet` / `loadDecryptedCredential`，**不要再写一套 fetch**。
- **改哪些文件**：
  - `lib/canvas/courses.ts`（新增）—— `fetchCanvasCourses(domain, token)`：请求 `GET /api/v1/courses?enrollment_state=active&include[]=term&per_page=100`，把 Canvas 课程映射成 `CanvasCourse`（externalId / name / term）。**忠实返回、不筛选学期/教学课程**。
  - `app/api/v1/canvas/courses/route.ts`（新增）—— GET handler：鉴权 → `loadDecryptedCredential` → `fetchCanvasCourses` → `{ data }`。**不写库、不重试**。
  - `docs/API-Contract.md` §6 —— 补 courses 端点错误码表 + §1.4 新增 `502 upstream_error`。
- **关键约束**：
  - 🔴 **`name` 用 Canvas 的 `course_code`**（非完整课程名）—— 关联 UI 需区分同名课程 lecture/section（Steven 实测 Math 53 拆成 LEC-001 / DIS-26 两个 id）。完整课程名用不到，丢了不可惜。
  - 🔴 **Canvas 上游故障（5xx / timeout / network / parse）→ 502 `upstream_error`**，不伪装成 Tempo 自己的 500。这是"服务端代理第三方"失败的准确语义。
  - **错误映射**：未登录 401 `unauthenticated` ｜ 无凭据 404 `not_found`（与 credentials GET 同口径，ADR-010）｜ Canvas 拒 token 401 `credential_invalid`（UI 应引导重新生成）｜ 限流 429 `rate_limited`。
  - **不做翻页**：Phase 0 规模 `per_page=100` 一页够（Steven 实测 13 门）。真超 100 的翻页需求等 P0-2-5 同步拉 assignments 时再处理（届时需给 `canvasGet` 加返回 `Link` 头的能力，作独立改动）。
  - **同步不需 `Promise.all`**（Sync-Strategy §2 Canvas 并发惩罚）：本卡是**单请求**，无并发问题；P0-2-5 同步拉多门课才必须串行。
- **自测（Bud，2026-09-04）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅ ｜ **本地冒烟 17/17**：401 未登录 ｜ 404 无凭据 ｜ 真实 PAT 存库 → GET 200 返 **13 门**（Fall 2026 恰 **6 门**、**MATH 53 出现两次** LEC+DIS、每项含 externalId/name/term）｜ 伪造 token → 401 `credential_invalid` ｜ POST/GET 响应均无 token/密文字段 ｜ x-request-id 回传。
  - ⚠️ **诚实标注**：`502 upstream_error` 分支**未做端到端触发**（需 Canvas 5xx/断网，难稳定复现）。该分支是 `mapCanvasFailure` 的一行 `default`，`canvasGet` 的错误分类（server_error/timeout/network/parse）已在 P0-2-2 完整测过，映射是直译，风险极低。
- **真实数据发现（P0-2-4 关联 UI 必须考虑）**：Steven 账号 13 门 active 课里，**只有 6 门是 Fall 2026 教学课程**（CHEM 1A / Chem 1AL-LAB / R4A / MATH 53-LEC / MATH 53-DIS / PHYSICS 7A）；**其余 7 门是入学流程/培训类模块**（term = "Default Term"/"Projects"：Bear Pact Quiz / GBA 系列 / PartySafe / Hazing / SHAPE），`term` 不是干净学期名。**✅ Steven 已拍板（2026-09-04）**：UI 走「**提示 + 询问用户是否把这些课也拉进 Tempo**」，不静默过滤、也不强制全列 —— 用户对某门培训课说"是"就关联，说"否"就不出现（见 P0-2-4 开工提示）。
- **✅ 验收记录（2026-09-04，Steven）**：生产验证 = 登录生产打 `GET /api/v1/canvas/courses`，账号未存凭据 → 返 404 `not_found`（code 正确），证明路由/鉴权/契约链路通。**Vercel 已配 `CANVAS_TOKEN_ENCRYPTION_KEY` 并 Redeploy**（P0-2-2 交接点一并收口）。测试账号 `p023-a/b-*@example.com` 已删。
- **🔜 下一张卡 P0-2-4（课程关联 UI：手动关联 Canvas 课程 ↔ Tempo Workspace）开工提示**：
  - 前端拉 `GET /api/v1/canvas/courses` 拿课程列表（**含真实数据里的培训类噪音课**）。
  - **噪音课呈现策略（Steven 2026-09-04 拍板）**：把教学课（term="Fall 2026" 之类）正常列给用户选；**非教学课（Default Term/Projects 培训模块）单独呈现 + 提示**："这些看起来不像课程（入学/培训类），要不要也拉进 Tempo？" 用户勾选才关联。**不静默过滤**（防漏掉用户真要的东西），也**不混排**（避免噪音淹没 6 门真课）。判定信号：`term` 不是标准学期名 + name 无课程代码特征，P0-2-4 定一个稳妥的分组规则即可，不用机器学习。
  - 关联写库走契约 `POST /api/v1/courses/:id/canvas-link`（存 `courses.canvas_course_id` = Canvas `externalId`）；解除走 DELETE。
  - `CanvasCourse.externalId` 是字符串（源头是数字，已 String() 化），关联存储时直接用，别重复转。
- **未实现（明确不在本卡）**：作业列表拉取 → P0-2-5（Steven 拍板，避免死代码 + 无处验收）；DELETE 撤销授权 → P0-2-9；任何前端 UI → P0-2-4。

#### 🎫 P0-2-4 · 课程关联 UI（✅ 已验收通过 2026-09-04 11:36，Steven 浏览器验收 · 勿重做）

- **做什么**：用户手动把一门 Tempo 课关联到一门 Canvas 课 —— 关联、状态可见、可解除。**不做自动匹配**（PRD F4：同名课程 LEC/DIS 自动匹配必错，选哪门是用户的判断）。
- **改哪些文件**：
  - `app/api/v1/courses/[id]/canvas-link/route.ts`（新增）—— POST 关联 / DELETE 解除，两个都幂等。
  - `lib/courses.ts`（改）—— `parseCanvasLinkInput()`（ID 外形校验）+ `toCanvasCourseIdUpdate()`（列名只在这里出现一次）+ `toCourse()` 补 `canvasCourseId`。
  - `types/course.ts`（改）—— `Course` 新增 `canvasCourseId: string | null`。
  - `lib/canvas/group-courses.ts`（新增）—— 教学课 / 其他分组的纯函数（规则判断，不用模型）。
  - `components/courses/canvas-link.tsx`（新增）—— 关联控件：默认态 / 选择态 / 连接态三态。
  - `components/courses/canvas-connect-form.tsx`（新增）—— 未连接时内嵌的 token 连接表单。
  - `app/(routes)/courses/[id]/page.tsx`（改）—— 加「Canvas 关联」区块。
  - `docs/API-Contract.md`（改）—— §2 新增字段、§6 两个端点（含 409 三态表）、§10 总表、§11 变更记录。
- **关键约束**：
  - 🔴 **关联 UI 放详情页**（`/courses/[id]`），沿 P0-1-8 拍板的「一门课的全部操作集中在详情页」；端点是 `courses/:id/canvas-link`，天然就是 per-course。
  - 🔴 **409 三态**：本课已关联另一个 Canvas 课 / 该 Canvas 课已被别的 Tempo 课关联 → 409；**重复提交同一 ID → 200 幂等**（契约原文"重复关联 → 409"的收敛：再点一次已关联项在 UI 上是常见动作，防呆不该用在这里）。
  - 🔴 **归档课程一律 404**（ADR-010 + 归档=删除）。**越权同样 404**（RLS 让别人的行根本查不出来）。
  - **关联不触发同步** —— 同步编排是 P0-2-5，现在空跑等于给假的成功信号。
  - **不校验 ID 在 Canvas 上是否真的存在** —— 省一次上游请求（限流额度），UI 只能从列表选；直接调 API 填错，最坏是 P0-2-5 同步时明确报错。
  - **解除关联不动 `last_synced_at` / `sync_status` / `sync_error`** —— 那是真实同步历史。契约原文「解除后任务标记为不再更新」等 P0-2-5 落了 canvas 任务、P0-2-7 做状态 UI 时再处理。
  - **`CanvasCourse.externalId` 已是字符串**（P0-2-3 就 `String()` 化了），直接存，别再转一次。
- **噪音课分组（Steven 2026-09-04 拍板的具体形态）**：
  - 规则在 `lib/canvas/group-courses.ts`：**`term` 是标准学期名**（`Fall 2026`）**或 `name` 有课程代码特征**（`CHEM 1A` / `MATH 53-LEC-001`）→ 教学课；否则进「其他项目」。
  - 两个信号取**或**：宁可把培训模块错分进教学课（只是分组不好看），也不能把真课分进其他（等于替用户藏选项，违反「不静默过滤」前提）。
  - 🔴 **课程代码正则的空格是必需的**：`GBO-FL26` 这种入学模块把学期限定符（FL26）贴着字母写，允许可选空格会让它们被判成教学课。真实课程代码（`CHEM 1A` / `MATH 53`）字母与数字之间都有空格。
  - **两组都能关联**，分组只影响展示位置与提示文案。
- **自测（Bud，2026-09-04）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅（`/api/v1/courses/[id]/canvas-link` 已进路由表）｜ **本地冒烟 40/40**：401（POST/DELETE）｜ 400（非法 uuid / 空体 / 7 条 ID 校验：缺失·空串·空格·非字符串·带空格·超长·非法字符）｜ 404（越权 / 不存在 / 归档课 POST+DELETE）｜ 关联 200 + 落库 + 响应无密钥字段 + `x-request-id` 回传 ｜ 同 ID 重复 → 200 幂等 ｜ 换 ID → 409 ｜ 同一 Canvas 课挂第二门 Tempo 课 → 409（文案带课程名）｜ 跨用户同 ID → 200（RLS 隔离）｜ `GET /courses` 与 `/courses/:id` 都返回 `canvasCourseId` ｜ 解除 → null + 幂等 + 可重关联 ｜ 未存凭据时 `/canvas/courses` → 404（UI 据此弹连接表单）。
  - **真实数据 15/15**（`.tmp-smoke-p024-real.mjs`，跑完已删）：用 Steven 的真实 PAT 走完整链路 —— 保存凭据 201（复刻连接表单 `datetime-local → Date → ISO` 的换算）→ 拉到 **13 门** → 关联真实 Canvas 课 → 详情读回 → 解除 → 清凭据与课程。全程响应与 HTML 均不含 token。
  - **分组规则真实数据验证**：13 门分成 **6 教学课 / 7 其他**，与 Steven 的描述逐门对得上。
  - **详情页 SSR 12/12**：已关联态（区块 / 已关联文案 / Canvas 课程 ID / 更改 / 解除关联 / 无 token 泄漏）6 项 + 未关联态（区块 / 未关联文案 / 关联按钮 / 不出现解除 / 不出现更改）6 项。
  - ✅ **Steven 浏览器验收（2026-09-04 11:36，生产环境）**：粘入 PAT → 13 门课全部抓出；教学课 / 其他两组分组符合预期；点「关联」成功、详情页显示已关联；点「解除关联」正常回到未关联态。**交互链路全部走通，本卡收口**。
- **🔜 下一张卡 P0-2-5（首次全量同步：Canvas 作业 → tasks 落库）开工提示**：
  - 关联关系已经有了：`courses.canvas_course_id` 存着 Canvas 课程 ID。同步时遍历**已关联且未归档**的课。
  - 拉取作业要用 `canvasGet`（P0-2-2）；⚠️ **同步必须串行**（Sync-Strategy §2 的 Canvas 并发惩罚），且**多门课要处理翻页** —— `canvasGet` 目前不返回 `Link` 头，需先给它加这个能力（对已验收 client 的独立扩展，别夹带在别的改动里）。
  - **重试与状态落库归本卡**（P0-2-2 的 client 刻意不重试、不写库，`isRetryable()` 已暴露给调用方）。
  - `POST /api/v1/courses/:id/canvas-link` 成功后的「触发一次同步」也在这里接上（契约 §6 写了，本卡刻意没做）。
- **未实现（明确不在本卡）**：① ~~同步 → P0-2-5~~（✅ P0-2-5 已接上：关联成功后按课程触发一次）；② 撤销 Canvas 授权（DELETE credentials）→ P0-2-9；③ 设置页（F6）→ P0-3-2 —— 连接表单暂内嵌在详情页，将来可整体搬过去。

#### 🎫 P0-2-5 · 首次全量同步（Canvas 作业 → `tasks` 落库）（✅ 已验收 2026-09-04 13:44，Steven「效果完美」· 勿重做）

- **做什么**：把已关联课程的 Canvas 作业拉下来、对齐到 `tasks`，并让用户能主动触发一次同步。**这是 M2 的核心卡** —— 之前四张卡都在铺路（凭据 / 客户端 / 关联），这一张才第一次让 Tempo 自己拿到数据。
- **改哪些文件**：

  | 文件 | 作用 |
  |---|---|
  | `lib/canvas/client.ts`（改） | `parseNextPath()`：解析 `Link` 头取下一页路径；成功结果多一个 `nextPath` 字段。**对已验收 client 的独立扩展**，是否翻页由编排层决定 |
  | `lib/canvas/assignments.ts`（新） | `assignmentsPath()` + `toCanvasAssignments()`：端点形状与字段映射，过滤学生端看不见的条目 |
  | `types/canvas.ts`（改） | 新增 `CanvasAssignment` |
  | `lib/sync/canvas-tasks.ts`（新） | 落库：新增 / 增量更新 / 软删除 / 恢复。**绝不碰 `status`** |
  | `lib/sync/runs.ts`（新） | `sync_runs` 唯一映射点：锁 / 节流查询 / 起止 |
  | `lib/sync/canvas-sync.ts`（新） | 编排：串行、重试退避、三级熔断、课程级隔离、状态落账 |
  | `types/sync.ts`（新） | `SyncSummary` / `SyncOutcome` / `SyncSkipReason` |
  | `lib/courses.ts`（改） | `toSyncStateUpdate()`（列名只此一处） |
  | `lib/canvas/credentials.ts`（改） | `touchCredentialSuccess` / `markCredentialFailed`；`loadDecryptedCredential` 多返回 `status` |
  | `app/api/v1/sync/now/route.ts`（新） | 契约 §6 的手动同步端点 |
  | `app/api/v1/courses/[id]/canvas-link/route.ts`（改） | 关联成功后触发一次该课程的同步 |

- **关键约束**：
  - 🔴 **串行，禁止 `Promise.all`** —— Canvas 对并发有 pre-flight penalty（Sync-Strategy §2）。串起来慢一点，但不会被限流反噬。
  - 🔴 **三级熔断**（§6.3）：单次同步 ≤ 20 请求 / ≤ 60 秒 / 单课 ≤ 3 页。任一触发 → 剩下的课留到下一轮，整批标 `partial`（**不是 failed** —— 已经成功的部分是有效的）。
  - 🔴 **401 / 403 绝不重试**（§8）：立即把凭证置 `error` 并停止后续课程。5xx / 超时 / 网络 → 最多 2 次（1s → 4s + 抖动）；429 → 最多 1 次（等 `Retry-After`，封顶 10 秒）。
  - 🔴 **写入字段集合是封闭的**：`title` / `due_date` / `external_updated_at` / `last_seen_at` / `is_deleted`。**没有 `status`** —— 整行 upsert 会把用户勾掉的"已完成"打回 pending（Database.md 4.1）。
  - 🔴 **拉取不完整时不做删除**（`complete=false`）：翻页被熔断截断时把没拿到的行判成"外部已删除"，是同步里最伤用户的一类事故。宁可晚一轮再删。
  - 🔴 **`sync_status` 没有 `partial`**：DB 的 CHECK 只放行 never/success/failed。partial 是**一批**同步的属性，记在 `sync_runs.status`；逐课只有成功/失败。**为此不改表结构**（改 CHECK 要 Steven 手动跑 SQL）。
  - **时间比较用 epoch 不用字符串**：Postgres 回 `2026-09-04T06:59:00+00:00`，Canvas 给 `2026-09-04T06:59:00Z` —— 直接 `===` 会永远判成"变了"，每次同步都写一遍全表。
  - **唯一索引冲突（23505）降级处理**：批量插入失败时退化为逐条插入并跳过冲突行，一行撞车不让整门课失败。
- **检查顺序（有讲究，别随手重排）**：锁 → 凭据是否存在 → 凭据是否可用 → 有没有课可同步 → **节流**。
  节流**刻意排最后**：它保护的是 Canvas 的限流额度，一个请求都不会发的时候回"同步太频繁"是错误引导（实测踩到：token 失效时用户看到的是"27 秒后重试"，而真正该做的是重新生成 token）。
- **三个实现期决策（Steven 2026-09-04 拍板 / Bud 落地）**：
  1. **无 due date 的作业照样同步，落库为 TBD**。实测 CHEM 1A 的 25 条里 9 条没日期（考勤打卡 + 4 个考试）。代价：4 个考试会与 syllabus 的 `exam_dates` 派生任务同名并列（一个带日期、一个 TBD）—— **这是 P0-2-11「合并展示、考试以 `exam_dates` 为权威源」要收的口子**，本卡不替它做决定。
  2. **关联成功后立刻同步那门课**（契约 §6 原文，P0-2-4 刻意留空）。三条边界：同步失败**不影响**关联结果（关联已成功写入，成败由 `courses.sync_status` 记账）；**不走节流**；结果**不进响应体**（响应仍是 course 对象，形状不变）。
  3. **跳过 `upcoming_events` 主扫描**（Sync-Strategy §4 第 4 步）。两条理由：它只返回**未来**事件，会系统性丢掉"逾期未完成"的作业（与「不隐藏」原则直接冲突）；它不带 `updated_at`，做不了变更判定，逐课详情**依然非拉不可**，那个"1 个请求"省不下来，只是多出一个要合并的数据源。已在 `Sync-Strategy.md` §4 记录。
- **自测（Bud，2026-09-04）**：`tsc` ✅ ｜ `lint` ✅ ｜ `build` ✅（`/api/v1/sync/now` 已进路由表）｜ **本地冒烟 52/52 + 多课程 28/28 = 80/80**，全部跑真实 PAT 与真实课程数据：
  - 正常：CHEM 1A 落库 25 条（9 条 TBD），**逐条比对 Canvas 的标题与 due date 全部一致**；无重复（`source_id` 唯一）；`sync_runs` 记账正确。
  - 幂等：重复同步 created/updated/deleted **全 0**（无变化不写库，不刷 `updated_at`）。
  - 变更：人为改坏标题 + 日期并标记 done → 同步后标题与日期改回、**`status=done` 保留**。
  - 删除：幽灵作业 → 软删除（`is_deleted=true`，行还在）；把真实作业标记删除 → 下次同步**恢复**。
  - 失败：假 token → 课程 failed + 凭证置 `error` + 再次调用 401 `credential_invalid`；不存在的 Canvas 课 → `partial` + failures 带课程名，其他三门课仍 success（课程级隔离）。
  - 边界：空课程（Math 53 LEC 0 条作业）是 success 不是失败；归档课不参与同步；30 秒内 429 + `retryAfter`；running 行 → 409。
  - 越权：B 改 A 的任务 404；B 看不到任何任务。
  - ⚠️ **诚实边界**：以上都是 API / 数据库级验证。**没有 UI**（同步状态 UI 是 P0-2-7，刷新按钮是 P0-2-6），Steven 现在只能在生产/本地用 curl 或浏览器直接打 `POST /api/v1/sync/now` 验收。
- ✅ **Steven 生产验收（2026-09-04 13:44）**：在 Chem 1A 详情页「解除关联 → 重新关联」触发同步后，作业立即落库、总览卡片出现近 7 天任务（Homework 2/3 逾期 / Homework 4 / Week 1/2 Discussion Quiz 等 5 条）。Steven 反馈「效果简直完美」。**本卡收口，勿重做。**
  - **根因坐实**：Chem 1A 是在旧版（canvas-link 未接同步的 P0-2-4）关联的，那次关联不触发同步；此后重登/刷新从不触发（自动同步是 P0-2-6 的事）→ tasks 一直空 → 卡片「近期没有待办」。**Math 53 LEC/DIS 都是 0 条作业，「近期没有待办」是正确状态，非 bug。**
  - 🔜 **P0-2-6 头一件事（本次暴露）**：得补**手动「同步」按钮** —— 现在唯一触发方式就是"解除→重绑"这种绕路操作，不用户友好。加上打开应用自动同步，用户才不用每次手动。
- **🔜 下一张卡 P0-2-6（刷新机制）开工提示**：
  - 编排函数 `runCanvasSync()` 已经支持 `trigger`（`app_open` / `manual` / `scheduled`）与两个节流常量 `MANUAL_THROTTLE_MS`（30s）/ `APP_OPEN_THROTTLE_MS`（60s），**接触发入口即可**，不用改编排。
  - 定时兜底走 `POST /api/v1/sync/scheduled`（契约 §6）：需 `CRON_SECRET` + **恒定时间比较**；批量遍历全部有效凭据用户 —— 这一步**需要 service role**（现在只有 user-scoped client），是 P0-2-6 要解决的头一件事。
  - ~~⚠️ **migration 补档（P0-2-6 一并处理）**：`sync_runs` / `courses.sync_status`/`last_synced_at`/`sync_error`/`canvas_course_id` / `canvas_credentials` 全都不在 `supabase/migrations/` 里 —— 是靠 P0-2-2 的手动 SQL 建进 prod 的，schema **未版本化**。~~ **2026-09-05 核实推翻**：逐行查 `20260902003000_initial_schema.sql`，上述表与列**全部在其中**（`canvas_course_id` L55、同步三列 L58-61、`canvas_credentials` L198、`sync_runs` L219）。本条结论源于 09-04 诊断时无 service role 读不到生产 DB 的误判，**无需补档**。
  - 状态展示要的数据已经齐了：`courses.last_synced_at` / `sync_status` / `sync_error` + `sync_runs`（含 `partial` 与逐课程 failures）。
  - 已知留白：`last_seen_at` 只在发生变化时刷新（详见 `lib/sync/canvas-tasks.ts` 文件头），P0-2-7 若想展示"这条任务最后一次在 Canvas 上被看到的时间"，需要改这个取舍（代价是每次同步都刷 `updated_at`）。

---

## P0-2-6 刷新机制第一拍（T1 打开应用自动同步 + T2 手动同步按钮）：代码完成 2026-09-05，待 Steven 验收

**范围**：Sync-Strategy §3 四档触发中的 **T1（主力）+ T2**；T3 定时兜底 = 第二拍，等第一拍验收后再开工。

- **改动清单**：
  - `app/api/v1/sync/now/route.ts`：新增可选 JSON body `{trigger}`，`parseTrigger()` 校验（省略/非法 JSON/缺字段 → 回退 `manual`，兼容 P0-2-5 裸 POST）；双档节流映射 `app_open → APP_OPEN_THROTTLE_MS(60s)` / `manual → MANUAL_THROTTLE_MS(30s)`；`scheduled` 及非法值 → `400 validation_failed`（定时入口只属于 `/sync/scheduled` + CRON_SECRET）。
  - `components/sync/sync-controls.tsx`（新建）：T1 = 挂载（`setTimeout(0)` 规避 `react-hooks/set-state-in-effect`）+ `visibilitychange` 重新聚焦触发 `app_open`，客户端 60s 本地闸门（`lastAutoSyncAtRef`，礼貌性，服务端才是权威）；T2 = 「同步 Canvas」outline sm 按钮（syncing 中置灰）。`hasCanvasLink` 双重门：无关联课程不渲染按钮也不自动同步。app_open 的 409/429 静默（正常路径），`credential_invalid` 等可操作错误照常提示；manual 显示全部反馈；成功 `router.refresh()`。
  - `app/(routes)/dashboard/page.tsx`：`hasCanvasLink = courses.some(c => c.canvasCourseId !== null)`，按钮接在标题行 CourseCreatePanel 左侧。
- **自测**：`tsc` ✅ / `lint` ✅ / `build` ✅（`/api/v1/sync/now` 在路由表）/ **冒烟 18/18**（双用户：B 未连接控制组 401/404/400 路径 ×8 + dashboard 无按钮；A 真实 PAT 全链路：凭据 201 无 token 回显、建课、关联 200 + tasks 落库、**双档节流实测 `app_open` retryAfter=57s > `manual`=26s**（60s vs 30s 窗口差）、dashboard 有按钮）。
- **⚠️ 诚实边界**：以上为 API/SSR 级验证；按钮点击、聚焦标签页触发自动同步的体感需 **Steven 本地 `npm run dev` 浏览器验收**。
- **待 Steven**：① 浏览器验收第一拍；② 删 4 个测试 auth 账号（`p026-a-1788637754178` / `p026-b-1788637748968` / `p026-a-1788637835557` / `p026-b-1788637831861`，均 `@example.com`；前两个有遗留 course+credential 业务数据，随 auth 用户级联删除）。
- **第二拍（T3）开工前置**：service role key（`.env.local` 无）+ `CRON_SECRET` + `vercel.json` cron 配置 —— **等 Steven 验收第一拍后再动**。
- ✅ **2026-09-05 Steven 验收通过**（T1 自动同步 + T2 手动按钮）。**第一拍收口，勿重做。**

---

## P0-2-6 第二拍 T3 平台定时兜底：代码完成 2026-09-05，待 Steven 验收

**范围**：Sync-Strategy §3 的 T3 —— 每天两次定点扫描全部用户，捕捉"用户没打开期间的变化"，顺带保活 Supabase（免费层一周无活动自动暂停）。

- **改动清单**：
  - `app/api/v1/sync/scheduled/route.ts`（新增）：**GET 与 POST 都导出**（Vercel Cron 只发 GET，契约原文写的 POST 是错的，Sync-Strategy §3.2 的 T4 示例又是 GET —— 收口为双方法等价）。鉴权 `Authorization: Bearer ${CRON_SECRET}`，**sha256 + `timingSafeEqual` 恒定时间比较**；**fail closed**：`CRON_SECRET` 未配置 → 500 `cron_not_configured`（不管带什么凭证都拒绝执行）、`SUPABASE_SERVICE_ROLE_KEY` 未配置 → 500 `service_role_key_missing`。`dynamic = 'force-dynamic'`（被缓存一次 = 定时扫描全部落空）。
  - `lib/sync/scheduled.ts`（新增）：串行逐用户 `runCanvasSync(trigger: 'scheduled')`；**不做节流**（防重跑靠 5 分钟锁）；单用户异常不影响他人；**整批 240 秒预算**（Vercel 上限 300s），超时计 `usersDeferred` 留下一轮；响应只给聚合计数 + 错误消息，**不含 user_id / 课程名**（`user_id` 只进日志）。
  - `lib/supabase/admin.ts`（新增）：service role 客户端，**全项目唯一的 RLS 绕过入口**，文件头写明三条红线与唯一合法用途。
  - `vercel.json`（新增）：两条 cron，`0 10 * * *` / `0 22 * * *`（UTC，对应 03:00 / 15:00 PDT，Sync-Strategy §3.1）。
  - 🔴 **同步层补强制 `userId` 过滤**（`lib/canvas/credentials.ts` 的 `loadDecryptedCredential` / `loadCredentialMeta`、`lib/sync/runs.ts` 的 `findRunningRun` / `findLastRunStartedAt`、`lib/sync/canvas-sync.ts` 的课程查询）：**service role 绕过 RLS**，原先这些查询全靠 RLS 隐式隔离，在那个客户端下会读到**别人的凭据**、把锁与节流变成**全局的**、同步**所有人的课程**，而且**不报错**。四处全改显式 `user_id` 且参数**强制**（不传编译不过）。
  - `.env.example`：补 `SUPABASE_SERVICE_ROLE_KEY` / `CRON_SECRET` 及红线说明。
- **自测**：`tsc` ✅ / `lint` ✅ / `build` ✅（`/api/v1/sync/scheduled` 已进路由表且为动态）/ **冒烟 18/18**：鉴权四类路径（无头 401 / 错 secret 401 / 非 Bearer 401 / 正确 secret 但缺 key → 500 明确码）+ GET≡POST + x-request-id 回传；**第一拍回归全绿**（真实 PAT 建凭据 → 建课 → 关联触发同步 → **tasks 落库 25 条**，证明加了 `user_id` 过滤后同步链路没坏；`trigger=scheduled` 仍 400；节流窗口仍按用户生效 429）；跨用户隔离（B 未连接 404、B 看不到 A 的任务）；**CRON_SECRET 未配置时带不带凭证都 500 拒绝执行**（fail closed 实测）。
- **⚠️ 诚实边界**：**真 service role 跑完整循环尚未自测** —— `.env.local` 里还没有 `SUPABASE_SERVICE_ROLE_KEY`（须 Steven 从 Dashboard 取）。上面的 18/18 覆盖的是鉴权、fail closed 与第一拍回归；"遍历全部用户逐一同��"这段逻辑**只过了类型与代码审查，没有实测**。
- **待 Steven（按序）**：① 把 `SUPABASE_SERVICE_ROLE_KEY` 填进 `.env.local`（Project Settings → API Keys → service_role，**绝不加 `NEXT_PUBLIC_`**）→ 我补跑完整链路冒烟；② 生成 `CRON_SECRET` 并在 **Vercel** 配好两个新变量后 **手动 Redeploy**；③ 首次 cron 触发后（10:00 / 22:00 UTC）看 Vercel 日志确认 200 且 `usersSynced > 0`；④ 删 2 个测试 auth 号（`p026b-a-*` / `p026b-b-*`，业务数据已 REST 清理）。

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
| 2026-09-03 | **P0-1-6 五板块编辑 UI 代码完成（浏览器交互待 Steven 验收）**：`lib/sections.ts`（服务端直查五表）+ `components/sections/`（编辑器 + 五表单 + 共用 hook）+ 上传流程补齐第 5 拍解析触发（开始/重试/重新解析带二次确认）。**两个 Steven 拍板**：编辑 UI 放卡片内折叠面板（不新增路由，详情页留给 P0-1-8）、重新解析入口带上。**一处 React 模式纠正**：表单同步 props 从「effect 里 setState」改为「key 重挂载」（lint `react-hooks/set-state-in-effect` 拦下）。**发现并补上了一个断链**：`/parse` 此前没有任何 UI 触发入口，上传流程停在「已提取文本，等待解析」。tsc/lint/build 全绿，无头冒烟 17/17（SSR 载荷带板块数据 + RLS 隔离 + PUT 回包）。**P0-1-8 时该编辑器已随「全部搬到详情页」的决策移到详情页**，卡片恢复为摘要 |
| 2026-09-03 | **P0-1-8 课程详情页代码完成（浏览器交互待 Steven 验收）**：`GET /api/v1/courses/:id`（契约 §2）+ `lib/course-detail.ts`（读逻辑唯一一份）+ `app/(routes)/courses/[id]` + `section-view.tsx`（TBD 展示层）+ SectionEditor 加查看/编辑双模式 + **卡片瘦身为摘要**（删除也集中到详情页）。**两个 Steven 拍板**：全部操作搬详情页（卡片只留摘要+入口+删除）、路由 `/courses/[id]`。**契约收敛**：`syllabus` 返回完整 Syllabus 对象（超集，UI 需要 extractStatus/parseError）、归档课程 404。**顺手消除** P0-1-6 的「dashboard 一次性加载所有课程五板块」开销。tsc/lint/build 全绿，无头冒烟 34/34。进度指针推进至 P0-1-9 |
| 2026-09-03 | **收工 + 三张卡 signoff（Steven 11:50 验收通过）**：**P0-1-5b ✅**（本地 56/56 + 生产 18/18）· **P0-1-6 ✅**（无头 17/17，浏览器验收）· **P0-1-8 ✅**（无头 34/34，浏览器验收）。1-6 与 1-8 的浏览器验收是同一次会话 —— 1-8 把编辑器从课程卡片搬到详情页后，1-6 的验收标准改为在 `/courses/[id]` 上验。任务表状态列与进度指针全部更新，指针停在 **P0-1-9（🔵 未开工，两个产品问题待拍板）**。⚠️ **本轮越界记录**：Steven 的停止指令原为 P0-1-5b，Bud 收到模糊的「Please continue.」后一路做到 P0-1-8；已写进协作约定（Done Report 之后的模糊指令一律回读原始停止点）。**待 Steven 手动**：删 8 个测试账号 | 
| 2026-09-03 | **P0-1-9 两个产品问题拍板（Steven 11:58）+ 测试账号清理完毕**：① **包含「标记任务完成」** —— 走契约 §5 `PATCH /api/v1/tasks/:id`，只允许改 `status`，派生任务改 title/dueDate 返 `422 derived_task_immutable`（ADR-004 接口层强制点）；② **已完成的任务：横线划掉 + 折叠起来**（不隐藏、不置灰混排）。同时核实到一个实现事实：`app/api/v1/` 下**只有 `courses` 和 `syllabi`**，契约 §5 的 `GET /api/v1/tasks` 与 `PATCH /api/v1/tasks/:id` **都不存在，P0-1-9 要新建**；`POST`/`DELETE`（手动任务）因范围是「仅 syllabus 数据」**不在本卡**。8 个 `@test.dev` 测试账号已由 Steven 手动删除。**Bud 未开工** —— 未收到开工指令 | 
| 2026-09-03 | **P0-1-9 总览页 v1 代码完成（浏览器交互待 Steven 验收）**：新建 `types/task.ts` + `lib/tasks.ts` + `GET /api/v1/tasks` + `PATCH /api/v1/tasks/:id`（此前两个端点都不存在）+ `components/tasks/task-list.tsx`；`Course` 加可选 `upcomingTasks` 并由 `GET /api/v1/courses` 补上（契约 §2 早有此字段但一直没返回）；卡片显示近期 1-2 个任务；dashboard 加「最近要做的事」区块。**三个实现期决策（写入 `API-Contract.md` §5 变更记录）**：① `range` **只设上界不设下界** —— 逾期未完成的任务必须留在列表里（藏起来等于帮用户逃避）；② PATCH 两类拒绝分开 —— 派生任务传 title/dueDate → `422 derived_task_immutable`（ADR-004 接口层强制点），非派生任务 → `400 validation_failed`（明确拒绝而非静默忽略）；③ `meta` **不返回** `staleWarning`/`lastSuccessfulSyncAt`（Canvas 同步状态，Phase 0 无同步，硬编码 false 是静默的错误数据），留 P0-2-7 / P0-2-11。**两个技术约束**：tasks 的 RLS 不看 `is_archived`（归档过滤必须显式做）、`.lte()` 对 null 求值不成立（TBD 任务要显式 `or` 保留）。**踩坑**：把 PostgREST 查询构造器抽成带泛型函数触发 `TS2589`，排序改为各写一份。tsc/lint/build 全绿，本地无头冒烟 **64/64**。测试账号 `p19-a/b@test.dev` 待 Steven 手动删 |
| 2026-09-03 | **P0-1-9 生产验证通过**：Vercel 部署 `1b4864c` success，生产冒烟 **26/26**（端点已部署两个、range 窗口与排序、分页、跨用户隔离、`upcomingTasks`、PATCH 标记完成与 422、越权 404、`x-request-id` 回传、dashboard SSR、数据清理）。生产验证前先用 `gh api .../deployments` 确认部署 —— 首次查询时最新部署仍是昨天的 `0587138`，新路由 404 而旧路由 401，按 `CodingRules.md` §10.1 第 7 条判定为部署延迟而非代码问题，等待后自动创建。**待 Steven 手动**：删测试账号 `p19-a/b@test.dev`（本地）+ `p19-prod-a/b@test.dev`（生产） |
| 2026-09-03 | **P0-1-9 验收通过 ✅ → M1 静态理解链路完整收口（2026-09-03 16:10，Steven 浏览器验收）**：三项浏览器交互全通过（勾 checkbox 标记完成并刷新 / 展开「已完成 N 项」看到删除线 / 卡片显示近期任务），测试账号由 Steven 手动删除，auth.users 无残留。commit `8022643`（代码）+ `1b4864c`（文档）+ `f5065b7`（生产验证）+ `777712c`（踩坑库），Vercel 部署 `1b4864c` success。**本轮 Bud 两次在模糊指令「Please continue.」处按 `CodingRules.md` §5 停下确认，未越界开工** —— 该规则第二次生效，可确认「Steven 会重复用 Please continue. 回应 Done Report」是稳定模式。**下一张卡 P0-1-10 Demo Workspace，Steven 在新会话开工**；开工前唯一阻塞是「示例数据来源」：A 真实公开 syllabus（推荐，代入感强）/ B 合成示例（须明确标注为演示数据，否则与产品「抗幻觉」立场冲突）。契约 §8 的 `POST /api/v1/demo/seed` + `DELETE /api/v1/demo` 已定义，不阻塞实现 |
| 2026-09-03 | **P0-1-10 Demo Workspace 代码完成（待 Steven 浏览器验收）**：示例数据 = Steven 提供的真实 `Syllabus 2.pdf`（CHEM 1A Fall 2026，选项 A）。五板块由 `lib/parse` 真实解析结果固化进 `lib/demo/seed-data.ts`，seed 端点复用 `persistParsedSections` 落库 + `syncExamToTask` 派生考试任务，**运行时零 LLM 依赖**。新增 `POST /api/v1/demo/seed`（重复 409 already_linked、失败回滚课程）+ `DELETE /api/v1/demo`（级联清子数据 + 复位 `demo_seeded_at`、幂等）+ `components/courses/demo-controls.tsx`（「先看看效果」CTA + 「清空示例数据」）+ 课程卡「示例」badge + dashboard 空状态入口。**Steven 拍板留空** `courseOutline`（解析器对 L1–L40 讲座编号课表稳定漏抽，已记 bug 归 P0 期后改进卡）与 `officeHours`（原文无具体时间，模型正确返回空）；演示课程**不建 syllabi 行**（避免悬挂 Storage 对象）。自测 `tsc`/`lint`/`build` 全绿 + 冒烟 **14/14** + dashboard SSR 渲染验证全过。**遗留两个测试 auth 账号待 Steven 在 Supabase Dashboard 删除**。DeepSeek 期间触发 429 每日限流（非余额耗尽，约 2026-09-04 13:04 北京时间重置），不阻塞本卡 |
| 2026-09-04 | **P0-1-10 验收通过 ✅（2026-09-04 09:18，Steven 浏览器验收）+ 一处生产 500 修复**：Steven 点「先看看效果」成功产生 CHEM 1A 示例课程，**P0-1-10 验收通过 · 勿重做**，冷启动闭环（M1 链路 + Demo Workspace）全部打通。此前生产点「先看看效果」报 500 的根因排查与修复（commit `0f922c3`）：**删 auth 测试账号会经 `profiles.auth.users` 外键 ON DELETE CASCADE 连带删掉该 user 的 profiles 行，但 browser session 仍有效 → seed/course-create 写 `profiles.demo_seeded_at` / insert courses 撞外键违反 → 500**。新增 `lib/profiles.ts` 的 `ensureProfile()`（幂等 upsert，`on conflict id do nothing`，RLS WITH CHECK 放行）在 `demo/seed` / `demo` / `courses` POST handler 顶部兜底调用。本地复现孤儿场景（删 profile → seed 原 500、修后 201）验证通过，`tsc`/`lint`/`build` 全绿。进度指针推进至 **M2 动态感知（P0-2 Canvas 同步）**，入口 P0-2-1 已 ✅，待 Steven 在新会话定 P0-2 序列开工。**提醒**：Dashboard 删 `@example.com` 测试号若删到当前登录账号会连带清 profile（现已自动兜底重建）；调试遗留号 `debug-seed-*` ×2、`orphan-profile-*` ×1、`ui-check-*` ×1 待下次清理 |
| 2026-09-04 | **P0-2-1b 完成 + 6 份文档过期上限统一修正（commit `eecb157`）**：Steven 提供 bCourses "+ New Access Token" 弹窗截图，实测三项结论 —— ① 过期时间**强制必填**（date + time 均带 `*`）；② 上限 **90 天**（弹窗原文 "Maximum expiration is 90 days."）；③ 撤销在 Settings → Access Tokens 同页。**推翻** 2026-09-01 那条"90 天 → 约 120 天"的事实修正（历史条目保留，新条目标注推翻以保审计可追溯）。同步修正 `Sync-Strategy.md` / `Database.md` / `PRD.md` / `TechStack.md` / `Tempo_产品总蓝图.md` / `Decisions.md` 共 9 处；`canvas_credentials.expires_at` 由 nullable 改为 **NOT NULL**；删除"用户没填就存 null / 不要写死 90 天"等过时告诫。**Steven 拍板**：发现漂移后选"立刻统一改"而非拖延 |
| 2026-09-04 | **P0-2-2 代码完成（待验收，63/63 自测全绿）**：AES-256-GCM 加密（`lib/canvas/crypto.ts`，密文格式 `v1:iv:tag:ct`，版本前缀为密钥轮换留口子）+ `POST/GET /api/v1/canvas/credentials` + `lib/canvas/client.ts` 请求封装（10s 超时 / 错误分类 / 读限流头）+ `lib/canvas/validate.ts`（**含 SSRF 防护**：域名只接受纯主机名，拒绝 IP/localhost/内网/协议/路径）。**关键实现期决策**：① 保存走"先查后写"不用 `upsert({onConflict})`（后者在 unique 约束未执行时直接报错）；② 客户端封装**不重试不写库**（重试与状态落库归 P0-2-5 同步编排）；③ `expiresAt` 按实测强制必填 + 上限 90 天。**自测**：冒烟 42/42（含库内密文直查验证、12 条 400 校验路径、跨用户隔离）+ 集成 8/8（**解密出的 token 真调 Canvas `/users/self` 成功**，证明加解密往返正确）+ crypto 负向 13/13（篡改密文 → GCM 认证失败、错误密钥抛错、错误消息不含明文）。**顺带查清 O-07**：bCourses 确实返回 `x-rate-limit-remaining`。**两个 Steven 交接点**：① Vercel 加 `CANVAS_TOKEN_ENCRYPTION_KEY`（加完必须手动 Redeploy）；② 执行迁移 `20260904100000_canvas_credentials_constraints.sql`（约束加固，不阻塞功能）。**明确未做**：DELETE 撤销授权（P0-2-9）、保存后触发同步（P0-2-5）、前端 UI（P0-2-4） |
| 2026-09-04 | **P0-2-3 代码完成（待 Steven 验收，冒烟 17/17）**：`GET /api/v1/canvas/courses`（代理拉课程列表）+ `lib/canvas/courses.ts`（忠实映射 CanvasCourse，不筛选学期）。复用 P0-2-2 的 `canvasGet`/`loadDecryptedCredential`。**范围收敛（Steven 拍板）**：任务名虽含"作业列表"，本卡只做课程列表（契约 §6 唯一端点），作业拉取签名留到 P0-2-5。**真实数据实测**：13 门 active 课里 6 门 Fall 2026 教学课 + 7 门入学/培训类（Default Term/Projects），**P0-2-4 需考虑噪音课呈现**。**两个实现期决策**：`name` 用 course_code（区分 LEC/DIS）；上游故障 → 502 `upstream_error`（契约 §1.4/§6 已补）。**自测**：tsc/lint/build 全绿 + 冒烟 17/17（401 / 404 无凭据 / 真实 PAT 返 13 门含 MATH 53 ×2 / 伪造 token 401 credential_invalid / 无 token 泄漏 / x-request-id）。凭据行已清，auth 用户 `p023-a/b-*@example.com` 待 Steven 删 |
| 2026-09-04 | **P0-2-3 验收通过 ✅（2026-09-04，Steven 生产验收）+ P0-2-2 交接点收口**：Steven 配好 Vercel `CANVAS_TOKEN_ENCRYPTION_KEY` 并 Redeploy（P0-2-2 交接点①完成），生产打 `GET /api/v1/canvas/courses` 返 404 `not_found`（账号未存凭据，code 契约正确），证明路由/鉴权/契约链路通。**噪音课呈现策略（Steven 拍板，commit `a879ad9`）**：教学课正常列给用户选 + **非教学课（Default Term/Projects 培训类）单独提示"这些看起来不像课程，要不要也拉进 Tempo？"，用户勾选才关联**，不静默过滤不混排 → 已写入 P0-2-4 开工提示。测试账号 `p023-a/b-*@example.com` ×2 已由 Steven 删除。进度指针推进至 **下一张卡 P0-2-4**（课程关联 UI），Steven 将在新会话开工。commit `def9b37`（代码）+ `1cf9848`（契约文档）+ `a879ad9`（噪音课决策）+ `a879ad9` 部署 success |
| 2026-09-04 | **P0-2-4 课程关联 UI 代码完成（🔵 待 Steven 浏览器验收）**：`POST`/`DELETE /api/v1/courses/:id/canvas-link`（均幂等，归档课 404）+ `components/courses/canvas-link.tsx`（详情页关联控件）+ `components/courses/canvas-connect-form.tsx`（未连接时内嵌 token 连接表单，P0-2-2 留下的「前端 UI 归 P0-2-4」在此收口）+ `lib/canvas/group-courses.ts`（教学课 / 其他分组）+ `Course` 新增 `canvasCourseId`。**三个实现期决策**：① 重复提交同一 ID → 200 幂等（收敛契约原文的「重复关联 → 409」）；② 关联不触发同步（P0-2-5）；③ 解除关联不动同步字段（真实历史，且此刻无 canvas 任务）。**噪音课分组按 Steven 拍板落地**：教学课正常列 + 其他项单独一组带提示，真实 13 门分成 **6 / 7** 完全对得上；🔴 课程代码正则的**空格是必需的**（`GBO-FL26` 的 FL26 贴着字母写，允许可选空格会把入学模块判成教学课）。**自测**：tsc/lint/build 全绿 + 本地冒烟 **40/40** + 真实 PAT 端到端 **15/15** + 分组规则真实数据验证 + 详情页 SSR **12/12**（已关联 / 未关联两态）。**下一张卡 P0-2-5**（首次全量同步），开工提示已写进执行卡（含「`canvasGet` 需先加返回 `Link` 头的能力」与「同步必须串行」） |
| 2026-09-04 | **P0-2-4 验收通过 ✅（2026-09-04 11:36，Steven 浏览器验收，第 14 张卡）**：生产环境粘入 PAT → 13 门课全部抓出、教学课 / 其他分组符合预期、关联与解除关联交互全部正常。5 个测试 auth 账号（`p024-a-*` / `p024-b-*` / `p024r-real-*` / `p024g-group-*` / `p024u-*`）已由 Steven 删除。**M2 动态感知前 4 张卡（P0-2-1 / 2-2 / 2-3 / 2-4）全部收口**。进度指针推进至 **P0-2-5**（首次全量同步：Canvas 作业 → `tasks` 落库），Steven 将在新对话框开工；开工提示见 P0-2-4 执行卡末尾（遍历已关联未归档课 / `canvasGet` 需先加 `Link` 头能力 / 同步必须串行 / 重试与状态落库归本卡 / 接上关联成功后的触发同步） |
| 2026-09-04 | **P0-2-2 交接点② ✅ 收口（2026-09-04，Steven Dashboard 实测）**：迁移 `20260904100000_canvas_credentials_constraints.sql` **早就执行过**，并非"从未跑"—— Steven 在 Supabase Dashboard SQL Editor 重新跑遇 `42P07: relation "canvas_credentials_user_id_key" already exists`，用 `information_schema.columns` + `table_constraints` 验证：① `expires_at.is_nullable = NO`（NOT NULL 已生效）、② `canvas_credentials_user_id_key` 约束存在（UNIQUE 已生效）。两条约束**全部就位**，本卡脚本无须再跑。同步更新 P0-2-2 执行卡「待 Steven」清单（4 条全部 ✅）+ 进度指针 block（交接点标注从"待 Steven"改为"✅ 全部收口"）+ 571 行脚本描述去除【Steven 手动】标注 |
| 2026-09-04 | **P0-2-5 首次全量同步 代码完成（🔵 待 Steven 验收，自测 80/80）**：`POST /api/v1/sync/now` + `lib/sync/canvas-sync.ts`（编排）+ `lib/sync/canvas-tasks.ts`（落库）+ `lib/sync/runs.ts`（sync_runs 映射）+ `lib/canvas/assignments.ts`（作业端点）+ `canvasGet` 加 `Link` 翻页能力 + `POST canvas-link` 成功后按课程触发同步。**Steven 拍板三件事**：① 无 due date 的作业照样同步落库为 TBD（实测 CHEM 1A 25 条里 9 条无日期：考勤打卡 + 4 个考试）；② 关联成功后立刻触发一次该课程同步；③ 跳过 `upcoming_events` 主扫描（它只返回未来事件，会系统性丢掉逾期未完成的作业，且不带 `updated_at` 做不了变更判定，逐课详情仍非拉不可）。**自测 80/80**（本地 52 + 多课程 28，全跑真实 PAT/真实课程）：逐条比对 Canvas 标题与 due date 全一致；重复同步 created/updated/deleted 全 0；人为改坏标题+日期+标记 done → 同步后前两者改回、**status=done 保留**；幽灵作业软删除且可恢复；假 token → 课程 failed + 凭证置 error + 再调用 401；一门课失败 → 整批 `partial` 且其他课仍 success；空课程（Math 53 LEC 0 条）是 success 不是失败。**实现期发现的一个设计问题**：节流最初排在凭据检查之前，导致 token 失效时用户看到的是"同步太频繁，27 秒后重试"（错误引导）—— 已改为锁 → 凭据 → 课程 → **节流** 的最后一位。**明确未做**：手动刷新按钮 / 打开应用自动同步 / 定时兜底（P0-2-6，编排已支持 `trigger` 与节流常量）、同步状态 UI（P0-2-7）、总览页合并两类任务（P0-2-11）。**下一张卡 P0-2-6 的头一件事**：定时兜底要遍历全部用户，**需要 service role**（现在只有 user-scoped client） |
| 2026-09-05 | **P0-2-6 第一拍（T1+T2）代码完成（🔵 待 Steven 验收，自测 18/18）**：① `/sync/now` 新增可选 body `{trigger: 'manual'|'app_open'}`，双档节流 30s/60s 服务端权威映射，`scheduled`/非法值 400，裸 POST 回退 manual（兼容 P0-2-5）；② 新建 `components/sync/sync-controls.tsx`：挂载 + `visibilitychange` 自动同步（客户端 60s 闸门）+ 手动「同步 Canvas」按钮，`hasCanvasLink` 双重门（未关联不渲染不触发）；③ dashboard 标题行接线。**文档修正**：~~migration 补档~~ **核实推翻** —— `sync_runs`/`courses` 同步列/`canvas_credentials` 全部在 `20260902003000_initial_schema.sql`（L55/L58-61/L198/L219），schema 一直版本化，无需补档（旧结论源于 09-04 无 service role 读不到生产 DB 的误判，已在进度指针、P0-2-5 执行卡、Roadmap、MEMORY.md 同源修正）。**T3 第二拍未开工**：等第一拍验收 + service role 决策 |
