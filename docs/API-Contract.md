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
- 未登录 → `401`。
- **已登录但资源不属于当前用户 → `404`**，文案统一为「…不存在或无权访问」。

  > ⚠️ **此处偏离初版契约**（初版写的是 403「不返回 404，避免探测资源是否存在」），**2026-09-02 由 Steven 拍板接受**，理由见 **ADR-010**。
  > 一句话解释：业务表全开 RLS，别人的行在当前会话下**根本查不出来**，服务端无从区分「不存在」与「不是你的」。要在应用层区分，就必须用 service role 绕过 RLS 去探测存在性——那反而开了一条**存在性泄漏**的口子，与 403-not-404 原本想保护的意图相悖。
  > 因此：**403 的意图（不泄漏存在性）保留，改用 404 实现**。
  > 本条适用于**所有受 RLS 保护的资源端点**（courses / syllabi / tasks / canvas credentials …），不是 courses 的个案。

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
| ~~403~~ | **Phase 0 不使用**（原「资源不属于当前用户」见 §1.2 与 ADR-010，已并入 404） | — |
| 404 | 资源不存在（含已软删除）、**或不属于当前用户** | `not_found` |
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

> ⚠️ **上传已改为两步式直传**（2026-09-02，[ADR-009](./Decisions.md#adr-009)）。初版写的 `multipart/form-data` 已作废：文件不再经过我们的服务端，否则平台请求体上限会让"20MB"这条约定立不住。

### `POST /api/v1/courses/:id/syllabus` — 第 1 步：取上传票据

1. 本端点校验 → 签发 Storage 签名上传 URL → 建 `syllabi` 行；
2. 浏览器拿票据直接 `uploadToSignedUrl` 传到 Storage（第 2 步，不经过本 API）。

**请求**（`application/json`，不是 multipart）

```jsonc
{ "fileName": "syllabus.pdf", "fileSize": 482133 }
```

**校验**：扩展名 `pdf | docx | pptx`（**不按 MIME 判定**，理由见 `Database.md` 7.3）；大小 **≤ 20MB**。

| 失败情形 | 状态 | `code` |
|---|---|---|
| 缺字段 / 文件名或大小不合法 | 400 | `bad_request` |
| 课程不存在或不属于当前用户 | 404 | `not_found`（[ADR-010](./Decisions.md#adr-010)） |
| 扩展名不在白名单 | 415 | `unsupported_file_type` |
| 超过 20MB | 413 | `file_too_large` |

**响应 201**

```jsonc
{
  "syllabus": {
    "id": "…",
    "courseId": "…",
    "filePath": "{user_id}/{course_id}/{syllabus_id}.pdf",   // Storage 对象路径，不是 URL
    "fileName": "syllabus.pdf",
    "extractMethod": null,
    "extractStatus": "pending",
    "extractError": null,
    "pageCount": null,
    "parseStatus": "pending",
    "parseError": null,
    "uploadedAt": "2026-09-02T…"
  },
  "upload": {
    "bucket": "syllabi",
    "path": "{user_id}/{course_id}/{syllabus_id}.pdf",
    "token": "…",          // 有效期 2 小时（平台固定值）
    "signedUrl": "https://…/storage/v1/object/upload/sign/…"
  }
}
```

> ⚠️ **本端点不做文本提取。** 签发票据时文件还没传上来，服务端手里没有文件内容，拿不到文本。
> 提取是**第 3 步**：浏览器 `uploadToSignedUrl` 成功后再调 `POST /api/v1/syllabi/:id/extract`。
> 因此本响应的 `extractStatus` **恒为 `pending`**，`previewText` 不在本端点返回。

### `GET /api/v1/syllabi/:id/download` — 取回文件

桶 `syllabi` 是私有的，**没有永久可访问的 URL**（`Database.md` 7.3），所以取文件必须现签短时签名 URL。

```jsonc
// response 200
{
  "downloadUrl": "https://…/storage/v1/object/sign/…",
  "expiresAt": "2026-09-02T…"      // 签名 60 秒后过期，过期须重新请求本接口
}
```

**失败情形**

| 状态 | `error.code` | 触发条件 |
|---|---|---|
| `400` | `bad_request` | `:id` 不是合法 UUID |
| `401` | `unauthenticated` | 未登录 |
| `404` | `not_found` | syllabus 行不存在或不属于当前用户（[ADR-010](./Decisions.md#adr-010)） |
| `404` | `file_missing` | **行在、文件不在**（悬挂行：票据签发了但浏览器没传完 / 文件被删） |

> ⚠️ **`file_missing` 必须显式处理。** `createSignedUrl` **会**检查对象是否存在，
> 不存在时抛 `StorageApiError { statusCode: '404', code: 'NoSuchKey' }`。
> 不当成已知错误拦下来，用户看到的就是 **500** —— 2026-09-02 冒烟抓到 download 端点漏了这一处。
> 判定谓词统一用 `lib/syllabi.ts` 的 `isStorageObjectNotFoundError()`，**不要各路由自己写**
> （`statusCode` 是**字符串** `'404'`，只判数字 404 永远命中不了）。
>
> 与 extract 端点的状态码差异是有意的：**extract 是「动作做不了」→ 409；download 是「资源不存在」→ 404。**

### `POST /api/v1/syllabi/:id/extract` — 第 3 步：提取文本

上传流程的**最后一拍**（P0-1-2）。前端在 `uploadToSignedUrl` 成功后立即调用。

服务端用**当前用户会话**签一个短时下载 URL 把文件读回来（走 RLS，不用 service role），按扩展名分派提取器：

| 扩展名 | 提取器 | `extract_method` |
|---|---|---|
| `.pdf` | `pdfjs-dist` 5.4.296 **legacy 构建**（逐页 `getTextContent()`，按 `hasEOL` 补换行后拼接） | `pdf_text` |
| `.docx` | `mammoth` `extractRawText`，直接取纯文本不转 HTML | `docx` |
| `.pptx` | `jszip` 解 `ppt/slides/slide*.xml` 后取 `<a:t>` | `pptx` |

> ⚠️ `extract_method` 在 `syllabi` 表上**有 CHECK 约束**（`Database.md` 3.3）：取值只能是 `pdf_text` / `docx` / `pptx` / `manual`。
> 命名不一致（`docx` 而非 `docx_text`）是初版遗留，**不为此改生产表**，代码与文档一律以 DB 约束为准。

**响应 200**（提取失败也返回 200 —— 文件存下来了，只是抽不出文本）

```jsonc
{
  "syllabus": {
    "id": "…",
    "extractStatus": "extracted",   // extracted | failed
    "extractMethod": "pdf_text",    // pdf_text | docx | pptx | null（失败时）。以 DB CHECK 约束为准，没有 _text 后缀
    "extractError": null,           // 失败时是给人看的原因，如「扫描件 PDF 抽不出文字」
    "pageCount": 6,                 // 仅 PDF，其余为 null
    "…": "其余字段同上传响应"
  },
  "previewText": "Course: Math 53 … 前 1000 字符"   // 提取成功时才有
}
```

| 失败情形 | 状态 | `code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthorized` | |
| 非法 uuid | 400 | `bad_request` | |
| 不存在或不属于当前用户 | 404 | `not_found` | [ADR-010](./Decisions.md#adr-010) |
| 文件未上传完（悬挂行） | 409 | `file_missing` | 票据签发后浏览器没传完就关了页面 |
| 提取器抛错 / 抽不出文字 | **200** | — | `extractStatus: "failed"` + `extractError`，**不是 HTTP 错误** |

**幂等**：已 `extracted` 的行**直接返回既有结果**，不重跑（提取只依赖文件内容，文件不可变）。

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
| POST | `/api/v1/courses/:id/syllabus` | 取上传票据（两步式直传第 1 步，**非 multipart**） | P0-1-1 |
| GET | `/api/v1/syllabi/:id/download` | 签短时下载 URL（私有桶无永久 URL） | P0-1-1 |
| POST | `/api/v1/syllabi/:id/extract` | 提取文本（上传流程第 3 步，幂等） | P0-1-2 |
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
| 2026-09-02 | **§1.2 / §1.4 状态码调整**：Phase 0 不使用 403，「不属于当前用户」与「不存在」统一返回 404（文案「…不存在或无权访问」）。原「403 避免探测存在性」的**意图保留、手段改换** —— RLS 下要区分 403/404 必须用 service role 绕过 RLS 探测存在性，反而制造泄漏口子 | [ADR-010](./Decisions.md#adr-010)，Steven 拍板 |
| 2026-09-02 | **§3 上传改为两步式直传**（multipart 作废）：`POST /api/v1/courses/:id/syllabus` 改为 JSON 入参 + 签发 Storage 签名上传 URL；新增 `GET /api/v1/syllabi/:id/download` 签短时下载 URL。同步标注 `extractStatus` / `previewText` 为 P0-1-2 待补 | [ADR-009](./Decisions.md#adr-009)、`Database.md` 7.3、P0-1-1 |
| 2026-09-02 | **§3 新增 `POST /api/v1/syllabi/:id/extract`**（P0-1-2）：上传流程拆成「取票据 → 直传 → 提取」三拍，**修正原「201 响应带 previewText」的设计错误** —— 签票据时文件还没传上来，服务端无法提取。提取失败返回 **200 + `extractStatus: "failed"`**（不是 HTTP 错误），悬挂行返回 `409 file_missing`，已提取的行幂等返回既有结果 | P0-1-2、[ADR-010](./Decisions.md#adr-010) |
| 2026-09-02 | **PDF 提取器由 `pdf-parse` 2.4.5 换成 `pdfjs-dist` 5.4.296 legacy 构建**：`pdf-parse` 模块顶层无条件 `new DOMMatrix()`，而它的 DOMMatrix 靠 `require('@napi-rs/canvas')` 补，canvas 加载失败时只 warn 不赋值 → **Vercel 上该路由 import 即 500（空响应体，连不碰 PDF 的分支也 500）**；本地 macOS 因装有 23MB 原生二进制而全绿，是典型「本地全绿、线上全红」。响应体与错误语义不变，仅换提取器实现；同时修正响应示例里 `extractMethod` 注释误写的 `docx_text` / `pptx_text` | 生产事故复盘、`TechStack.md` 第 2 节 ⚠️ |
| 2026-09-02 | **§3 download 端点补 `404 file_missing`**：行在、文件不在（悬挂行）时，原本把 Storage 的 `NoSuchKey` 直接抛成 **500**。判定谓词抽到 `lib/syllabi.ts` 的 `isStorageObjectNotFoundError()`，由 download 与 extract 共用，避免两处各写一份再漏一次 | 端到端冒烟抓到的真 bug |
