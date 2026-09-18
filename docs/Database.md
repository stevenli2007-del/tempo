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
| `usage_events` | 行为事件埋点（7 日回访 / token 续期完成率） | ✅（P0-3-1 新增） |
| `course_files` | 课程资料索引（Canvas 文件**元数据**，P0-3-19） | ✅（P0-3-19 新增） |
| `file_summaries` | 单文件「一键总结」缓存（结构化提要，**不含课件原文**，P0-3-19b） | ✅（P0-3-19b 新增） |
| `email_inbound_events` | 邮件入站事件账（按退订 token 定位用户 + webhook 动作审计，仅本人可读 / service_role 写） | ✅（P0-3-11 新增） |
| `messages` | 消息栏 · 系统提案收件箱（`type` 白名单 + `payload jsonb`，`pending/accepted/dismissed/undone`） | ✅（P0-3-18 新增，P0-3-26 扩 `undone`） |
| `course_announcements` | Canvas 公告进站账（去重键 `course_id + canvas_announcement_id`，`body_text` 只存清洗后纯文本） | ✅（P0-3-25 新增） |
| `message_summaries` | 公告 AI 要点缓存（`ok`/`failed` 都落行，failed = 防重试账） | ✅（P0-3-25b 新增） |
| `practice_tests` | 自测卷缓存（唯一键 `exam_file_id`，一份卷只有一张有效自测卷） | ✅（P0-3-23 新增） |
| `practice_test_explanations` | 逐题讲解缓存（PK `(practice_test_id, question_key, locale)`） | ✅（P0-3-23 新增） |
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
>
> 🔴 **强制约束（2026-09-13 补，此前实现没遵守）**：**所有日期展示与"今天"的判定必须读 `profiles.timezone`，禁止硬编码 `'UTC'`**。
> 反例：`app/(routes)/dashboard/page.tsx:54-59` 用固定 `timeZone:'UTC'` 渲染日期标签 —— 那条注释里"按 UTC 取日期不会差一天"的论证**只对考试派生任务成立**（`exam-tasks.ts:94` 硬编码 `T23:59:59`，恰好落在 UTC 当日），对 Canvas 的真实 `due_at`（`2026-09-09T23:59 PDT` = `2026-09-10T06:59Z`）**必然差一天**。而作业几乎都在晚上截止 → **几乎全部显示晚一天**。修复归 P0-3-10。

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
| **`files_scanned_at`** | timestamptz (nullable) | **资料区（`course_files`）最后一次被扫描的时间**（P0-3-19 新增），见下方说明 |
| **`syllabus_file_id`** | uuid (nullable, FK → `course_files.id` ON DELETE SET NULL) | **本课认定的那份 syllabus 文件**（P0-3-20 新增）。取值只能来自 `course_files` 里含 syllabus/大纲 的条目，由 `pickSyllabusFile()` 全序挑出 |
| **`syllabus_seen_modified_at`** | timestamptz (nullable) | **上次核对到的文件版本**（P0-3-20 新增）—— 存的是 `course_files.modified_at`，**不是核对时刻** |
| `created_at` / `updated_at` | timestamptz | |

> 🔴 **`files_scanned_at` 与 `last_synced_at` 不是一个东西，别混用**：
> - `last_synced_at` = 「数据停留在什么时候」，**只在同步成功时推进**（UI 直接展示它）；
> - `files_scanned_at` = 「资料区上次**扫过**是什么时候」，是**扫描节流**时间戳 ——
>   它不承诺数据新鲜（实测 14 门课里 8 门压根没有 Files 区，扫了也是空）。
>   命名刻意叫 "scanned" 而不是 "synced"，就是为了不被读成前者的同类。
>   资料区每门课 2 个 Canvas 请求，而单次同步只有 20 个预算（Sync-Strategy §5），
>   所以走 **24 小时**独立节奏（手动刷新除外），详见 `lib/sync/canvas-files.ts`。

> 🔴 **`syllabus_seen_modified_at` 存的是「文件版本」，不是「我们上次什么时候查的」**（P0-3-20）：
> 它的值**逐字来自** `course_files.modified_at`，所以「锚点 ≠ 当前值」这一个比较就等价于「文件内容变过」。
> 若存成 `now()`（核对时刻），第一次比较就永远不等 → **每一轮同步都会报"大纲变了"**（纯噪音），
> 而真正的变更反而分辨不出来。配套：**内容变更看 `modified_at`，不是 `updated_at`**
> （同一文件实测差 1.5 小时，`updated_at` 动的是元数据）—— 见 `CodingRules.md` §10.2。
>
> 两列的分工：`syllabus_file_id` 回答「**认哪一份文件**」，`syllabus_seen_modified_at` 回答「**认到哪个版本**」。
> 首次核对与换文件都只**记基线、不提案**（两份不同文档之间没有共同锚点，「变了」在语义上不成立）。
> 锚点**不是**"已通知过用户"的凭据 —— 顺序刻意是**锚点先推进、消息后建**：消息建失败时那一次变更会
> 永久丢失，换来的是**绝不重复投同一条提案**（与 3-25 的 `insertAnnouncementMessage` 同一条取舍）。
> 另外这两个字段的新鲜度**等于资料索引的新鲜度（24 小时）**：老师改完 syllabus 最长一天后才被发现，
> 这是刻意的取舍（分钟级新鲜度要每轮下载 PDF，换掉的是主同步预算与 ADR-026 的红线）。
>
> `last_synced_at` / `sync_status` / `sync_error` 是**为用户可见性服务的**，不是给运维看的。总览页和课程页必须显示"最后同步于 X"，失败时显示原因 —— 这是 PRD F4 的硬性要求，静默展示旧数据是被明令禁止的（静默的旧数据比明确的错误更危险）。
>
> 🔴 **`last_synced_at` 只在同步成功时推进**（P0-2-7 修正）。P0-2-5 的实现是失败也写这一列，与本行的定义（"最后一次**成功**同步的时间"）冲突：失败后它指向**失败那一刻**，UI 展示成"最后同步于 1 分钟前"，而屏幕上的其实是几天前的旧数据 —— 正是 Sync-Strategy §9 禁止的那一条。现在的写法：失败只更新 `sync_status` / `sync_error`，`last_synced_at` 保持上一次成功的值（`toSyncStateUpdate({ lastSyncedAt: null })` 即不输出该列）。**代价**：不再记录"最后一次尝试同步的时间"，需要时读 `sync_runs.started_at`。

### 3.3 `syllabi`（Syllabus 文件与解析记录）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id) | |
| `file_url` | text | **Storage 对象路径**（`{user_id}/{course_id}/{syllabus_id}.{ext}`），**不是可直接 fetch 的 URL** —— 见下方说明 |
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

> ⚠️ **`file_url` 存的是对象路径，不是 URL**（2026-09-02 澄清，P0-1-1）。
> 桶 `syllabi` 是私有的，**不存在永久可访问的 URL**；签名 URL 会过期（本项目签 60 秒）。所以这里只能存路径，取文件时用 `storage.from('syllabi').createSignedUrl(file_url, 60)` **现签现用**。
> 字段名沿用初版的 `file_url` 未作改名 —— Phase 0 无存量数据，改名成本极低，**若 Steven 认为 `storage_path` 更少歧义，一句话即可改**（一处迁移 + 本文件 + `lib/syllabi.ts`）。

> ⚠️ **「上传未完成」的悬挂行**（P0-1-1 已知留白，**P0-1-2 已实现兜底**）：直传模式下先建行、后传文件（ADR-009），若上传中断会留下一条 `extract_status='pending'` 但没有实际文件的行。Phase 0 不额外做对账清理 —— 判定信号是 `createSignedUrl` 对不存在的对象返回 `StorageApiError { statusCode: '404', code: 'NoSuchKey' }`，extract 端点据此把该行置为 `extract_status='failed'` + 原因，并返回 **409 `file_missing`**（不是 500）。

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
| `status` | text | `pending` / `done`，默认 `pending`。**用户主权字段 —— 同步永不写**（ADR-015） |
| **`submission_state`** | text (nullable) | **外部源（Canvas）侧的提交真相，同步可写**（P0-3-10 新增）。取值见下表 |
| **`submitted_at`** | timestamptz (nullable) | 提交时间，仅作"何时交的"这一可信陈述（P0-3-10 新增） |
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

**`submission_state` 的语义（P0-3-10 新增，ADR-015）**

```sql
submission_state text CHECK (submission_state IN
  ('unsubmitted','submitted','pending_review','graded','missing','external_unconfirmed'))  -- nullable
```

映射 Canvas `submission.workflow_state`（与 `lib/sync/canvas-tasks.ts` 的 `deriveSubmission` 一一对应）：

| Canvas 侧情形 | `submission_state` | UI 展示 |
|---|---|---|
| `graded` | `graded` | 已完成区（标「已提交（Canvas）」） |
| `submitted`（未评分） | `submitted` | **已提交（待评分）** |
| `pending_review`（待查重） | `pending_review` | 已提交 |
| `unsubmitted` **且** Canvas 标 `missing` | `missing` | **逾期未交**（区别于"逾期未完成"） |
| `unsubmitted`（非外链类） | `unsubmitted` | 待办 + 已逾期 |
| **`external_tool`（Gradescope 等 LTI）的"未交"信号** —— `unsubmitted` / `missing` | `external_unconfirmed` | **待确认（外部平台提交）** 🔴 **不得显示"待完成"** |
| **`external_tool` 且完全无提交记录** | `external_unconfirmed` | **待确认（外部平台提交）** 🔴 同上 |
| `none` / `not_graded` / `on_paper`（考勤、纸质） | `null` | 无完成态概念 → 保留手勾 |
| 其他未知态（`excused` 等）／无记录且非外链 | `null` | 保守当"无记录" → 保留手勾 |

> 🔴 **`external_tool` 的信号必须分方向**：**正信号**（`graded`/`submitted`/`pending_review`）是 LTI 回传的**事实**，照常采信；
> **负信号**（`unsubmitted`/`missing`）是 Canvas 的**推断** —— 它看不见 Gradescope 里的提交动作，只等成绩回传。
> 实测（2026-09-13）：Chem 1AL「Lab 1: Airbags」(due 9/9) 在 Gradescope 已交，Canvas 仍报 `unsubmitted`。
> 拿它渲染"未完成/已逾期"就是**诬告用户**（ADR-013），故一律降级为「待确认」。

> 🔴 **展示层合并规则**：`status='done'` **或** `submission_state ∈ {submitted, graded}` → 归入已完成区。**不写回 `status`** —— 两个字段分列的意义就是让"外部真相"与"用户判断"永不互相覆盖。
> 🔴 **不可逆要分方向**：用户手勾的 `done` **永不回退**；Canvas 自身状态**允许回退**（老师撤回 / 重设时照搬真相）。写成同一条规则必然错一边。
> ⚠️ **`submission_types` 决定有没有"提交"这回事**：`discussion_topic`（讨论类）没有传统提交；`none` / `not_graded` / `on_paper`（考勤打卡、纸质作业）**没有可信的提交语义** —— 这类永远保留手勾，不能被自动判成未完成。
> （2026-09-13 实测：这类作业 Canvas 其实也带 `workflow_state`，但它的含义取决于"你到场了没 / 纸质作业交给助教了没"，自动采信照样会误判 → 仍保留手勾。）

### 3.10 `canvas_credentials`（Canvas 访问凭证）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (FK → profiles.id) | |
| `secret_encrypted` | text | **加密后的凭证**，绝不存明文。存什么取决于 `credential_type` |
| `credential_type` | text | `pat`（Phase 0 默认）/ `ical` / `oauth`。后两者为 Plan B 与 Phase 1 预留 |
| `canvas_domain` | text | 如 `"bcourses.berkeley.edu"` |
| `expires_at` | timestamptz (**NOT NULL**) | **凭证过期时间。取自用户实际填写的过期时间（强制必填，无 fallback）。**2026-09-04 P0-2-1b 实测上限 90 天 |
| `status` | text | `active` / `expired` / `revoked` / `error`，默认 `active` |
| `last_used_at` | timestamptz (nullable) | 最后一次成功调用 Canvas 的时间 |
| `last_error_at` | timestamptz (nullable) | 最近一次失败时间 |
| `last_error_message` | text (nullable) | 最近一次失败原因（给用户看的简短文案） |
| `revoked_at` | timestamptz (nullable) | 用户主动撤销的时间 |
| `created_at` / `updated_at` | timestamptz | |

**关于 `expires_at` 的重要事实（不要凭印象写）**：

- Canvas 学生角色的 token，过期时间是**强制必填**的，不是选填（bCourses "+ New Access Token" 弹窗 Expiration date + Expiration time 均带 `*`，2026-09-04 P0-2-1b 实测）。
- 上限 **90 天**（2026-09-04 P0-2-1b 实测，弹窗原文 "Maximum expiration is 90 days."）。
- 因此：**不要**凭印象写任何默认天数兜底。用户填什么就存什么，库内 `expires_at` 必有值（NOT NULL）。
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

### 3.14 `usage_events`（行为事件埋点，P0-3-1 新增）

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `user_id` | uuid (FK → profiles.id, **ON DELETE CASCADE**) | 所属用户 |
| `event_type` | text | `dashboard_view` / `expiry_reminder_shown` / `credential_renewed` |
| `created_at` | timestamptz | 事件发生时间（默认 `now()`） |

**它只为 PRD 8.1 四项指标里的两项而建。** 另外两项早就有数据了 —— 编辑修正率读 `parse_corrections`、人均关联课程数读 `courses.canvas_course_id`。**为已经能算出来的指标再埋一遍点，只会造出两份口径。**

| 事件 | 写入点 | 服务于 |
|---|---|---|
| `dashboard_view` | dashboard 服务端组件每次渲染（`lib/usage-events.ts`） | 7 日回访次数 |
| `expiry_reminder_shown` | 过期横幅**真的会展示**时（`level !== 'ok'`），同一 UTC 日最多一条 | token 续期完成率的分母 |
| `credential_renewed` | `POST /api/v1/canvas/credentials` 覆盖**已有**凭据时（首次连接不算续期） | token 续期完成率的分子 |

> **三个刻意取舍**
> 1. **不预留"将来可能想看"的事件类型。** 加了没人用的枚举值，这张表就会变成垃圾桶 —— 而且 CHECK 约束每加一个值都要改迁移。
> 2. **埋点失败只告警、绝不抛错**（`lib/usage-events.ts` 吞掉所有异常，见 CodingRules）。度量不是功能，表没迁移 / RLS 写不进都不该让总览页白屏。
> 3. **反向：读数时必须报错，不能静默给 0。** `GET /api/v1/metrics` 在表缺失时返回 500 —— 静默的 0 会被读成"用户一次都没回来"，那是比报错危险得多的假信号。
>
> **写入频率**：`dashboard_view` 按渲染次数写（含同步成功后的 `router.refresh()`，刷一次算一次）；7 日回访的对照口径 `activeDays`（同一天只算一次）由 `lib/metrics.ts` 在读取时去重算出来，不额外存。
>
> ⚠️ **P0-3-2 删账号的级联范围要带上本表**（`user_id` 已 `ON DELETE CASCADE`，删 `profiles` 行即清空；此处显式写出，避免 P0-3-2 只照着旧清单删而漏掉它）。

### 3.15 `course_files`（课程资料索引，P0-3-19 新增）

Canvas 课程 Files 区的**目录**：文件名、所在文件夹、外链、大小、内容修改时间。

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid (PK) | |
| `course_id` | uuid (FK → courses.id, **ON DELETE CASCADE**) | 所属课程（本表无 `user_id`，RLS 通过 `courses` 反查） |
| `canvas_file_id` | text | Canvas 侧文件 ID，去重的唯一依据 |
| `display_name` | text | 展示名（Canvas `display_name`；**不是** URL 编码的 `filename`） |
| `content_type` | text (nullable) | MIME；null = Canvas 没给（**不是"未知类型"**） |
| `size_bytes` | bigint (nullable) | 字节数，只用于展示；null = Canvas 没给（**不是 0**） |
| `folder_path` | text | Canvas 文件夹相对路径（已剥根前缀 `course files/`）；**空串 = 根目录** |
| `file_url` | text | 指回 Canvas 的文件**预览页**（不是下载链，理由见下） |
| `modified_at` | timestamptz (nullable) | Canvas `modified_at`，**3-20 / 3-23 按需抓内容的差量依据** |
| `is_deleted` | boolean | 默认 `false`。Canvas 上被删 → 软删除，不物理删 |
| `created_at` / `updated_at` | timestamptz | |

**唯一性约束（去重的关键，必须建）**：

```sql
CREATE UNIQUE INDEX course_files_course_file_unique
  ON course_files (course_id, canvas_file_id);

-- 资料总结（P0-3-19b）：读取路径永远是「按 course_file_id + locale 取一行」，
-- 主键已覆盖，**不另建索引**。要按课程统计"总结了几份"时再加。
```

> 🔴 **只存元数据，绝不存内容**。本表**没有任何一列**能装文件内容：没有 bytea、没有正文 text、没有 storage 路径。
> 要读某个文件的内容是 3-20（大纲漂移）/ 3-23（practice test）的事，且那时才按 `modified_at` 差量去取那**一个**文件。
>
> 🔴 **`file_url` 必须是拼出来的预览页，不能用 Canvas 返回的 `url`**。
> `/files` 给的 `url` 形如 `/files/{id}/download?download_frd=1&verifier=<uuid>` —— 它是一个**能力 URL**：
> 实测（2026-09-18，做 P0-3-19b 时重测）**不带任何 token 也能 200 拿到 `application/pdf`**，
> 也就是说**拿到这条 URL 就等于拿到那个文件的下载权**。
> 所以它**既不能落库、也不能下发给浏览器**：存了 = 库里躺着一把能开课件的钥匙；
> 下发了 = 任何能读页面源码的人都能绕过 Canvas 的登录去下课件。
> 正确形态是**拼出来**的 `https://{domain}/courses/{canvas_course_id}/files/{file_id}`（实测 200，走 Canvas 自己的登录）。
> 四个候选的实测对照见 `lib/canvas/files.ts` 的 `filePreviewUrl`。
>
> ⚠️ 这与「裸 `/files/{id}`（没有 verifier）→ 401」不矛盾：401 的是**没有能力凭据的裸链**，
> 200 的是**带 verifier 的能力链**。两件事，别混。
>
> 🔴 **学生看不见的不索引**：`locked` / `hidden` / `locked_for_user` / `hidden_for_user` 任一为真的文件，
> 以及落在不可见文件夹里的文件（实测 Chem 1AL：55 个文件夹里 24 个 hidden、57 个文件里 2 个 restricted）。
> ⚠️ Canvas 的 `hidden` 实测是 **`null` 而不是 `false`**（表示未隐藏），必须判 `=== true`。
>
> ⚠️ **P0-3-2 删账号的级联**：`course_id` 已 `ON DELETE CASCADE`，删课程即清空本课程的资料索引。

### 3.16 `file_summaries`（单文件「一键总结」缓存，P0-3-19b 新增）

用户在某个文件上点「一键总结」后，模型给出的**结构化提要**（概述 / 要点 / 公式术语）。
一份文件 + 一种语言一行，一次生成永久复用。

> 🔴 **它不存课件内容**。`summary` 列里只有**模型生成的概述与要点**；
> 抽出来的文本只存在于那次请求的内存里，**不落库、不进 Storage**。
> 「不下载内容」这条红线在 3-19 里指的是**索引路径**（同步时一个字节都不下）——
> 按需路径允许读**那一个**文件，但读到的原文不留副本。见 **ADR-026**。

| 字段名 | 类型 | 说明 |
|---|---|---|
| `course_file_id` | uuid (FK → course_files.id, **ON DELETE CASCADE**, PK 之一) | 归属（本表无 `user_id`，RLS 经 `course_files → courses` 反查） |
| `locale` | text (PK 之一) | 总结语言（`zh-CN` / `en`，白名单在 `lib/course-files/summary/locale.ts`）。**无 CHECK** —— 它只是数据标签，加语言不该被迁移卡住 |
| `status` | text | `ok` / `failed`（有 CHECK，因为它是**代码分支**）。`failed` 行保留的意义 = **别再重试** |
| `summary` | jsonb | `{ overview, points[], formulas[] }`。**只含模型输出，绝不含原文** |
| `source_chars` | integer | 抽取到多少字符（截断前） |
| `source_truncated` | boolean | 是否因过长被截断 —— 为真时界面**必须**标「不覆盖全篇」 |
| `page_count` | integer (nullable) | PDF 页数；docx / pptx 为 null（**不是 0**） |
| `extract_method` | text (nullable) | 用了哪个抽取器（`pdf_text` / `docx` / `pptx`） |
| `source_modified_at` | timestamptz (nullable) | 生成时该文件在 Canvas 的 `modified_at`；与当前值不同 = 老师换过文件 = **重算** |
| `model` | text (nullable) | 实际服务的模型名（同 `llm_runs` 的纪律：记实际值，不记别名） |
| `error_message` | text (nullable) | 失败原因（精简、**不含课件内容**） |
| `created_at` / `updated_at` | timestamptz | |

**主键**：`PRIMARY KEY (course_file_id, locale)` —— 并发点开或流式渲染重入时靠它收敛，
不会出现「同一份文件两条总结」。

> 🔴 **失败也落一行**（`status = 'failed'`）：缓存表的第二职责是"别反复重试"。
> 但只有**确定性失败**才落行（扫描件没有文字层、模型稳定给不出结果）；
> **暂时性失败**（Canvas 5xx / 网络断 / 超时 / 凭据失效）**不落行** ——
> 那是"我这次没做到"，不是"这份材料做不了"（与 `message_summaries` 同一区分）。
> 要重新试一次就 `delete from file_summaries where status = 'failed'`。
>
> ⚠️ **P0-3-2 删账号的级联**：经 `course_files → courses` 两级 `ON DELETE CASCADE`，
> 删账号（删 `profiles` → 删 `courses`）即清空本表。

---

### 3.17 `practice_tests`（自测卷缓存，P0-3-23 新增）

用户在课程资料区选中一份 past exam（Tempo 自动配对它的 answer key）后，模型**切出来的卷面**
（题干 + 每题的答案）。一份试卷一行，一次生成永久复用。

> 🔴 **这里没有课件原文**。`paper` 列里只有**切出来的题干与答案**——两份 PDF 的抽取全文
> 只存在于那次请求的内存里，**不落库、不落盘、不进日志**。3-19 的「不下载内容」管的是
> **索引路径**（同步仍然零下载）；本卡是**按需路径的第二条开口**（第一条是 3-19b 的一键总结），
> 读的是**用户自己点的那两份**文件。见 **ADR-027**。

| 字段名 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `course_id` | uuid (FK → courses.id, **ON DELETE CASCADE**) | 归属（本表无 `user_id`，RLS 经 `courses` 反查） |
| `exam_file_id` | uuid (FK → course_files.id, **ON DELETE CASCADE**, **UNIQUE**) | 试卷本体。唯一键落在这里：**一份试卷永远只有一张当前有效的自测卷** |
| `answer_key_file_id` | uuid (FK → course_files.id, **ON DELETE SET NULL**) | 配对到的答案文件（可空）。**刻意非 CASCADE** —— 答案被删时卷子不该跟着消失 |
| `pairing_rule` | text (nullable) | 靠哪条规则配到的（`answer-key-folder` / `solution-folder` / `same-folder-key-name` / `same-stem-anywhere`）。配错时靠它区分「代码错」与「数据长得怪」 |
| `title` | text | 卷面标题（模型起的；没给就用文件名） |
| `status` | text | `ok` / `failed`（有 CHECK，因为它是**代码分支**）。`failed` 行保留的意义 = **别再重试** |
| `paper` | jsonb | `{ title, questions: [{ key, number, text, answer }] }`。`answer: null` = 答案文件里没找到这一题，**绝不用模型推断的答案填** |
| `exam_source_chars` / `key_source_chars` | integer | 两份文件各抽到多少字符（覆盖率的证据） |
| `source_truncated` | boolean | 是否因过长被截断 —— 为真时界面**必须**标出来 |
| `exam_page_count` / `key_page_count` | integer (nullable) | PDF 页数（docx 为 null，**不是 0**） |
| `extract_method` | text (nullable) | 用了哪个抽取器（`pdf_text` / `docx`）。**不含 `pptx`**：自测卷路径明确拒绝 slides |
| `exam_modified_at` / `key_modified_at` | timestamptz (nullable) | **生成时**两份文件在 Canvas 的 `modified_at`。**任一不同即重算** —— 老师换掉答案 key（题没变、答案变了）时，旧卷子的答案是**过期的谎话**，比"没有答案"严重得多 |
| `model` | text (nullable) | 实际服务的模型名（同 `llm_runs` 纪律：记实际值不记别名） |
| `error_message` | text (nullable) | 失败原因（精简、**不含卷面内容**） |
| `created_at` / `updated_at` | timestamptz | |

**唯一键**：`UNIQUE (exam_file_id)` —— 并发点开 / 流式渲染重入时靠它收敛。
配到哪一份 key 记在 `answer_key_file_id` / `pairing_rule` 里（**看得见也说得清**），
换 key 是同一条记录被重算，不并存两条。

> 🔴 **答案文件读不出来时整张卷子失败**（`status='failed'`），**不降级成「没有答案的卷子」**——
> 降级版会让用户以为"那道题本来就没有答案"。**假信息比缺失更糟**：它把系统的失败
> 伪装成数据的属性。判据问句：「这个输入换掉/缺失，用户区分得出来吗？」

### 3.18 `practice_test_explanations`（逐题讲解缓存，P0-3-23 新增）

用户点某一题的「讲解这道题的解法」后，模型给出的步骤与概念。**懒生成**：点哪一题算哪一题。

| 字段名 | 类型 | 说明 |
|---|---|---|
| `practice_test_id` | uuid (FK → practice_tests.id, **ON DELETE CASCADE**, PK 之一) | 归属（RLS 经 `practice_tests → courses` **两跳**反查） |
| `question_key` | text (PK 之一) | 题目键（`q1` / `q2`…，按**切题顺序**生成）。⚠️ 重新生成卷子后键会重排 —— 旧讲解因此不会被错配到新题上（代价是重算一次）。**错配的讲解比没有讲解坏得多** |
| `locale` | text (PK 之一) | 讲解语言（`zh-CN` / `en`，白名单在 `lib/practice-test/prompt.ts`）。**无 CHECK**（同 `file_summaries`：语言是数据维度不是代码分支） |
| `status` | text | `ok` / `failed`（有 CHECK）。`failed` 行保留的意义 = **别再重试** |
| `explanation` | jsonb | `{ steps[], concepts[] }`。**由题干与答案推导**，不允许编造新题或假答案 |
| `model` | text (nullable) | 实际服务的模型名 |
| `error_message` | text (nullable) | 失败原因（精简、**不含题目内容**） |
| `created_at` / `updated_at` | timestamptz | |

**主键**：`PRIMARY KEY (practice_test_id, question_key, locale)`。

> 为什么不把讲解塞进 `practice_tests.paper` 的 jsonb：讲解是**逐题懒生成**的，
> 一次读-改-写整份 `paper` 会把"并发点两道题"变成互相覆盖。拆表后每题一行、各写各的
> （与 `message_summaries` / `file_summaries` 同一形态）。

> ⚠️ **P0-3-2 删账号的级联**：`practice_tests` 经 `course_id → courses` 一级 CASCADE；
> `practice_test_explanations` 再经 `practice_test_id → practice_tests` 二级 CASCADE。
> 删 `profiles` → 清空两表。

---

## 4. 同步语义（Tempo 内核的数据层约定）

这一节是「实时检测 + 动态管理」在数据模型上的落点。轮询频率、触发时机、重试策略在 `Sync-Strategy.md` 里定义，本节只规定**数据怎么写**。

### 4.1 字段覆盖规则（防止用户改动被同步吃掉）

| `source` | 同步时可覆盖的字段 | 用户可改、且**不会被覆盖**的字段 |
|---|---|---|
| `canvas` | `title`、`due_date`、`external_updated_at`、`last_seen_at`、`is_deleted`、**`submission_state`**、**`submitted_at`** | `status`（标记完成） |
| `syllabus`（派生考试） | `title`、`due_date`（由 `exam_dates` 派生） | 无 —— **改考试请改 `exam_dates`** |
| `manual` | 不参与同步 | 全部 |

> 这条规则的反面同样重要：**不要整行 `upsert` Canvas 任务**，否则用户刚勾掉的"已完成"会在下次同步时被打回 `pending`。这是这类应用最常见的体验 bug。
>
> 新增 `submission_state` / `submitted_at` **不破坏**这条规则 —— 它们记的是**外部真相**，与用户主权的 `status` 是两个维度（ADR-015）。

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
courses  (1) ──< course_files            （P0-3-19）
courses  (0..1) ──> course_files         （`courses.syllabus_file_id`，P0-3-20，**ON DELETE SET NULL**，非 CASCADE）
```

**外键级联**：`courses` 删除时，其下所有子表记录 `ON DELETE CASCADE`。`canvas_credentials` / `sync_runs` / `parse_corrections` 挂在 `profiles` 下，用户删除时级联。

> ⚠️ **一处刻意的例外**：`courses.syllabus_file_id → course_files.id` 是 **`ON DELETE SET NULL`** 而非 CASCADE —— 语义上它是「这门课**认哪份文件**」这一条**指针**，不是所有权。删掉那份 `course_files` 行只该让这门课"忘了自己认哪份大纲"（锚点归 null → 下次同步重走 `baseline`），而不是反过来把课程删掉。方向也决定了它不是"课程的子表"，而是课程**指向**表的引用。

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

-- 资料（P0-3-19）：按课程取未删除的文件并按路径排序（课程页「资料」区的主查询）
CREATE INDEX idx_course_files_course_path
  ON course_files(course_id, folder_path) WHERE is_deleted = false;
-- 去重唯一索引：没有它，同步重试会产生重复条目（资料区出现两个一模一样的 HW1）
CREATE UNIQUE INDEX course_files_course_file_unique
  ON course_files(course_id, canvas_file_id);

-- 埋点：按「用户 + 事件类型」取时间窗（7 日回访）或取最近一条（提醒每日去重）
CREATE INDEX idx_usage_events_user_event_time ON usage_events(user_id, event_type, created_at DESC);
```

### 7.2 RLS（概要，细则见 `Security-Privacy.md`）

- 每张业务表 `ENABLE ROW LEVEL SECURITY`。
- `profiles` / `canvas_credentials` / `sync_runs` / `parse_corrections` / `usage_events`：策略基于 `auth.uid() = user_id`。
  - `usage_events`（P0-3-1）额外两条：用户只能 **INSERT 自己的行**（埋点走用户级客户端，没有这条写入会静默全失败）、只能 **SELECT 自己的行**；**不开放 UPDATE / DELETE** —— 埋点是事实记录，不可改写。
- `courses` 及其子表：策略基于**通过 `courses` 反查 `user_id`**（子表没有直接的 `user_id`）。
- **验收标准**：用两个测试账号交叉验证，A 账号通过任何接口都取不到 B 账号的任何一行数据（P0-0-5）。

### 7.3 Supabase Storage（syllabus 文件）

> 本节 2026-09-02 随 P0-1-1 建立。此前 `Security-Privacy.md` 只写了「Supabase Storage（私有桶）」，桶名 / 路径 / 策略全是空白，而本文件第 1 节规定**未定义的表与字段一律不得创建** —— 先补 SSOT 再出迁移。

**桶**

| 项 | 值 | 说明 |
|---|---|---|
| 桶名 | `syllabi` | Phase 0 只有一个桶，不按课程分桶 |
| `public` | **false**（私有桶） | 签名 URL 才能访问，见下 |
| `file_size_limit` | `20971520`（20MB） | 与 `API-Contract.md` §3 的大小上限一致 |
| `allowed_mime_types` | **null（不设）** | 见下方「为什么不设 MIME 白名单」 |

**对象路径约定**

```
{user_id}/{course_id}/{syllabus_id}.{ext}
例：3f2a…/b91c…/d84e….pdf
```

- **首段必须是 `auth.uid()`** —— 这是 RLS 判定的唯一依据，前端不可控，由服务端在签发上传票据时生成（ADR-009：前端上报的一切都不可信）。
- 路径里带 `course_id` 是为了将来按课程批量清理（P0-3-2 删账号时按 `user_id` 前缀整段删即可，不需要逐条查库）。

**`storage.objects` 的 RLS 策略（4 条）**

```sql
-- 判定式：路径首段 = 当前用户 uid
(storage.foldername(name))[1] = auth.uid()::text
```

| 操作 | 策略名 |
|---|---|
| SELECT | `syllabi_objects_select_own` |
| INSERT | `syllabi_objects_insert_own` |
| UPDATE | `syllabi_objects_update_own` |
| DELETE | `syllabi_objects_delete_own` |

四条都带 `bucket_id = 'syllabi'` 限定，避免误伤其他桶。

> 🔴 **执行方式（2026-09-02 实测修正）**：这四条策略**不能在 Dashboard SQL Editor 用 `CREATE POLICY` 创建** —— 报 `42501: must be owner of table objects`。`storage.objects` 的 owner 是平台内部的 `supabase_storage_admin`，SQL Editor 的 postgres 角色不是 owner，而 `CREATE POLICY` 要求 owner（业务表能这样做是因为 owner 就是 postgres）。**正确做法：Dashboard → Storage → Policies UI 逐条创建**，具体参数见 `supabase/migrations/20260902220000_storage_syllabi.sql` 头部的步骤表。

**为什么不设 `allowed_mime_types`**

docx / pptx 的 MIME 类型在实际浏览器里极不稳定（常见 `application/octet-stream`、亦有空值）。若在桶层面做 MIME 白名单，会把**合法文件误拒**，且用户看到的错误与实际原因不符，排障成本高。

因此：**类型校验以「文件扩展名」为准，在服务端做**（`lib/syllabi.ts`），桶层面只卡大小。

**为什么不用公开桶**

syllabus 可能含教师姓名、office hour 地址、评分细则等个人信息。公开桶 = 任何人拿到 URL 就能下载，等于把 RLS 绕过去了。私有桶 + 短时签名 URL 是唯一可接受方案。

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
| 2026-09-02 | 新增 **7.3 Supabase Storage** 小节（桶 `syllabi`、路径约定、`storage.objects` 四条 RLS 策略、不设 MIME 白名单的理由）；澄清 §3.3 `file_url` 存的是**对象路径而非 URL**（私有桶无永久 URL）；记录「上传未完成的悬挂行」这一已知留白及其兜底机制 | P0-1-1、ADR-009（直传）、`Security-Privacy.md` 私有桶约定 |
| 2026-09-09 | **补「删账号时 Storage 不在级联链上」这一条**（P0-3-2）：全部业务表都挂在 `profiles`（或经 `courses`）的 `ON DELETE CASCADE` 上，删 `profiles` 行即清空；但 **`storage.objects` 与数据库没有外键关系**，必须单独按 `{user_id}` 前缀递归删（`list()` 只返一层且把文件夹当条目 `id=null`，需递归），否则留下无主文件。删除顺序与失败语义（Storage 失败即整趟失败）实现在 `lib/account/delete-account.ts` | P0-3-2 |
| 2026-09-07 | **新增 §3.14 `usage_events`**（P0-3-1）：只为 PRD 8.1 四项指标中的两项（7 日回访 / token 续期完成率）而建 —— 编辑修正率读 `parse_corrections`、人均关联课程数读 `courses.canvas_course_id`，**不重复埋点**。三类事件的写入点、每日去重规则、"埋点失败只告警 / 读数失败必须 500"的反向约定一并写入；§7.1 补索引、§7.2 补 RLS（INSERT 策略不可省，否则埋点静默全失败）；标注 P0-3-2 删账号需级联本表 | P0-3-1、`PRD.md` 8.1 |
| 2026-09-02 | **P0-1-2 落地后对 §3.3 的补充**：`raw_text` 由 `POST /api/v1/syllabi/:id/extract` 写入，**列表与上传响应一律不读这一列**（可能几 MB，只有 extract 端点读它取前 1000 字符预览）；`extract_method` 的 CHECK 约束取值确认为 `pdf_text` / `docx` / `pptx` / `manual`（**`docx`/`pptx` 没有 `_text` 后缀**，是初版遗留，不为此改生产表）；悬挂行的兜底已实现 —— `createSignedUrl` 对不存在的对象返回 `NoSuchKey`，extract 端点据此置 `failed` + 返回 409 | P0-1-2、`API-Contract.md` §3 |
| **2026-09-13** | **§3.9 `tasks` 新增 `submission_state` / `submitted_at` 两列**（P0-3-10，ADR-015）：分列的意义是让"外部真相"（Canvas `submission.workflow_state`）与"用户主权"（`status`）**永不互相覆盖** —— 同步只写前者，展示层合并。含 `external_tool` / `not_graded` / `on_paper` 类作业**必须落 `null` 并展示「待确认」**（Canvas 不知道 ≠ 用户没交，显示"待完成"等于诬告用户）。§4.1 同步可覆盖字段集加入这两列；§3.1 补**禁止硬编码 UTC** 的强制约束（dashboard 日期差一天的真 bug） | P0-3-10、ADR-015 |
| 2026-09-17 | **新增 `email_inbound_events` 表**（P0-3-11，迁移 `20260917120000_inbound_email.sql`，ADR-019）：邮件入站的事件账 —— `received_from` / `event_type` / `action_taken` / `matched_task_id`；webhook 经 service_role 写入（绕 RLS）、用户仅本人可读、不给 anon/authenticated 写权限；`user_id` 引用 `auth.users` 级联删除 | P0-3-11、ADR-019 |
| 2026-09-17 | **§3.1 `profiles` 新增 `reminder_enabled` / `last_reminder_at` / `reminder_unsub_token` 三列**（P0-3-14，迁移 `20260917130000_reminders.sql`）：主动提醒出站体系的数据层。`reminder_enabled` 默认 **true**（ADR-016「Tempo 找人」，现有与未来用户都默认开启）；`last_reminder_at` 支撑「每用户每天至多一封」频控；`reminder_unsub_token` 用**部分唯一索引**（仅非空值唯一） | P0-3-14、ADR-016/017 |
| 2026-09-17 | **§3.9 `tasks` 新增 `canvas_url` / `points_possible` / `submission_score` 三列**（P0-3-17，迁移 `20260917140000_tasks_canvas_url_score.sql`，全部可空**不回填**）：「点任务名跳 Canvas」+ 分数条。🔴 两个 null **含义不同**：`points_possible=null` = Canvas 未设满分（不是 0 分）、`submission_score=null` = 尚未评分（不是 0 分），展示层禁止用 0 代替（§3.9 同一原则）。⚠️ 本迁移必须先于代码执行，否则带新列的任务查询整体 42703 | P0-3-17 |
| 2026-09-18 | **新增 `messages` 表（消息栏 · 系统提案收件箱）**（P0-3-18，迁移 `20260917200000_messages.sql`）：`type` CHECK 白名单（`syllabus_drift` / `practice_test` / `routine` / `material`）+ `payload jsonb`（形状归消费方，本表不做 schema 校验）+ `status`（`pending` / `accepted` / `dismissed`）。`user_id` 引用 `profiles` 而非 `auth.users`（接上删账号级联链）；RLS 含 INSERT 策略（缺一条提案就静默发不出）。🔴 `type` 是「四处同改」枚举的第一处（types / registry / 迁移 CHECK / 回归） | P0-3-18 |
| 2026-09-18 | **`grade_components.source` CHECK 增 `'canvas'`**（P0-3-24，迁移 `20260918000000_grade_components_source_canvas.sql`）：Canvas 同步写入成绩构成的枚举前提 | P0-3-24 |
| 2026-09-18 | **新增 `course_announcements` 表（Canvas 公告进站账）**（P0-3-25，迁移 `20260919000000_announcements.sql`，ADR-022）：去重键 `course_id + canvas_announcement_id`（`canvas_announcement_id` 存 **text**，不为"看起来干净"做整型转换）；**不加 `user_id` 列**，归属靠 `course_id → courses.user_id`（与 `exam_dates` 同模式：一处归属、一处 RLS 判据）；`body_text` 只落**清洗后纯文本**，渲染层再禁 `dangerouslySetInnerHTML` —— 两道一起挡 stored XSS；`messages.type` CHECK 同步扩入 `'announcement'` | P0-3-25、ADR-022 |
| 2026-09-18 | **新增 `message_summaries` 表（公告 AI 要点缓存）**（P0-3-25b，迁移 `20260920000000_message_summaries.sql`，ADR-024）：键含 `message_id + locale`（语言白名单在 `lib/messages/summary/locale.ts`）；`status` 只有 `ok` / `failed` —— **失败也落行**（`points` 空 + `error_message` 留原因），意义是「别再重试」：只记成功 = 每次打开消息栏都为同一条公告重打一次模型。归属不落 `user_id`，经 `messages` 级联 | P0-3-25b、ADR-024 |
| 2026-09-18 | **`messages` 增 `decided_at` 列 + `status` CHECK 放宽 `'undone'`**（P0-3-26，迁移 `20260918000000_message_undo.sql`）：回执撤销的数据层。`decided_at` 记「确认 / 撤销」时刻，支撑 **24h 撤销窗口**（超窗或已撤销均不可再操作，`undone` 是终态）；status 约束用 DO 块按定义内容定位后 drop 重建（建表时是列内 check，约束名由 PG 自动生成、不同环境不一样）。枚举「四处同改」的第 3 处 | P0-3-26 |
| 2026-09-18 | **新增 §3.15 `course_files` 表**（P0-3-19，迁移 `20260921000000_course_files.sql`，ADR-026）：Canvas 文件**元数据**索引（内容变更看 `modified_at`，原文绝不落库）；Canvas 给的 `url` 是**能力凭据**不落库，外链由应用层自己拼 `/courses/{cid}/files/{fid}` | P0-3-19、ADR-026 |
| 2026-09-18 | **新增 §3.16 `file_summaries` 表**（P0-3-19b，迁移 `20260922000000_file_summaries.sql`）：单文件「一键总结」缓存，结构化提要、**不含课件原文** | P0-3-19b |
| 2026-09-18 | **新增 §3.17 `practice_tests` + §3.18 `practice_test_explanations` 两张表**（P0-3-23，迁移 `20260924000000_practice_tests.sql`）—— 自测卷与逐题讲解的缓存。`practice_tests` 的唯一键落在 **`exam_file_id`**（一份试卷永远只有一张当前有效的自测卷 → 关掉"同一份试卷两条卷子"这种无法解释的状态）；`answer_key_file_id` 是**第二个刻意的非 CASCADE 例外**（`ON DELETE SET NULL`：答案文件被删时卷子不该跟着消失，只是从此每题都没答案，界面如实标注）；**差量判据是两个 `modified_at`**（试卷 + 答案各一个，任一不同即重算 —— 老师换掉答案 key 时，旧卷子的答案是**过期的谎话**，比"没有答案"严重得多）。`practice_test_explanations` PK `(practice_test_id, question_key, locale)`，`question_key` 跟着**切题顺序**走（重排后旧讲解不会被错配到新题上）。**零枚举变更**（已核实：复用 3-18 建表时就有的 `messages.type='practice_test'`，两张新表的 `status` CHECK 是新建而非改写）。见 **ADR-027** | P0-3-23、**ADR-027** |
| 2026-09-18 | **§3.2 `courses` 新增 `syllabus_file_id` / `syllabus_seen_modified_at` 两列**（P0-3-20，迁移 `20260923000000_syllabus_drift.sql`）—— 大纲漂移检测的**差量锚点**。`syllabus_file_id` 是**指针**（「这门课认哪份文件」），`ON DELETE SET NULL` 是**刻意的非 CASCADE 例外**（§6 已注明理由：它不拥有那份文件）；`syllabus_seen_modified_at` 存的是**文件版本**（逐字来自 `course_files.modified_at`）**不是核对时刻** —— 存成 `now()` 会让每轮同步都报"大纲变了"（纯噪音），而真变更反而分辨不出来。**只加两列、不动任何枚举、无需补 CHECK**（已核实 `exam_dates.source` 含 `'canvas'`、`grade_components.source` 已由 `20260918000000` 补平、`messages.type` 含 `'syllabus_drift'`）。§6 表关系简图补两条关系线 + 上述例外说明 | P0-3-20、**ADR-026**、P0-3-19 |
