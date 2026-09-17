# Phase 1 设计文档 · Canvas 深度接入 + LLM 加工

> **用途**：本文件是「Canvas 深度接入 + LLM 加工」这条产品线的**设计 SoT**。2026-09-17 Steven 拍板把 `P0-3-18 / 3-19 / 3-20 / 3-23` **上移进 M3**（freeze 前做），仅 `P0-3-21`（study routine）/ `P0-3-22`（课程加权百分比）**留 Phase 1**。故本文件的卡表「归属」列以实际归属为准——上移的四张卡计入 M3 执行顺序（`3-18 → 3-19 → 3-20 → 3-23`），与 `Phase-0-MVP.md` 卡表一致。
> **最后更新**：2026-09-17（Steven 拍板路线图 + route 3 = A + 4 张卡上移 M3 + 确认 3-21/3-22 留 Phase 1）。

---

## 0. 已经用只读探针验证过的事实（不会再赌）

2026-09-17 用 Steven 真实 `CANVAS_PAT` 跑过两个只读探针（`.tmp-probe-canvas*.mjs`，只 GET、用完已删），结论：

- **`html_url` 全量存在**（`https://bcourses.berkeley.edu/courses/1555045/assignments/9140338`）。→ 「点任务跳 Canvas」只需加字段+加列。
- **单条分数零额外请求白送**：`submission.score`（HW3 = 2.25/2.5、Lab 1 = 16.75/20）+ 作业对象上的 `points_possible`。
- **`/courses/:id/files`、`/folders`、`/modules?include[]=items` 全通**。Chem 1A 真实内容：`Chem1A_Syllabus_Fall2026.pdf`（syllabus 本身就在 Files 里）、`HW0-7_1A_F26.pdf`、`Exam1EquationSheet_1A_F26.pdf`、`course files/Practice Exams/Unit 1 Exam/Answer Keys`、`Lecture Slides/Unit 1-4`、`Summary_Slides`、`Friday Review Sessions`；modules 给逐周课表（`Week 1: Aug 26-28` → `L1: The Periodic Table (Aug 26)` + slides/recording/readings）。
- **`enrollments?include[]=grades` 对本人返回 `grades: null`** → 拿不到 Canvas 权威课程总分。
- **加权口径各课不一**：Chem 1AL = 5/10/60/25（真加权）；CHEM 1A 全 0（老师没启用加权）。
- **makeup form 真实字段**（Chem 1AL `Lecture 1 - Airbags (makeup form)`）：`submission_types:["none"]`、`points_possible:2`、`omit_from_final_grade:false`、due `2026-09-01`。→ Canvas 字段里**没有能确定性识别 makeup form 的信号**（用 `none` 会误伤 `Academic Integrity Assignment`；用 `omit_from_final_grade` 也会误伤它）。**所以「需手动确认」是按整类 `null` 处理，不按字段规则猜单个。**

---

## 1. 总架构：三条路线，按风险从低到高，统一汇入「消息栏」

```
                同步时抓到的 Canvas 信号
   ┌─────────────────────┬──────────────────────┬─────────────────────┐
   │ 路线 1 · 资料索引     │ 路线 2 · 大纲漂移检测    │ 路线 3 · 学习资料加工    │
   │ (元数据，零解析)      │ (只抓 syllabus 文件)    │ (用户主动触发，LLM 加工) │
   └──────────┬──────────┴──────────┬───────────┴──────────┬──────────┘
              │                     │                      │
              ▼                     ▼                      ▼
         course_files 表      syllabus diff 提案       practice test 提案
              │                     │                      │
              └─────────────────────┴──────────────────────┘
                                ▼
                    【3-18 系统消息栏】← 所有「提案」排队，Steven 逐条确认才写
                                │
                          ADR-015：确认才写，绝不自动覆盖
```

**核心原则（与 ADR-015 / ADR-016 一致）**：
1. 默认**只存元数据**，内容**按需**抓（不做全量下载塞库）。
2. 分类信号靠 **Canvas 自己的 `modules` + `folders` 结构**，文件名做二级，**LLM 只兜底模糊项**。
3. 路线 2/3 的输出**全部进消息栏当提案**，绝不直接写 `exam_dates` / syllabus 五板块。
4. 403 文件**跳过不报错**（绝不能让一次文件拉取搞挂整条 sync）。

---

## 2. Phase 1 卡表

> **归属**：2026-09-17 Steven 拍板 —— `P0-3-18 / 3-19 / 3-20 / 3-23` **上移进 M3**（freeze 前做）；`P0-3-21 / 3-22` 留 Phase 1。

| 编号 | 任务 | 归属 | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **P0-3-18** | **消息栏**：侧栏入口 + 全屏对话页（浮窗 FAB 的全屏版）+ 系统提案收件箱 | **M3** | P0-3-17 | 侧栏可点进全屏对话；系统提案可确认/忽略；忽略不写 | ⚪ |
| **P0-3-19** | **资料索引（路线 1）**：抓 files/folders 元数据 → `course_files` 表 → 课程页「资料」区 | **M3** | P0-3-18 | 按 Canvas 文件夹分组 + 外链回 Canvas；403 跳过 | ⚪ |
| **P0-3-20** | **大纲漂移检测（路线 2）**：同步时按需抓 syllabus 文件 → diff → 提案进消息栏 | **M3** | P0-3-18、P0-3-19 | 抓到变更 → 出差异提案 → 确认才写 | ⚪ |
| **P0-3-23** | **practice test（路线 3，类型 A）**：选 past exam + answer key → 隐藏答案自测卷 | **M3** | P0-3-18、P0-3-19 | 生成自测卷；不幻觉出新题 | ⚪ |
| **P0-3-21** | **study routine 生成**：modules 课表 + syllabus 提交政策 → 每周 routine | Phase 1 | P0-3-18、P0-3-19 | 生成「周一/三/五上课→当天/次日写作业→传 Gradescope」式 routine | ⚪ |
| **P0-3-22** | **课程加权百分比**：权重可靠映射时按 `assignment_groups.group_weight` 算课程百分比 | Phase 1 | P0-3-17 | 真加权课显示百分比；未启用加权课显示提示不瞎算 | ⚪ |

> **M3 排序纪律**：`3-18 消息栏 → 3-19 资料索引 → 3-20 漂移 → 3-23 practice test`（3-20/3-23 都依赖 3-19 的原料与 3-18 的出口）→ 再 `3-12 扫尾 → 3-13 freeze`。

---

## 3. 执行卡

### 🎫 P0-3-18 · 消息栏（侧栏入口 + 全屏对话页） ⚪

- **做什么**：把「对话框」从右下角浮窗升级为**一级导航 + 全屏页**，同时成为**所有系统提案的唯一出口**。三件：
  1. **侧栏新增「消息栏」**：`components/shell/sidebar.tsx` 的 `NAV` 加一项 → `{ href: "/messages", label: "消息栏", icon: MessageSquare, match: p => p.startsWith("/messages") }`。**位置：课程面板 / 我的课程 / 消息栏 / 设置与隐私**。
  2. **全屏页 `/messages` = 现有浮窗对话框的全屏版**：把 `components/course-update-fab.tsx` 的对话框内容（课程选择 + 文本/截图 + 解析 + 确认）搬进一个整页布局（左侧或顶部一条**对话流**，输入框固定在底部）。用户自己的更新、系统的提案**在同一条流里**。
  3. **系统消息同流**：Canvas 定期刷新扫到的差异（如「`Chem1A_Syllabus_Fall2026.pdf` 与我记录的 syllabus 不同」）由系统以**消息气泡**发出，带 **「确认覆盖 / 忽略」** 两级动作。确认 → 才写；忽略 → 标记 dismissed、数据不变。
- **数据**：`messages` 表（`type`: `syllabus_drift` / `practice_test` / `routine` / `material`；`payload` jsonb；`status`: `pending` / `accepted` / `dismissed`；`created_at`）。
  - **🔴【Steven 手动】**：建表 SQL 走 **Supabase SQL Editor**（项目约定：迁移不进 `supabase/migrations/` 自动执行）。执行顺序：① Bud 在对话里给出建表 SQL + RLS 判据；② **Steven 打开 Supabase Dashboard → SQL Editor 粘贴执行**；③ Bud 跑只读探针确认表存在 + RLS 就位，再写代码。**Bud 不代跑 SQL Editor。** 表列：`id` / `user_id`(fk auth.users) / `type` / `payload` jsonb / `status` / `created_at`；RLS：`using (auth.uid() = user_id)`。
- **UI 草图**：
  ```
  ┌─ Tempo ─────────┬──────────────────────────────────────────┐
  │ ▦ 课程面板       │  消息栏                                   │
  │ 📖 我的课程       │  ┌────────────────────────────────────┐  │
  │ 💬 消息栏  ← NEW │  │ ⚙ Tempo：Canvas 扫到新 syllabus，    │  │
  │ ⚙ 设置与隐私      │  │   与我记录的 3 处不同（Unit 3 Exam   │  │
  │                 │  │   从 10/20 → 10/27 …）              │  │
  │                 │  │          [确认覆盖]  [忽略]         │  │
  │                 │  └────────────────────────────────────┘  │
  │                 │  ┌────────────────────────────────────┐  │
  │                 │  │ 🧑 Steven：HW7 截止改到 9/20        │  │
  │                 │  │ ⚙ 已识别，待确认…                   │  │
  │                 │  └────────────────────────────────────┘  │
  │                 │  ┌────────────────────────────────────┐  │
  │                 │  │ 输入一条更新…  [选择图片]      [发送]│  │
  │                 │  └────────────────────────────────────┘  │
  └─────────────────┴──────────────────────────────────────────┘
  ```
- **依赖**：P0-3-17。
- **验收标准**：① 侧栏「消息栏」可点进全屏对话；② 系统提案可确认/忽略；③ 忽略不写、确认才写（ADR-015）；④ **浮窗 FAB 保留**（ADR-016：对话框是兜底不是入口，随时能 update）；⑤ 没有任何路径能「静默自动写」。
- **🔴 边界**：这是**唯一**提案出口 —— `P0-3-20` / `P0-3-23` 不许各做一套 UI（避免重复 + 守住 ADR-015）。

### 🎫 P0-3-19 · 资料索引（路线 1） ⚪

- **做什么**：同步时抓 `/courses/:id/files` + `/folders` 的**元数据**（文件名 / 类型 / 所在文件夹 / Canvas 链接 / `modified_at`），存 `course_files` 表；课程 section 加「资料」区，按 Canvas 文件夹结构分组展示、点开外链回 Canvas。
  - **不下载内容**（零解析、零隐私面、零账单）。要处理某文件时（3-20 / 3-23）才按需 `GET` 它的内容，用 `modified_at` 做差量。
  - 分类优先用 `folders` 路径；文件名（含 `Practice Exam` / `Lecture Slide` / `Answer Key`）做二级信号；模糊项才上 LLM 兜底。
- **依赖**：P0-3-18（资料发现可发消息提示「发现 N 个新文件」）。
- **验收标准**：① Chem 1A 的 `Lecture Slides/Unit 1-4`、`Practice Exams/Unit 1 Exam/Answer Keys` 在资料区按结构分组展示；② 点开外链回 Canvas；③ 受限 403 文件被跳过、sync 不挂。
- **🔴 边界**：PPTX（slides 多半是 `.pptx`）**本卡不解析**——纯文本提取效果差，留到 3-23 用视觉模型（Qwen）按需读。

### 🎫 P0-3-20 · 大纲漂移检测（路线 2） ⚪

- **做什么**：同步时**只按需抓那一个 syllabus 文件**（探针已确认 `Chem1A_Syllabus_Fall2026.pdf` 在 Files 里）→ 抽文本（PDF 文本提取成熟）→ 跟已确认的五板块 + `exam_dates` 做 diff → 差异**发进 3-18 消息栏** → Steven 确认才写。
  - 只动一个文件，可控；与 ADR-015「确认才写」完全一致，**不做自动覆盖**（覆盖会冲掉 Steven 已确认的考试日期，那是权威源）。
- **依赖**：P0-3-18、P0-3-19。
- **验收标准**：① 抓到 syllabus 内容变化 → 出差异提案（列出「新增 X / 变动 Y」）；② 接受 → 五板块/`exam_dates` 更新；③ 忽略 → 不动。
- **🔴 边界**：PDF 文本提取可能不准（扫描件）→ 提案要标「置信度」；低置信度不让一键接受。

### 🎫 P0-3-21 · study routine 生成 ⚪

- **做什么**：用 `/modules?include[]=items` 的**真实逐周课表** + syllabus 的**提交政策**，给每门课生成每周 routine。
  - 例（化学）：syllabus 说每周作业两个、周三和周一 due → routine = 周一/三/五上课 → 当天或周二四写完 → 传 Gradescope（来自作业提交政策）。
  - 走 LLM 生成，但**输入是结构化数据**（modules + syllabus 策略），不是自由发挥；结果进 3-18 消息栏确认。
- **依赖**：P0-3-18、P0-3-19（modules 数据来自 3-19 的抓取）。
- **验收标准**：① 生成「上课日 + 作业日 + 提交动作」三段式 routine；② 与 syllabus 提交政策一致；③ 进消息栏可确认。
- **🔴 边界**：routine 是**建议**，不是日程事件；不反向写 GCal（GCal 接入归 Phase 1 `#10②`，未做）。

### 🎫 P0-3-22 · 课程加权百分比 ⚪

- **做什么**：当 `assignment_groups.group_weight` **可靠映射**时，按权重算课程当前百分比（`Σ(得分/满分 × 权重) / Σ权重`）。
  - **真加权课**（Chem 1AL 5/10/60/25）显示百分比；**未启用加权课**（CHEM 1A 全 0）→ 退化为「未启用加权」提示，**不瞎算一个假百分比**。
  - 单条分数已在 3-17 显示（`score/points_possible` bar），本卡只补「课程层面汇总」。
- **依赖**：P0-3-17（单条分数已落地）。
- **验收标准**：① Chem 1AL 显示加权百分比；② CHEM 1A 显示「未启用加权」而非假百分比；③ 不依赖 `enrollments.grades`（对本人 null）。
- **🔴 边界**：Canvas 权威总分拿不到 → 我们只做「自己算的加权估计」，标清楚是估计值。

### 🎫 P0-3-23 · practice test 生成（路线 3，类型 A） ⚪

- **做什么（Steven 拍板 = 类型 A，忠实自测型）**：用户在资料区**主动选**某个 past exam + 它的 answer key → Tempo 抓内容 → **隐藏答案做成自测卷** → 可选「讲解这道题的解法」→ 结果进 3-18 消息栏。
  - **绝不**让 LLM「按 past paper 风格出新题」（类型 B 已否：物理/化学题 LLM 会出错的，错公式错数值，风险高）。
  - 几乎不幻觉，价值高，安全。
- **依赖**：P0-3-18、P0-3-19（past exam 文件来自 3-19）。
- **验收标准**：① 选 past exam + key → 生成自测卷（答案隐藏）；② 「讲解」按钮给出该题解法；③ 不出现 LLM 编造的新题。
- **🔴 边界**：PPTX slides 解析最贵（要视觉模型 Qwen）→ 本卡只处理 past exam 的 PDF/文本；slides 类留作后续实验。内容抓取用 `modified_at` 差量，不重复拉。

---

## 4. 明确不在 Phase 1（避免含糊）

| 条目 | 去向 | 理由 |
|---|---|---|
| 类型 B（LLM 出新题） | 暂不做 / 后续实验 | 物理化学题会幻觉，须校验，风险高 |
| 全量解析 slides 进 routine | 后续实验 | PPTX 解析贵且准度低，先最小范围 |
| GCal 接入 / 大 project 分解 | 见 `Phase-0-MVP.md` `#10` | 周期引擎 + restricted scope |
| 自动覆盖 syllabus | **永不**（ADR-015） | 冲掉 Steven 已确认的权威数据 |
