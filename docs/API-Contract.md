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
      "upcomingTasks": [ { "id": "…", "title": "HW 3", "dueDate": "…" } ]   // 最多 2 条，见下方说明
    }
  ],
  "meta": { "total": 5 }
}
```

> **`upcomingTasks`（P0-1-9 补齐）**：每门课最多 2 条**未完成**任务，按 `dueDate` 升序
> （`null` 排最后）。已完成的不算 —— 卡片的语义是"这门课接下来要做什么"。
> **该字段可选**：缺失表示「没能加载到」，而不是「这门课没有任务」。
> 两者在 UI 上必须分开，把加载失败渲染成"没有任务"等于静默的错误数据（CodingRules 7）。
> `POST /api/v1/courses` 的响应不带这个字段（新建的课程还没有任务）。

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
  // ⚠️ 返回**完整的 Syllabus 对象**（比原示例的 { id, fileName, parseStatus } 更宽）：
  // 前端需要 extractStatus / parseError 才能渲染「解析失败，可重试」这类状态。
  "syllabus": { "id": "…", "fileName": "syllabus.pdf", "extractStatus": "extracted", "parseStatus": "completed", "parseError": null },
  // 没有 syllabus 时为 **null**（不是 {}）
  "gradeComponents": [ { "id": "…", "name": "Midterm 1", "weightPercent": 20, "notes": null, "isConfirmed": true } ],
  "outlineItems":    [ { "id": "…", "orderIndex": 1, "weekLabel": "Week 1", "topic": "Vectors" } ],
  "examDates":       [ { "id": "…", "examName": "Midterm 1", "examDate": "2026-10-15", "examTime": "7-9pm", "location": "…", "status": "confirmed" } ],
  "officeHours":     [ { "id": "…", "personName": "…", "dayOfWeek": "Monday", "startTime": "14:00", "endTime": "15:00", "location": "…" } ],
  "submissionPolicies": [ { "id": "…", "description": "…", "platformName": "Gradescope" } ]
}
```
缺失项返回 `[]`（**不是 `null`**），前端按"TBD"渲染。

**读逻辑只有一份**：`lib/course-detail.ts` 的 `loadCourseDetail()` 同时服务本端点与
详情页的服务端组件 —— 页面直查 DB（RLS 保护），不 fetch 自己的 API。

| 错误 | 状态码 | `error.code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthenticated` | |
| 非法 uuid | 400 | `bad_request` | |
| 不存在 / 不属于当前用户 / **已归档** | 404 | `not_found` | [ADR-010](./Decisions.md#adr-010)；归档 = 删除（§2 DELETE 语义），与保存端点一致 |

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
| `.pdf` | `unpdf` 1.8.1（内部是为 serverless 重打包的 pdfjs，`extractText(mergePages: false)` 逐页提取后拼接；**换行由 unpdf 按 `hasEOL` 补**，实测与手写拼接一致） | `pdf_text` |
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

触发 LLM 五板块抽取**并落库**。**同步返回 200**，不是 202 —— 见 [ADR-012](./Decisions.md#adr-012)。

```jsonc
// response 200
{
  "syllabus": { "id": "…", "parseStatus": "completed", "parseError": null },
  "sections": {
    "gradeComposition": [
      { "id": "…", "name": "Midterm", "weightPercent": 25, "notes": null,
        "isConfirmed": false, "source": "syllabus", "sourceExcerpt": "Midterm: 25%" }
    ],
    "courseOutline": [ { "id": "…", "orderIndex": 1, "weekLabel": "Week 1", "topic": "…", "source": "syllabus", "sourceExcerpt": "…" } ],
    "testDates":     [ { "id": "…", "examName": "Midterm 1", "examDate": "2026-10-15", "examTime": "7-9pm", "location": "…", "status": "confirmed", "isConfirmed": false, "source": "syllabus", "sourceExcerpt": "…" } ],
    "officeHours":   [ { "id": "…", "personName": "GSI Lee", "dayOfWeek": "Tuesday", "startTime": "14:00", "endTime": "15:30", "location": "…", "source": "syllabus", "sourceExcerpt": "…" } ],
    "submissionPolicy": [ { "id": "…", "description": "…", "platformName": "Gradescope", "source": "syllabus", "sourceExcerpt": "…" } ]
  },
  "okSections": ["gradeComposition", "courseOutline", "testDates", "officeHours", "submissionPolicy"],
  "failedSections": [],
  "meta": { "textLength": 5231, "truncated": false, "promptVersion": "v1" }
}
```

> ⚠️ **`sections` 里只有解析成功的板块才有键。** 解析失败的板块**不给空数组** ——
> 空数组会被前端当成"这份 syllabus 确实没有这块内容"，而"没解析出来"和"确实没有"是两件事。
> 判断"有没有这块内容"请用 `okSections` + 数组长度，不要用 `"officeHours" in sections`。

| 情况 | 状态 | code | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthorized` | |
| 非法 uuid | 400 | `bad_request` | |
| 不存在或不属于当前用户 | 404 | `not_found` | [ADR-010](./Decisions.md#adr-010) |
| 文本还没提取好 | 409 | `text_not_ready` | 上传流程第 3 拍没走完 |
| 已解析完成 | 409 | `already_parsed` | 不再烧一次 LLM，要重跑走 `/reparse` |
| 五个板块全失败 | **200** | — | `syllabus.parseStatus = "failed"`，原因在 `parseError` |
| 部分板块失败 | **200** | — | `parseStatus = "completed"` + `parseError` 写明失败板块；成功部分照常落库 |

> ⚠️ **`syllabi.parse_status` 只有 `completed` / `failed` 两态**，契约原写的 `partial` 不在 DB 的
> CHECK 约束里（`pending / processing / completed / failed`），写进去会被数据库直接拒绝。
> 部分失败的表达方式：`parse_status = 'completed'` + `parse_error` 写明失败了几块是哪几块。

### `GET /api/v1/syllabi/:id/parse-status`

⏸ **同步模式下本端点暂不实现**（归 P0-1-11）。同步返回时不存在"进行中"这个中间态，
端点没有东西可查。若 P0-1-11 要做板块级进度可视化，需先改回异步编排，
届时要先补一个「板块级进度」的存储落点（`llm_runs` 目前只有 `purpose` / `status`，
没有板块维度）并解决 Vercel 上响应返回后 pending promise 被冻结的问题。

### `POST /api/v1/syllabi/:id/reparse`
用当前 raw_text 重新解析（不重新上传文件），用于切了 LLM provider 或改了 prompt 之后重跑。
**无视 `parseStatus`，一定重跑**。响应同 `/parse`，但 `llm_runs.purpose` 的前缀是
`syllabus_reparse`（首次解析是 `syllabus_parse`）—— 两类调用分开记，才能对比"这次改动是变准了还是变糟了"。

---

## 4. 五个板块的保存（含修正 diff）

统一用 **`PUT` 全量替换该板块**（幂等，前端表单整体提交）：

> **读取路径（P0-1-6 定）**：五个板块**没有 GET 端点**。P0-1-6 的编辑表单初值由 dashboard
> 服务端组件直查五张表（`lib/sections.ts`，RLS 保护），**不走 API**；
> 完整的「课程详情含五板块」接口 `GET /api/v1/courses/:id` 归 **P0-1-8**。
> 因此 P0-1-8 开工时，读取端点是新做的，不是从 P0-1-6 拆出来的。

| 端点 | 板块 |
|---|---|
| `PUT /api/v1/courses/:id/grade-components` | 成绩构成 |
| `PUT /api/v1/courses/:id/outline-items` | 课程大纲 |
| `PUT /api/v1/courses/:id/exam-dates` | 考试日期 |
| `PUT /api/v1/courses/:id/office-hours` | Office Hour |
| `PUT /api/v1/courses/:id/submission-policies` | 提交政策 |

```jsonc
// request（以 exam-dates 为例；items 允许为空数组 = 清空该板块）
{
  "items": [
    { "id": "…(可选，不带 = 新增)", "examName": "Midterm 1", "examDate": "2026-10-15", "examTime": "7-9pm", "location": "…" },
    { "examName": "Final", "examDate": null, "examTime": null, "location": null }
  ]
}
// response 200 → { "data": [ 该板块的完整最新列表（含 id / source / isConfirmed）] }
```

**保存语义（P0-1-5b 已实现）**：
- 带 `id` 且库里存在 → 整行内容以表单更新；不带 `id` → 插入，`source = 'manual'`（活过重解析）；库里有、表单没有 → 删除。表单里带着库里已不存在的 `id` → 400（并发修改，请刷新重填）。
- `grade_components` / `exam_dates` 的所有提交行置 `is_confirmed = true`（保存 = 用户确认）。
- **`exam-dates` 不接受 `status`**：由 `examDate` 派生（有合法日期 = `confirmed`，否则 `tbd`），与解析侧 `normalizeExam()` 同一条规则。请求里传了 status 会被忽略而不是采信 —— 否则会出现"日期为空但状态是已确定"的矛盾数据。
- `outline-items` 的 `orderIndex` 由数组位置派生（从 1 开始），不接受客户端自报的序号。
- 归档课程返回 404（归档在本项目里就是删除，见 §2 的 DELETE 语义）。

**服务端做的三件事（`lib/parse/save.ts` + `lib/parse/corrections.ts`，无跨表事务）**：
1. 与库中现有值逐字段比对，**每一处差异写一条 `parse_corrections`**：
   - `edit` = 匹配行的每个变更字段一条（original → corrected）；`add` = 新增行每个有值字段一条；`delete` = 被删行每个原有值字段一条。`field_name` 存 DB 列名（如 `weight_percent`），值一律存 text；`outline` 的 `order_index` 不进 diff（重排序不算解析错误）。
   - 幂等保存（无差异）不写任何修正行。
2. **归因**：`syllabus_id` / `llm_run_id` 取「该课程最新一份 syllabus 的最近一次**成功**解析」（无则均为 null）。
3. 若板块是 **`exam-dates`** → **同步派生 `tasks` 记录**（ADR-004，`lib/sync/exam-tasks.ts`）：
   `source_id` 指向 `exam_dates.id`、`is_derived = true`、`tbd`/日期为空 → `due_date = null` 禁止编造；有日期 → 当日 23:59:59（`exam_time` 是自由文本，Phase 0 不解析）；用户改过的 `status`（pending/done）**不被重置**；考试行被删 → 派生 task 物理删除。

> 第 3 条是"课程页和总览页日期对不上"的唯一防线。派生逻辑集中在 `syncExamToTask()` 一处；解析落库（`/parse` `/reparse`）也会调用它，不只是保存端点。

| 错误 | 状态码 | `error.code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthenticated` | |
| 非法 uuid / 请求体不是 JSON / 校验失败 | 400 | `bad_request` / `validation_failed` | 文案带条目序号 |
| 课程不存在、不属于当前用户或已归档 | 404 | `not_found` | [ADR-010](./Decisions.md#adr-010) |
| 条目 id 不在库中 | 400 | `validation_failed` | `details.staleIds` 列出过期 id |

---

## 5. 任务

> **P0-1-9 交付范围**：`GET /api/v1/tasks` 与 `PATCH /api/v1/tasks/:id`。
> 另两个（`POST` 手动任务、`DELETE`）按 P0-1-9「仅 syllabus 数据」的范围**不做**。

### `GET /api/v1/tasks?range=7d&limit=50&offset=0`
总览页数据源，**合并 syllabus 考试与 Canvas 作业**（Phase 0 目前只有 syllabus 考试），按 `dueDate` 升序，`dueDate` 为 `null` 的排最后。

```jsonc
{
  "data": [
    {
      "id": "…",
      "courseId": "…", "courseName": "Math 53",
      "title": "HW 3",
      "dueDate": "2026-09-20T23:59:00-07:00",   // null = 未知 / TBD
      "taskType": "assignment",
      "source": "canvas",
      "status": "pending",
      "isDerived": false
    }
  ],
  "meta": { "total": 23 }
}
```

**查询参数**

| 参数 | 默认 | 说明 |
|---|---|---|
| `range` | `7d` | 时间**上界**：`<n>d`（1-365）或 `all`（不限）。**不设下界**，见下 |
| `limit` | `50` | 上限 200（契约 1.5） |
| `offset` | `0` | 非负整数 |

> ⚠️ **`range` 只设上界，不设下界**（P0-1-9 实现期决策）。
> `range=7d` 的语义是「**7 天内到期的 + 所有逾期未完成的**」，而不是字面上的「未来 7 天」。
> 逾期未完成任务是总览页最该被看见的信号，按字面理解成"未来 7 天"会把它们藏起来，
> 等于帮用户逃避 —— 与 Tempo「不隐藏问题」的原则冲突。
>
> ⚠️ **`dueDate` 为 `null` 的行必须保留**：`.lte('due_date', until)` 在 SQL 里对 NULL 求值
> 结果是 NULL（不成立），会让 TBD 任务整批消失。实现用 `or(due_date.lte.X, due_date.is.null)`。

**`meta` 暂不含 `staleWarning` / `lastSuccessfulSyncAt`**（原契约示例里有这两个字段）：
它们描述的是 **Canvas 同步状态**（`Sync-Strategy.md` 的陈旧告警），而 Phase 0 的 P0-1-9 只有
syllabus 数据、根本没有同步这回事。硬编码 `staleWarning: false` 等于告诉用户"数据很新鲜"——
那是静默的错误数据，比缺字段危险得多（与 P0-1-7 对 `upcomingTasks` 的同一判断）。
留到 **P0-2-7**（同步状态）与 **P0-2-11**（合并 Canvas 数据）再补。

**可见性**：只返回**未归档**课程的任务 —— 归档课程的任务从总览页隐藏（§2 DELETE 的级联语义）。
`tasks` 表没有 `user_id`，RLS 经 `courses.user_id` 判定（迁移 `20260902100000`），
而该策略**不看 `is_archived`**，所以归档过滤必须在查询里显式做（`loadActiveCourseIds()`）。

### `PATCH /api/v1/tasks/:id`
**只允许更新 `status`**（pending / done）—— 「标记任务完成」的唯一入口。

```jsonc
// request
{ "status": "done" }
// response 200 → 完整的 task 对象（含 courseName）
```

| 情况 | 状态码 | `error.code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthenticated` | |
| 非法 uuid | 400 | `bad_request` | |
| 请求体不是 JSON / 不是对象 | 400 | `bad_request` | |
| 缺 `status` / 值不是 pending·done | 400 | `validation_failed` | |
| **派生任务**传 `title` / `dueDate` | **422** | `derived_task_immutable` | 错误信息引导去课程页改 `exam_dates`；`details.immutableFields` 列出被拒字段 |
| 非派生任务传 `title` / `dueDate` | 400 | `validation_failed` | 手动任务编辑不在 P0-1-9 范围，**明确拒绝而非静默忽略** |
| 不存在 / 不属于当前用户 / **课程已归档** | 404 | `not_found` | [ADR-010](./Decisions.md#adr-010) |

> **422 与 400 的分工**：422 是 ADR-004 在接口层的强制点 —— 派生任务的权威源是 `exam_dates`，
> 改 task 的 title / dueDate 会在下次保存或同步时被覆盖回去，所以必须拦下来并把用户**引导到正确的地方**。
> 非派生任务的情形只是"本阶段不支持"，用 400 就够。
>
> **已完成的任务不隐藏**：`GET` 照常返回（`status = "done"`），折叠由前端做
> （Steven 拍板 2026-09-03：横线划掉 + 折叠，不是隐藏、不是置灰混排）。

### `POST /api/v1/tasks` — 创建手动任务（`source = manual`）
### `DELETE /api/v1/tasks/:id` — 软删除，**仅允许 `source = manual`**（同步来的任务不能被用户删，否则下次同步又回来）

> 以上两个**未实现**：P0-1-9 范围是「仅 syllabus 数据」，手动任务的增删不在本卡。

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
| GET/PATCH/DELETE | `/api/v1/courses/:id` | 课程详情（含五板块）/ 更新 / 归档 | P0-1-7, **✅ P0-1-8（GET 已实现）** |
| POST | `/api/v1/courses/:id/syllabus` | 取上传票据（两步式直传第 1 步，**非 multipart**） | P0-1-1 |
| GET | `/api/v1/syllabi/:id/download` | 签短时下载 URL（私有桶无永久 URL） | P0-1-1 |
| POST | `/api/v1/syllabi/:id/extract` | 提取文本（上传流程第 3 步，幂等） | P0-1-2 |
| POST | `/api/v1/syllabi/:id/parse` | 五板块抽取 + 落库（同步 200，[ADR-012](./Decisions.md#adr-012)） | P0-1-5a |
| GET | `/api/v1/syllabi/:id/parse-status` | 解析进度 | ⏸ P0-1-11，同步模式下无中间态可查 |
| POST | `/api/v1/syllabi/:id/reparse` | 强制重跑解析 | P0-1-5a |
| PUT | `/api/v1/courses/:id/{grade-components,outline-items,exam-dates,office-hours,submission-policies}` | 五板块保存 + diff | ✅ P0-1-5b（见第 4 节；前端表单 P0-1-6） |
| GET | `/api/v1/tasks` | 总览任务列表 | ✅ P0-1-9, P0-2-11 |
| PATCH | `/api/v1/tasks/:id` | 标记完成（只改 status） | ✅ P0-1-9 |
| POST/DELETE | `/api/v1/tasks[/:id]` | 手动任务增删 | ⚪ 未实现（P0-1-9 仅 syllabus 数据） |
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
| 2026-09-02 | **PDF 提取器定为 `unpdf` 1.8.1**（中间态曾换到 `pdfjs-dist` legacy，**已作废**）：`pdf-parse` 2.4.5、`pdfjs-dist` 的现代构建**和 legacy 构建**，在 Node 下都于模块作用域 `new DOMMatrix()`，而 DOMMatrix 靠 `require('@napi-rs/canvas')` 补，canvas 加载失败时只 warn 不赋值 → **Vercel 上该路由 import 即 500（空响应体，连不碰 PDF 的分支也 500）**；本地 macOS 装有 23MB 原生二进制而全绿，是典型「本地全绿、线上全红」。unpdf 自带为 serverless 重打包的 pdfjs（worker 内联 + 剥浏览器 API），**零运行时依赖、不需要 canvas**，线上实测通过。响应体与错误语义不变，仅换提取器实现；同时修正响应示例里 `extractMethod` 注释误写的 `docx_text` / `pptx_text` | 生产事故复盘、`TechStack.md` 第 2 节 ⚠️、[ADR-011](./Decisions.md#adr-011) |
| 2026-09-02 | **§3 download 端点补 `404 file_missing`**：行在、文件不在（悬挂行）时，原本把 Storage 的 `NoSuchKey` 直接抛成 **500**。判定谓词抽到 `lib/syllabi.ts` 的 `isStorageObjectNotFoundError()`，由 download 与 extract 共用，避免两处各写一份再漏一次 | 端到端冒烟抓到的真 bug |
| 2026-09-03 | **§3 `/parse` 改为同步 200 + 落库规则收敛**（[ADR-012](./Decisions.md#adr-012)，P0-1-5a）：不再 202+轮询；部分失败 = `parseStatus='completed'` + `parseError` 写明失败板块；`GET /parse-status` 归 P0-1-11 待定 | ADR-012 |
| 2026-09-03 | **§4 五板块保存契约按实现收敛**（P0-1-5b）：① request 不再含 `status`（由 `examDate` 派生，防止"无日期但已确认"的矛盾数据）；② response 明确为 `{ data: [...] }`；③ 修正粒度定为**字段级**（edit/add/delete 三类统一，`order_index` 除外）；④ 归因规则明确为「最新 syllabus 的最近一次成功解析」；⑤ 错误码表补齐（含 `details.staleIds`、归档课程 404）。均为实现期决策，无行为层面的需求变更 | P0-1-5b |
| 2026-09-03 | **§4 补「读取路径」说明**（P0-1-6）：五板块**不设 GET 端点** —— 编辑表单初值由 dashboard 服务端组件直查五表（`lib/sections.ts`，RLS 保护），完整接口 `GET /api/v1/courses/:id`（含五板块）归 P0-1-8。写清这一点是为了避免后续会话误以为读端点已存在 | P0-1-6 |
| 2026-09-03 | **§5 任务端点按 P0-1-9 实现落地**（新增 `GET /api/v1/tasks`、`PATCH /api/v1/tasks/:id`，此前两个端点都不存在）：① `range` **只设上界不设下界** —— 逾期未完成的任务必须留在列表里；② `meta` **不返回** `staleWarning` / `lastSuccessfulSyncAt`（Canvas 同步状态，Phase 0 无同步，硬编码 false 是静默的错误数据），留 P0-2-7 / P0-2-11；③ PATCH 只允许改 `status`，派生任务传 title/dueDate → `422 derived_task_immutable`，非派生任务传 → `400 validation_failed`（明确拒绝而非静默忽略）；④ 归档课程的任务一律隐藏（tasks 的 RLS 不看 `is_archived`，必须显式过滤）；⑤ `POST` / `DELETE`（手动任务）明确标注未实现 | P0-1-9 |
| 2026-09-03 | **§2 补 `upcomingTasks` 的实现说明**（P0-1-9）：契约早有此字段但端点一直没返回，本次补上（最多 2 条、只含未完成、按 dueDate 升序）。**字段可选**：缺失表示"没加载到"而非"没有任务"，两者在 UI 上必须分开 | P0-1-9 |
| 2026-09-03 | **§2 `GET /api/v1/courses/:id` 按 P0-1-8 实现收敛**：① `syllabus` 由「只给 `{id,fileName,parseStatus}`」放宽为**返回完整 Syllabus 对象** —— UI 需要 `extractStatus` / `parseError` 才能渲染「解析失败可重试」；② 补错误码表（401 / 400 / 404），**已归档课程按 404 处理**（归档 = 删除，与 §4 保存端点一致）；③ 读逻辑收敛到 `lib/course-detail.ts`，端点与详情页服务端组件共用一份 | P0-1-8 |
