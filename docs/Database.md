# Database.md — Tempo 数据字典

> ⚠️ **给 Coder AI 的强制规则（最高优先级，违反即打回）**
>
> 1. 本文档规定的表名、字段名是**唯一标准**。**数据库字段一律 `snake_case`（如 `user_id`），TypeScript 代码里的变量/接口字段一律 `camelCase`（如 `userId`）**。禁止混用，禁止自创命名风格。
> 2. **本文档未定义的表和字段，一律不得创建。** 需要新增 → 先改本文档，再写迁移，再写代码（Diff First）。
> 3. **表结构只能通过 Supabase 迁移文件变更**，禁止在 Dashboard 里手动改表。迁移文件是结构的单一事实源，本文档是迁移文件的说明。
> 4. 禁止在业务代码里写裸 SQL 字符串拼接，一律用 Supabase Client 或参数化查询。
> 5. 建表后**必须启用 RLS**（Row Level Security）。没有 RLS 策略的表 = 数据裸奔，不允许上线。策略细则见 `Security-Privacy.md`。

**单一事实源关系**：`Decisions.md`（ADR）记录"为什么这么设计"，本文档记录"具体长什么样"。两者冲突时以 ADR 为准，并回来同步更新本文档。

---

## 1. 命名总原则

| 场景 | 规则 | 示例 |
|---|---|---|
| 数据库表名 | 复数、snake_case | `courses`, `grade_components` |
| 数据库字段名 | snake_case | `user_id`, `due_date`, `created_at` |
| TypeScript 变量/接口字段 | camelCase | `userId`, `dueDate`, `createdAt` |
| 布尔字段 | 以 `is_` / `has_` 开头 | `is_confirmed`, `is_derived` |
| 时间字段 | 统一 `_at` 结尾，类型 `timestamptz` | `created_at`, `last_synced_at` |
| **纯日期字段** | `_date` 结尾，类型 `date` | `exam_date`（考试日没有时区概念） |
| 主键 | 统一 `id`，类型 `uuid`，默认 `gen_random_uuid()` | — |
| 外键 | `关联表单数名_id` | `course_id` → `courses.id` |
| 枚举 | 用 `text` + `CHECK` 约束，**不用 Postgres enum 类型**（改枚举值要重建类型，迁移成本高） | `status text CHECK (status IN (...))` |
| 删除 | **一律软删除**（`is_deleted` / 状态字段），Phase 0 不做物理删除 | 见 4.4 |

**约定字段（除日志表外每张表都要有）**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | 主键 |
| `created_at` | timestamptz | 默认 `now()` |
| `updated_at` | timestamptz | 默认 `now()`，由触发器自动维护 |

---

## 2. 表清单总览

| 表名 | 职责 | Phase 0 是否建 |
|---|---|---|
| `profiles` | 用户扩展信息 | ✅ |
| `courses` | 课程 Workspace | ✅ |
| `syllabi` | Syllabus 文件与解析记录 | ✅ |
| `grade_components` | 成绩构成 | ✅ |
| `course_outline_items` | 课程大纲/章节 | ✅ |
| `exam_dates` | 考试日期（**权威源**） | ✅ |
| `office_hours` | Office Hour | ✅ |
| `submission_policies` | 提交政策 | ✅ |
| `tasks` | 统一任务列表（总览页数据源） | ✅ |
| `canvas_credentials` | Canvas 访问凭证 | ✅ |
| `sync_runs` | 同步批次日志（失败可见性的数据基础） | ✅ |
| `llm_runs` | LLM 调用审计（可插拔 provider 的度量基础） | ✅ |
| `parse_corrections` | 用户修正记录（存 diff） | ✅ |
| Phase 2+ 预留表 | 规划能力、多数据源 | ❌ 见第 8 节 |

> 相比初版，`sync_runs` / `llm_runs` / `parse_corrections` 是新增的三张表。它们不是"锦上添花"：
> - 没有 `sync_runs`，PRD F4「失败可见性」就没有数据来源，只能对用户说"同步失败"而说不出原因和时间；
> - 没有 `llm_runs`，「要不要从 DeepSeek 换 Claude」只能拍脑袋（ADR-003 的复审条件依赖它）；
> - 没有 `parse_corrections`，PRD F3「修正数据优化 prompt」存下来的会是一堆无法对比的散数据。

---

## 3. 核心表结构

### 3.1 `profiles`（用户扩展信息）

Supabase Auth 的 `auth.users` 管认证，本表放业务扩展字段，`id` 与 `auth.users.id` 一致。

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | 关联 `auth.users.id` |
| `display_name` | text | 用户显示名称 |
| `timezone` | text | 默认 `'America/Los_Angeles'`。**due date 的展示与"今天"的判定必须基于它** |
| `demo_seeded_at` | timestamptz (nullable) | Demo Workspace 生成时间，为空表示未生成 |
| `created_at` / `updated_at` | timestamptz | |

> **为什么需要 `timezone`**：Canvas 的 due date 是带时区的时间戳，而"今天要交什么"是本地日期概念。硬编码服务器时区会在学期中夏令时切换那天出错。Phase 0 用户全在伯克利，默认值够用，但字段要从第一天就有。

### 3.2 `courses`（课程 Workspace）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (FK → profiles.id) | 所属用户 |
| `semester` | text | 如 `"Fall 2026"` |
| `course_name` | text | 如 `"Math 53"` |
| `course_code` | text (nullable) | 选填 |
| `instructor_name` | text (nullable) | 选填 |
| `canvas_course_id` | text (nullable) | 关联的 Canvas 课程 ID，未关联时为空 |
| `is_demo` | boolean | 默认 `false`。Demo Workspace 复制出来的示例课程标记为 true，可一键清空 |
| `is_archived` | boolean | 默认 `false`。学期结束后归档，不删除 |
| `last_synced_at` | timestamptz (nullable) | **该课程最后一次成功同步的时间**（同步状态 UI 直接展示它） |
| `sync_status` | text | `never` / `success` / `failed`，默认 `never` |
| `sync_error` | text (nullable) | 最近一次同步失败的原因（给用户看的简短文案，不是堆栈） |
| `created_at` / `updated_at` | timestamptz | |

> `last_synced_at` / `sync_status` / `sync_error` 是**为用户可见性服务的**，不是给运维看的。总览页和课程页必须显示"最后同步于 X"，失败时显示原因 —— 这是 PRD F4 的硬性要求，静默展示旧数据是被明令禁止的（静默的旧数据比明确的错误更危险）。

### 3.3 `syllabi`（Syllabus 文件与解析记录）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `file_url` | text | Supabase Storage 中的文件地址 |
| `file_name` | text | 原始文件名 |
| `extract_method` | text (nullable) | `pdf_text` / `docx` / `pptx` / `manual`，为空表示尚未提取 |
| `extract_status` | text | `pending` / `extracted` / `failed`，默认 `pending` |
| `extract_error` | text (nullable) | 提取失败原因（如"扫描件无法提取文字"） |
| `raw_text` | text (nullable) | 提取出的原始文本。**用于调试和重新解析，也用于"先显示文本预览"的冷启动体验** |
| `page_count` | integer (nullable) | 页数，用于判断"是不是整份都没抽出来" |
| `parse_status` | text | `pending` / `processing` / `completed` / `failed`，默认 `pending` |
| `parse_error` | text (nullable) | 解析失败原因 |
| `uploaded_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz | |

> **提取（extract）与解析（parse）分成两个状态**，是因为它们会分别失败：文件能读出文字但 LLM 调用失败 ≠ 文件本身读不出。用户在界面上要看到的信息完全不同 —— 前者提示重试，后者提示手动补充。

### 3.4 `grade_components`（成绩构成）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `name` | text | 如 `"Midterm 1"` |
| `weight_percent` | numeric (nullable) | 如 `20`，**为空表示未知（不允许填 0 代替）** |
| `notes` | text (nullable) | 补充说明 |
| `is_confirmed` | boolean | 用户是否已核对确认，默认 `false` |
| `source` | text | `syllabus` / `manual`，默认 `syllabus` |
| `source_excerpt` | text (nullable) | 解析来源的 syllabus 原文片段，**用于溯源和 diff 对比** |
| `created_at` / `updated_at` | timestamptz | |

### 3.5 `course_outline_items`（课程大纲/章节）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `order_index` | integer | 排序用 |
| `week_label` | text (nullable) | 如 `"Week 3"` |
| `topic` | text | 章节主题 |
| `source` | text | 默认 `syllabus` |
| `source_excerpt` | text (nullable) | 同上 |
| `created_at` / `updated_at` | timestamptz | |

### 3.6 `exam_dates`（考试日期）—— 权威源

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `exam_name` | text | 如 `"Midterm 1"` |
| `exam_date` | date (nullable) | 为空表示 TBD |
| `exam_time` | text (nullable) | **存文本不用 `time` 类型**，因为 syllabus 里常见 `"7-9pm"` 这种不规则格式 |
| `location` | text (nullable) | |
| `status` | text | `confirmed` / `tbd`，默认 `tbd` |
| `is_confirmed` | boolean | 用户是否已核对，默认 `false` |
| `source` | text | `syllabus` / `canvas` / `manual`，默认 `syllabus` |
| `source_excerpt` | text (nullable) | |
| `created_at` / `updated_at` | timestamptz | |

> ⚠️ **本表是考试的可编辑权威源。** 同名考试在 `tasks` 里有一条派生缓存，由后端自动同步，前端**不允许用户直接编辑那条 task**。详见第 5 节（ADR-004）。

### 3.7 `office_hours`（Office Hour）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `person_name` | text | 教授/助教姓名 |
| `day_of_week` | text (nullable) | 如 `"Monday"` |
| `start_time` / `end_time` | text (nullable) | 存文本，理由同 `exam_time` |
| `location` | text (nullable) | 地点或 Zoom 链接 |
| `source` / `source_excerpt` | text (nullable) | 同上 |
| `created_at` / `updated_at` | timestamptz | |

### 3.8 `submission_policies`（提交政策）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `description` | text | 自然语言描述提交方式/迟交政策等 |
| `platform_name` | text (nullable) | 如 `"Gradescope"` |
| `source` / `source_excerpt` | text (nullable) | 同上 |
| `created_at` / `updated_at` | timestamptz | |

### 3.9 `tasks`（统一任务列表 —— 总览页核心数据源）

汇总来自 syllabus（考试）、Canvas（作业）和用户手动创建的全部任务。

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `title` | text | 任务名称 |
| `due_date` | timestamptz (nullable) | **为空表示未知/TBD，禁止用"学期末"之类的假值填充** |
| `task_type` | text | `assignment` / `exam` / `reading` / `other` |
| `source` | text | `canvas` / `syllabus` / `manual` |
| `source_id` | text (nullable) | 外部源的唯一标识，**用于去重与增量同步**。语义见下方表格 |
| `status` | text | `pending` / `done`，默认 `pending` |
| `is_derived` | boolean | 默认 `false`。`true` = 由其他表派生的缓存，用户不可直接编辑内容字段 |
| `external_updated_at` | timestamptz (nullable) | 该任务在外部源（如 Canvas）的最后更新时间，**用于判断是否需要更新** |
| `last_seen_at` | timestamptz (nullable) | 最近一次在外部源中仍然存在的时间，**用于识别"外部已删除"** |
| `is_deleted` | boolean | 默认 `false`。外部源删除的任务软删除，不物理删除 |
| `created_at` / `updated_at` | timestamptz | |

**`source_id` 的语义（按 `source` 取值不同而不同）**：

| `source` | `source_id` 存什么 | 用途 |
|---|---|---|
| `canvas` | Canvas 端 assignment ID（字符串） | 去重、增量更新 |
| `syllabus`（考试） | 对应 `exam_dates.id`（uuid 存为 text） | 与权威源对齐、去重 |
| `manual` | `null` | 无外部标识 |

**唯一性约束（去重的关键，必须建）**：

```sql
CREATE UNIQUE INDEX tasks_source_unique
  ON tasks (course_id, source, source_id)
  WHERE source_id IS NOT NULL;
```

> 没有这个索引，同步重试会产生重复任务 —— 这是"总览页出现三个一模一样的作业"这类 bug 的唯一根因。

### 3.10 `canvas_credentials`（Canvas 访问凭证）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (FK → profiles.id) | |
| `secret_encrypted` | text | **加密后的凭证**，绝不存明文。存什么取决于 `credential_type` |
| `credential_type` | text | `pat`（Phase 0 默认）/ `ical` / `oauth`。后两者为 Plan B 与 Phase 1 预留 |
| `canvas_domain` | text | 如 `"bcourses.berkeley.edu"` |
| `expires_at` | timestamptz (nullable) | **凭证过期时间。取自用户实际填写的过期时间，不写死任何默认值** |
| `status` | text | `active` / `expired` / `revoked` / `error`，默认 `active` |
| `last_used_at` | timestamptz (nullable) | 最后一次成功调用 Canvas 的时间 |
| `last_error_at` | timestamptz (nullable) | 最近一次失败时间 |
| `last_error_message` | text (nullable) | 最近一次失败原因（给用户看的简短文案） |
| `revoked_at` | timestamptz (nullable) | 用户主动撤销的时间 |
| `created_at` / `updated_at` | timestamptz | |

**关于 `expires_at` 的重要事实（不要凭印象写）**：

- Canvas 学生角色的 token，过期时间是**强制必填**的，不是选填。
- 上限随 Instructure 政策变动，**当前约 120 天**（更早是 30 天，也曾普遍被写成 90 天 —— 那是个过时的数字）。
- 因此：**不要**在代码里写"默认 90 天后过期"，**不要**在用户没填时用一个估算值兜底。用户填什么就存什么，没填就存 `null` 并按"未知"处理。
- 提醒逻辑基于用户实际填写的 `expires_at`，提前 14 天开始提醒。

> **字段名变更说明**：初版此表字段名为 `access_token_encrypted`，现改为 `secret_encrypted`。理由是这张表将来要同时承载 PAT（存 token）、iCal（存 feed URL）、OAuth（存 refresh token）三种凭证，用 "access_token" 命名会限制它。项目尚未写码，现在改零成本。

### 3.11 `sync_runs`（同步批次日志）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (FK → profiles.id) | |
| `trigger_type` | text | `app_open` / `manual` / `scheduled` |
| `status` | text | `running` / `success` / `partial` / `failed` |
| `courses_synced` | integer | 本次成功同步的课程数，默认 0 |
| `tasks_created` / `tasks_updated` / `tasks_deleted` | integer | 变更量统计，默认 0 |
| `error_message` | text (nullable) | 失败原因（面向用户的简短文案） |
| `started_at` | timestamptz | |
| `finished_at` | timestamptz (nullable) | |

用途：① 课程页/总览页显示"最后一次成功同步时间"；② 用户撤销前的排障依据；③ 判断"某个用户是不是从来没同步成功过"。

### 3.12 `llm_runs`（LLM 调用审计）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (nullable, FK → profiles.id) | |
| `purpose` | text | `syllabus_parse` / `syllabus_reparse` 等 |
| `syllabus_id` | uuid (nullable, FK → syllabi.id) | 关联被解析的文件 |
| `provider` | text | `deepseek` / `claude`（来自 `lib/llm` 抽象层） |
| `model` | text | 具体模型名 |
| `prompt_version` | text | prompt 版本号，如 `v1`。**修正数据要能归因到具体 prompt 版本** |
| `input_tokens` / `output_tokens` | integer (nullable) | |
| `latency_ms` | integer (nullable) | |
| `status` | text | `success` / `failed` |
| `error_message` | text (nullable) | |
| `created_at` | timestamptz | |

> 这是 ADR-003 复审条件的度量基础："DeepSeek 解析准确率不足 → 切 Claude"不能靠感觉判断，得有 provider / 模型 / token / 耗时的数据。
> `provider` 字段来自 `lib/llm` 抽象层，**业务代码禁止直接 import 厂商 SDK**（见 `TechStack.md` 第 5 节）。

### 3.13 `parse_corrections`（用户修正记录）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (FK → profiles.id) | |
| `syllabus_id` | uuid (nullable, FK → syllabi.id) | |
| `llm_run_id` | uuid (nullable, FK → llm_runs.id) | 归因到哪次解析 |
| `entity_type` | text | `grade_component` / `exam_date` / `outline_item` / `office_hour` / `submission_policy` |
| `entity_id` | uuid | 被修正的记录 ID |
| `field_name` | text | 被修正的字段，如 `weight_percent` |
| `original_value` | text (nullable) | AI 解析出的原值 |
| `corrected_value` | text (nullable) | 用户修正后的值 |
| `correction_type` | text | `edit` / `delete` / `add` |
| `created_at` | timestamptz | |

> **为什么必须存 diff 而不是只存最终结果**：只存最终结果，将来你手上是一堆"正确的值"，看不出 AI 到底错在哪、错在哪个字段、错在哪类课程。"优化 prompt"需要的是**错误模式**，不是正确答案。
> 实现上：在保存编辑的接口里，把变更前后的值对比后写入本表，一条记录对应一个被修改的字段。

---

## 4. 同步语义（Tempo 内核的数据层约定）

这一节是「实时检测 + 动态管理」在数据模型上的落点。轮询频率、触发时机、重试策略在 `Sync-Strategy.md` 里定义，本节只规定**数据怎么写**。

### 4.1 字段覆盖规则（防止用户改动被同步吃掉）

| `source` | 同步时可覆盖的字段 | 用户可改、且**不会被覆盖**的字段 |
|---|---|---|
| `canvas` | `title`、`due_date`、`external_updated_at`、`last_seen_at`、`is_deleted` | `status`（标记完成） |
| `syllabus`（派生考试） | `title`、`due_date`（由 `exam_dates` 派生） | 无 —— **改考试请改 `exam_dates`** |
| `manual` | 不参与同步 | 全部 |

> 这条规则的反面同样重要：**不要整行 `upsert` Canvas 任务**，否则用户刚勾掉的"已完成"会在下次同步时被打回 `pending`。这是这类应用最常见的体验 bug。

### 4.2 增量同步判定

```
若 external_updated_at 未变 且 内容未变 → 跳过，不写库（不刷 updated_at）
若 external_updated_at 变化 或 内容不同 → 更新，并记录 parse_corrections 无关，但计入 sync_runs 统计
```

好处：`updated_at` 真实反映"这条数据什么时候真的变过"，而不是"什么时候被同步扫到过"。

### 4.3 删除处理（外部源删了作业）

```
本次同步未在某个任务上出现，且 source='canvas'
  → 不物理删除
  → 标记 is_deleted = true（UI 隐藏，数据保留）
理由：老师误删后恢复的情况很常见；物理删除会造成"任务凭空消失"的困惑，
      而困惑正是 Tempo 要消除的东西。
```

### 4.4 通用软删除约定

Phase 0 所有用户可见实体（课程、任务、考试等）一律软删除。物理删除只用于：用户主动请求"删除我的全部数据"（见 `Security-Privacy.md`）。

---

## 5. 派生规则：exam_dates ↔ tasks（ADR-004 落地）

**这是本文档最重要的一条规则，写错会导致"课程页日期和总览页日期对不上"。**

### 5.1 规则

| 项 | 规定 |
|---|---|
| 权威源 | **`exam_dates` 是可编辑的权威源** |
| 派生缓存 | `tasks` 中 `source='syllabus'` 且 `task_type='exam'` 的记录是**派生缓存** |
| 关联键 | 该 task 的 `source_id` = 对应 `exam_dates.id`（uuid 存为 text） |
| 标记 | 该 task 的 `is_derived = true` |
| 同步方向 | **单向**：`exam_dates` → `tasks`。反向同步禁止 |
| 触发时机 | `exam_dates` 新增 / 编辑 / 删除时，由后端同步更新对应 task |
| 前端约束 | 用户**不允许直接编辑** `is_derived = true` 的 task 的内容字段（`title` / `due_date`）。要改考试 → 打开课程页改 `exam_dates` |
| 用户可改 | 仅 `status`（标记完成） |

### 5.2 派生映射

| `exam_dates` 字段 | → `tasks` 字段 |
|---|---|
| `exam_name` | `title` |
| `exam_date` + `exam_time` | `due_date`（时间部分无法解析时，取当日 23:59 或留 `due_date` 为仅日期） |
| `status = 'tbd'` 或 `exam_date IS NULL` | `due_date = null`（**禁止编造一个日期**） |
| — | `task_type = 'exam'` |
| — | `source = 'syllabus'` |
| — | `source_id = exam_dates.id`，`is_derived = true` |

### 5.3 为什么保留两张表而不是合并

`exam_dates` 有考试专属字段（`exam_time`、`location`、`status=tbd`），且需要在课程页做结构化展示；`tasks` 需要轻量统一以便总览页合并排序。合并成一张表会让总览页查询背上一堆无关字段，也会让"考试"这个实体失去自己的语义。

**代价**：必须严格维护上面这条单向派生规则。为降低出错概率，同步逻辑写在**一处**（后端 `syncExamToTask()` 函数），禁止在各个业务分支里零散地写 `insert into tasks`。

---

## 6. 表关系简图

```
profiles (1) ──< courses (多个课程)
courses  (1) ──< syllabi
courses  (1) ──< grade_components
courses  (1) ──< course_outline_items
courses  (1) ──< exam_dates ──派生──> tasks (is_derived=true)
courses  (1) ──< office_hours
courses  (1) ──< submission_policies
courses  (1) ──< tasks
profiles (1) ──< canvas_credentials
profiles (1) ──< sync_runs
profiles (1) ──< parse_corrections
syllabi  (1) ──< llm_runs
llm_runs (1) ──< parse_corrections
```

**外键级联**：`courses` 删除时，其下所有子表记录 `ON DELETE CASCADE`。`canvas_credentials` / `sync_runs` / `parse_corrections` 挂在 `profiles` 下，用户删除时级联。

---

## 7. 索引与 RLS

### 7.1 必须建的索引

```sql
-- 课程按用户查（最高频）
CREATE INDEX idx_courses_user_id ON courses(user_id);

-- 任务按课程查 + 按 due_date 排序（总览页主查询）
CREATE INDEX idx_tasks_course_id ON tasks(course_id);
CREATE INDEX idx_tasks_due_date ON tasks(due_date) WHERE is_deleted = false;

-- 去重唯一索引（见 3.9，必须建）
CREATE UNIQUE INDEX tasks_source_unique
  ON tasks(course_id, source, source_id) WHERE source_id IS NOT NULL;

-- 各子表按课程查
CREATE INDEX idx_grade_components_course_id ON grade_components(course_id);
CREATE INDEX idx_exam_dates_course_id ON exam_dates(course_id);
CREATE INDEX idx_outline_items_course_id ON course_outline_items(course_id);

-- 同步日志按用户 + 时间倒序
CREATE INDEX idx_sync_runs_user_started ON sync_runs(user_id, started_at DESC);
```

### 7.2 RLS（概要，细则见 `Security-Privacy.md`）

- 每张业务表 `ENABLE ROW LEVEL SECURITY`。
- `profiles` / `canvas_credentials` / `sync_runs` / `parse_corrections`：策略基于 `auth.uid() = user_id`。
- `courses` 及其子表：策略基于**通过 `courses` 反查 `user_id`**（子表没有直接的 `user_id`）。
- **验收标准**：用两个测试账号交叉验证，A 账号通过任何接口都取不到 B 账号的任何一行数据（P0-0-5）。

---

## 8. Phase 2+ 预留（本次不建表）

以下内容 Phase 0 **不建**，但命名如已涉及类似概念请提前保持风格一致，将来用迁移新增：

| 表/字段 | 用途 | 所属阶段 |
|---|---|---|
| `study_plans` / `plan_items` | 长期任务的每日拆解（"这门课的期末复习怎么分到 14 天"） | Phase 2 |
| `tasks.planned_date` / `estimated_minutes` | 每日任务规划的落点 | Phase 2 |
| `progress_snapshots` | 进度检测的历史快照（内核"检测"能力的时间维度） | Phase 2 |
| `data_sources` / `source_connections` | 多数据源泛化：Google Calendar、CalCentral、iCal、课程网页 | Phase 1 |
| `canvas_credentials.credential_type = 'oauth'` | Phase 1 正式 OAuth（含 `refresh_token`、`token_type`、`scope`） | Phase 1 |
| `past_papers` / `course_reviews` | Phase 4 资源 Hub（注意：涉及版权与 FERPA，见 `Security-Privacy.md`） | Phase 4 |

**注意**：Phase 0 的 `tasks.source` 枚举只有 `canvas` / `syllabus` / `manual`。将来接入 Google Calendar 时，直接增加枚举值即可，**不改表结构** —— 这是当初选择 `text + CHECK` 而非 Postgres enum 类型的原因。

---

## 9. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-09-01 | 初版：10 张表 | — |
| 2026-09-01 | 重写：新增 `sync_runs` / `llm_runs` / `parse_corrections`；新增派生规则章节（ADR-004）；新增同步语义章节；`courses` 增同步状态字段；`tasks` 增 `is_derived` / `external_updated_at` / `last_seen_at` / `is_deleted`；`canvas_credentials` 字段改名与状态机；token 有效期修正 | ADR-001（内核）、ADR-003（LLM 可插拔）、ADR-004（派生）、ADR-005（同步）、PRD F3/F4 |
