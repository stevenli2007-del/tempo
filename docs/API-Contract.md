# API-Contract.md — Tempo 接口契约

> **这份文档是前后端之间的合约。** 端点命名、请求/响应结构一经定义，前后端同时依赖；**任何变更必须先改本文档，再改代码**（Diff First）。
>
> 数据字段语义见 `Database.md`；同步行为见 `Sync-Strategy.md`；密钥与合规边界见 `Security-Privacy.md`。

---

## 1. 通用约定

### 1.1 命名与版本

| 项 | 规则 | 示例 |
|---|---|---|
| 前缀 | 一律 `/api/v1/` | `/api/v1/courses` |
| 路径命名 | **业务语义命名，不用 CRUD 动词** | ✅ `/api/v1/courses/:id/canvas-link` ❌ `/api/v1/update_course` |
| 资源 | 复数名词 | `/api/v1/tasks` |
| 动作无法用资源表达时 | 用动词短语，**放路径末尾** | `/api/v1/sync/now` |
| JSON 字段 | **camelCase**（与 TS 一致） | `dueDate`, `lastSyncedAt` |
| 数据库字段 | snake_case（仅出现在本文档的"落库"说明里） | `due_date` |
| 时间 | ISO 8601 带时区 | `2026-09-20T23:59:00-07:00` |
| 空值 | 用 `null`，**不用空字符串 / 0 / 假日期代替"未知"** | `"dueDate": null` |

> 版本化从第一天就有（`/v1/`）。将来破坏性变更走 `/v2/`，**不允许在 v1 上改字段语义**。

### 1.2 认证

- 所有业务端点使用 **Supabase 会话 Cookie** 鉴权（`@supabase/ssr` 的 server client）。
- 未登录 → `401`；已登录但资源不属于当前用户 → `403`（**不返回 404**，避免通过状态码探测资源是否存在）。
- `/api/v1/sync/scheduled` 例外：使用 `Authorization: Bearer ${CRON_SECRET}`，**恒定时间比较**，失败返回 `401`。

### 1.3 响应结构

**成功（单对象）**：直接返回业务对象。

```jsonc
{ "id": "…", "courseName": "Math 53", "syncStatus": "success" }
```

**成功（列表）**：

```jsonc
{ "data": [ … ], "meta": { "total": 12 } }
```

**失败（统一结构）**：

```jsonc
{
  "error": {
    "code": "credential_invalid",
    "message": "Canvas 连接已失效，请重新生成 token",   // 面向用户的人话，不是堆栈
    "details": { "httpStatus": 401 }                     // 可选，调试用
  }
}
```

### 1.4 状态码与错误码

| HTTP | 用途 | 常见 `code` |
|---|---|---|
| 400 | 请求格式错误 | `bad_request` |
| 401 | 未登录 / CRON_SECRET 错误 | `unauthenticated` |
| 403 | 资源不属于当前用户 | `forbidden` |
| 404 | 资源不存在（含已软删除） | `not_found` |
| 409 | 冲突：同步锁占用、重复关联 | `sync_in_progress` / `already_linked` |
| 413 | 文件过大 | `file_too_large` |
| 415 | 文件类型不支持 | `unsupported_file_type` |
| 422 | **业务校验失败**：派生任务被非法编辑等 | `derived_task_immutable` / `validation_failed` |
| 429 | 触发节流或 Canvas 限流 | `rate_limited`（带 `retryAfter` 秒） |
| 500 | 服务端异常 | `internal_error`（**message 不暴露内部细节**） |

### 1.5 其他硬性规则

1. **任何响应中不得出现 `secretEncrypted`、Canvas token、或其任何派生形式。** 这是一条安全红线，不是风格建议（P0-2-2 验收：抓包确认前端拿不到 token）。
2. 所有写操作返回**变更后的完整对象**，前端不必二次拉取。
3. 请求头带 `x-request-id`，响应原样回传，便于排障。
4. 列表分页：`?limit`（默认 50，上限 200）+ `?offset`。

---

## 2. 课程 Workspace

### `GET /api/v1/courses`
按学期分组返回当前用户的全部课程。

```jsonc
{
  "data": [
    {
      "id": "…",
      "semester": "Fall 2026",
      "courseName": "Math 53",
      "courseCode": "MATH 53",
      "instructorName": "Douskey",
      "isDemo": false,
      "isArchived": false,
      "canvasLinked": true,
      "lastSyncedAt": "2026-09-20T14:03:00-07:00",
      "syncStatus": "success",
      "syncError": null,
      "upcomingTasks": [ { "id": "…", "title": "HW 3", "dueDate": "…" } ]   // 最多 2 条
    }
  ],
  "meta": { "total": 5 }
}
```

### `POST /api/v1/courses`
```jsonc
// request
{ "semester": "Fall 2026", "courseName": "Math 53", "courseCode": "MATH 53", "instructorName": "Douskey" }
// response 201 → 完整 course 对象
```
`semester` / `courseName` 必填；其余选填。

### `GET /api/v1/courses/:id`
返回课程详情 + 五个板块的完整内容（**合成一个大对象，前端一次渲染完**）：

```jsonc
{
  "id": "…", "semester": "…", "courseName": "…",
  "canvasLinked": true, "lastSyncedAt": "…", "syncStatus": "success", "syncError": null,
  "syllabus": { "id": "…", "fileName": "syllabus.pdf", "parseStatus": "completed" },
  "gradeComponents": [ { "id": "…", "name": "Midterm 1", "weightPercent": 20, "notes": null, "isConfirmed": true } ],
  "outlineItems":    [ { "id": "…", "orderIndex": 1, "weekLabel": "Week 1", "topic": "Vectors" } ],
  "examDates":       [ { "id": "…", "examName": "Midterm 1", "examDate": "2026-10-15", "examTime": "7-9pm", "location": "…", "status": "confirmed" } ],
  "officeHours":     [ { "id": "…", "personName": "…", "dayOfWeek": "Monday", "startTime": "14:00", "endTime": "15:00", "location": "…" } ],
  "submissionPolicies": [ { "id": "…", "description": "…", "platformName": "Gradescope" } ]
}
```
缺失项返回 `[]`（**不是 `null`**），前端按"TBD"渲染。

### `PATCH /api/v1/courses/:id` — 更新课程元信息
### `DELETE /api/v1/courses/:id` — 软删除（`is_archived=true`），级联：该课程任务从总览页隐藏

---

## 3. Syllabus 上传与解析

### `POST /api/v1/courses/:id/syllabus`
`multipart/form-data`，字段 `file`。

校验：类型 `pdf | docx | pptx`；大小 **≤ 20MB**；失败分别返回 `415` / `413`。

```jsonc
// response 201
{
  "syllabusId": "…",
  "fileName": "syllabus.pdf",
  "extractStatus": "extracted",
  "extractMethod": "pdf_text",
  "pageCount": 6,
  "previewText": "Course: Math 53 … (前 1000 字符)"   // 冷启动：立刻可见的文本预览
}
```
抽取失败（如扫描件）→ `extractStatus: "failed"` + `extractError`，**HTTP 仍返回 201**（文件是存下来了，只是抽不出文本）。前端据此走降级提示。

### `POST /api/v1/syllabi/:id/parse`
触发 LLM 五板块抽取。**异步**：创建 `llm_runs` 记录后立即返回 `202`。

```jsonc
// response 202
{ "runId": "…", "status": "processing" }
```

### `GET /api/v1/syllabi/:id/parse-status`
前端**每 1.5 秒轮询一次**（P0-1-11 的进度可视化）。

```jsonc
{
  "status": "processing",
  "blocks": {
    "gradeComponents":    "completed",
    "outlineItems":       "processing",
    "examDates":          "pending",
    "officeHours":        "pending",
    "submissionPolicies": "pending"
  }
}
```
`status`: `pending` / `processing` / `completed` / `partial` / `failed`。**部分板块失败仍返回 `completed`/`partial`**，失败的板块前端显示"未能解析，请手动补充" —— 不允许整个解析失败就丢掉已成功的部分。

### `POST /api/v1/syllabi/:id/reparse`
用当前 raw_text 重新解析（不重新上传文件），用于切了 LLM provider 或改了 prompt 之后重跑。响应同 `/parse`。

---

## 4. 五个板块的保存（含修正 diff）

统一用 **`PUT` 全量替换该板块**（幂等，前端表单整体提交）：

| 端点 | 板块 |
|---|---|
| `PUT /api/v1/courses/:id/grade-components` | 成绩构成 |
| `PUT /api/v1/courses/:id/outline-items` | 课程大纲 |
| `PUT /api/v1/courses/:id/exam-dates` | 考试日期 |
| `PUT /api/v1/courses/:id/office-hours` | Office Hour |
| `PUT /api/v1/courses/:id/submission-policies` | 提交政策 |

```jsonc
// request
{ "items": [ { "id": "…(可选，新增时省略)", "examName": "Midterm 1", "examDate": "2026-10-15", "examTime": "7-9pm", "location": "…", "status": "confirmed" } ] }
// response 200 → 该板块的完整最新列表
```

**服务端必须做的三件事（在同一事务内）**：
1. 与库中现有值逐字段比对，**每一处差异写一条 `parse_corrections`**（`originalValue` / `correctedValue` / `fieldName` / `correctionType`）；
2. 更新 `llm_run_id` 归因（关联最近一次该 syllabus 的解析）；
3. 若板块是 **`exam-dates`** → **同步派生 `tasks` 记录**（ADR-004，见 `Database.md` 第 5 节）。

> 第 3 条是"课程页和总览页日期对不上"的唯一防线。派生逻辑集中在 `syncExamToTask()` 一处。

---

## 5. 任务

### `GET /api/v1/tasks?range=7d&limit=50&offset=0`
总览页数据源，**合并 syllabus 考试与 Canvas 作业**，按 `dueDate` 升序，`dueDate` 为 `null` 的排最后。

```jsonc
{
  "data": [
    {
      "id": "…",
      "courseId": "…", "courseName": "Math 53",
      "title": "HW 3",
      "dueDate": "2026-09-20T23:59:00-07:00",
      "taskType": "assignment",
      "source": "canvas",
      "status": "pending",
      "isDerived": false
    }
  ],
  "meta": { "total": 23, "staleWarning": false, "lastSuccessfulSyncAt": "2026-09-20T14:03:00-07:00" }
}
```
`staleWarning: true` 表示**超过 24 小时未成功同步**（`Sync-Strategy.md` 的陈旧告警），前端据此渲染顶部警告条。

### `PATCH /api/v1/tasks/:id`
**只允许更新 `status`**（pending / done）。

- `isDerived = true` 的任务传 `title` / `dueDate` → **`422 derived_task_immutable`**，错误信息引导用户去课程页改 `exam_dates`。
- 这是 ADR-004 在接口层的强制点。

### `POST /api/v1/tasks` — 创建手动任务（`source = manual`）
### `DELETE /api/v1/tasks/:id` — 软删除，**仅允许 `source = manual`**（同步来的任务不能被用户删，否则下次同步又回来）

---

## 6. Canvas 连接与同步

> 所有 Canvas 请求**必须经由服务端代理**。前端不得直连 Canvas（会暴露 token 且受 CORS 限制）。

### `POST /api/v1/canvas/credentials`
```jsonc
// request
{ "canvasDomain": "bcourses.berkeley.edu", "token": "…", "expiresAt": "2027-01-15T00:00:00-07:00" }
// response 201 —— ⚠️ 绝不回显 token
{ "id": "…", "canvasDomain": "bcourses.berkeley.edu", "credentialType": "pat", "expiresAt": "2027-01-15T00:00:00-07:00", "status": "active" }
```
- `expiresAt` 取用户实际填写值；**未填则存 `null`，服务端不做任何估算**（见 `Sync-Strategy.md` 第 10 节）。
- 保存后立即触发一次同步。

### `GET /api/v1/canvas/credentials`
只返回元数据：`status` / `expiresAt` / `lastUsedAt` / `lastErrorAt` / `lastErrorMessage` / `canvasDomain`。**不含任何密钥字段。**

### `DELETE /api/v1/canvas/credentials` — 撤销授权
删除加密凭证 + 将 `status` 置为 `revoked` + 停止同步。**已同步的 `tasks` 保留**（用户的学习记录不该因为断开连接而消失），但同步状态显示为"未连接"。

### `GET /api/v1/canvas/courses`
服务端代理拉取用户的 Canvas 课程列表，供关联 UI 使用。

```jsonc
{ "data": [ { "externalId": "12345", "name": "MATH 53 - Multivariable Calculus", "term": "Fall 2026" } ] }
```
⚠️ **只读课程列表**，不返回成绩、花名册等任何其他信息（最小权限，见 `Security-Privacy.md`）。

### `POST /api/v1/courses/:id/canvas-link`
```jsonc
// request  { "externalCourseId": "12345" }
// response 200 → course 对象（含 canvasLinked: true），并触发一次该课程的同步
```
重复关联 → `409 already_linked`。

### `DELETE /api/v1/courses/:id/canvas-link` — 解除关联
解除后该课程的 Canvas 任务保留但标记为不再更新（`last_seen_at` 停止刷新，UI 不再展示同步状态）。

### `POST /api/v1/sync/now`
手动/打开时触发同步。服务端按 `Sync-Strategy.md` 节流（手动 30s / 自动 60s），超限返回 `429` + `retryAfter`。

```jsonc
// response 200
{
  "status": "partial",
  "coursesSynced": 4,
  "coursesFailed": 1,
  "tasksCreated": 3, "tasksUpdated": 2, "tasksDeleted": 0,
  "failures": [ { "courseId": "…", "courseName": "…", "message": "Canvas 返回 401" } ]
}
```
同步进行中被再次触发 → `409 sync_in_progress`（不排队，直接拒绝）。

### `POST /api/v1/sync/scheduled`
**仅由 Vercel Cron 或外部调度器调用**，需 `Authorization: Bearer ${CRON_SECRET}`。批量同步全部有效凭据用户。响应为汇总统计，**不返回任何用户的具体数据**。

### `GET /api/v1/sync/status`
返回当前用户的同步总览：`lastSyncedAt` / 各课程 `syncStatus` / 凭证状态 / 是否需要续期。供总览页顶部状态条使用。

---

## 7. 账号与隐私（PRD F6 / P0-3-2）

### `GET /api/v1/account/data-summary`
返回"我们存了你什么"的结构化清单：课程数、syllabus 文件数、任务数、Canvas 连接状态、凭据过期时间。用于设置页透明展示。

### `DELETE /api/v1/account/data?scope=canvas`
删除 Canvas 凭据 + 全部 `source = canvas` 的任务。**保留 syllabus 与手动任务。**

### `DELETE /api/v1/account`
删除账号及全部数据，**级联范围**：`profiles` / `courses` 及其全部子表 / `tasks` / `canvas_credentials` / `sync_runs` / `parse_corrections` / Supabase Storage 中的 syllabus 文件 / Supabase Auth 用户。

> Storage 文件清理**不可遗漏** —— 只删数据库会留下一堆无主文件，这是最常被漏掉的一步。

---

## 8. Demo 与冷启动

### `POST /api/v1/demo/seed`
为新用户复制预置的示例课程（含已解析 syllabus 与示例任务），标记 `isDemo = true`。重复调用返回 `409 already_linked`。
验收：从进入站点到看到有内容的总览页 **≤ 30 秒**（P0-1-10）。

### `DELETE /api/v1/demo`
一键清空全部 `isDemo = true` 的课程及其数据。

---

## 9. 健康检查

### `GET /api/v1/health`
`{ "status": "ok", "version": "…", "commit": "…" }` —— 部署冒烟测试用，无需登录。

---

## 10. 端点总表

| 方法 | 端点 | 用途 | 关联 task |
|---|---|---|---|
| GET | `/api/v1/health` | 健康检查 | P0-0-6 |
| GET/POST | `/api/v1/courses` | 课程列表 / 创建 | P0-1-7 |
| GET/PATCH/DELETE | `/api/v1/courses/:id` | 课程详情 / 更新 / 归档 | P0-1-7, P0-1-8 |
| POST | `/api/v1/courses/:id/syllabus` | 上传 syllabus | P0-1-1 |
| POST | `/api/v1/syllabi/:id/parse` | 触发解析 | P0-1-4 |
| GET | `/api/v1/syllabi/:id/parse-status` | 解析进度 | P0-1-11 |
| POST | `/api/v1/syllabi/:id/reparse` | 重新解析 | P0-1-4 |
| PUT | `/api/v1/courses/:id/{grade-components,outline-items,exam-dates,office-hours,submission-policies}` | 五板块保存 + diff | P0-1-5, P0-1-6 |
| GET | `/api/v1/tasks` | 总览任务列表 | P0-1-9, P0-2-11 |
| POST/PATCH/DELETE | `/api/v1/tasks[/:id]` | 手动任务 CRUD / 标记完成 | P0-1-9 |
| POST/GET/DELETE | `/api/v1/canvas/credentials` | 凭证保存 / 元数据 / 撤销 | P0-2-2, P0-2-9 |
| GET | `/api/v1/canvas/courses` | Canvas 课程列表（代理） | P0-2-3 |
| POST/DELETE | `/api/v1/courses/:id/canvas-link` | 课程关联 / 解除 | P0-2-4 |
| POST | `/api/v1/sync/now` | 手动同步 | P0-2-6 |
| POST | `/api/v1/sync/scheduled` | 定时同步（CRON_SECRET） | P0-2-6 |
| GET | `/api/v1/sync/status` | 同步状态 | P0-2-7 |
| GET | `/api/v1/account/data-summary` | 数据清单 | P0-3-2 |
| DELETE | `/api/v1/account[/data]` | 删除数据 / 账号 | P0-3-2 |
| POST/DELETE | `/api/v1/demo[/seed]` | Demo Workspace | P0-1-10 |

---

## 11. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-09-01 | 初版 | `CodingRules.md`（Diff First、业务语义命名）、`Database.md`、`Sync-Strategy.md`、PRD F1-F6 |
