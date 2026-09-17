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
| 502 | Canvas 上游故障（5xx / 超时 / 网络 / 坏 JSON） | `upstream_error` |
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
      "canvasCourseId": "1558822",        // P0-2-4 新增，未关联时为 null
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

> **`canvasCourseId`（P0-2-4 新增）**：关联的 Canvas 课程 ID，未关联时为 `null`；
> `canvasLinked` 由它是否为空派生。
> 只给布尔值不够 —— 关联 UI 要显示"关联的是哪门课"，换关联和解除关联都得指着这个 ID 说；
> 它不是凭据也不是敏感信息（只是一个课程号），可以安全下发。

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
总览页数据源，**合并 syllabus 考试与 Canvas 作业**（✅ P0-2-11 已核对：两类在同一列表），按 `dueDate` 升序，`dueDate` 为 `null` 的排最后。

两类来源在 `tasks` 表里的形状（两个写入方各自按 `source` 收口，互不干扰 —— 合并展示的最大风险是"一方把另一方的行当缺席删掉"，改任何一条查询都要重新确认这点）：

| 来源 | 写入方 | `source` | `taskType` | `isDerived` | 删除语义 |
|---|---|---|---|---|---|
| syllabus 考试派生（`exam_dates` 是权威源，ADR-004） | `lib/sync/exam-tasks.ts` | `syllabus` | `exam` | `true` | 考试行被删 → **物理删除**（它是缓存不是用户数据） |
| Canvas 作业同步 | `lib/sync/canvas-tasks.ts` | `canvas` | `assignment` | `false` | 外部源删了 → **软删除**（老师误删后恢复很常见） |

两者**都不写 `status`**（用户勾的"已完成"不被任何同步打回 pending，`Database.md` 4.1）。

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

**`meta` 不含 `staleWarning` / `lastSuccessfulSyncAt`**（原契约示例里有这两个字段）—— ✅ **P0-2-11 收口：确定不加。**

它们描述的是 **Canvas 同步状态**（`Sync-Strategy.md` 的陈旧告警）。P0-1-9 时期不加的理由是
「只有 syllabus 数据，根本没有同步这回事，硬编码 `false` 等于告诉用户"数据很新鲜"」——
那是静默的错误数据，比缺字段危险得多。P0-2-7 已用**另一条路径**解决了这个需求：dashboard
顶部的 `SyncStatusBar` 由服务端组件直读 `courses` 的 `last_synced_at` / `sync_status` 渲染，
**不轮询、不建 `GET /sync/status` 端点**（该端点已标注"决定不实现"）。

所以这两个字段永久不进 `tasks` 的 `meta`：同步状态是**课程级**的（每门课各有一份），
塞进任务列表的 meta 意味着"一批任务共用一个布尔值"，粒度不对，且与状态条重复。

**可见性**：只返回**未归档**课程的任务 —— 归档课程的任务从总览页隐藏（§2 DELETE 的级联语义）。
`tasks` 表没有 `user_id`，RLS 经 `courses.user_id` 判定（迁移 `20260902100000`），
而该策略**不看 `is_archived`**，所以归档过滤必须在查询里显式做（`loadActiveCourseIds()`）。

### 5.1 总览可视化的口径（✅ P0-3-7a；P0-3-16 删债条、加今日任务）

> 这一节写的不是接口，而是**数字怎么算**。执行卡把「先定义进度的分子分母」列为 P0-3-7 的硬前置：
> 口径没定，既写不出代码，也没法判断算得对不对。代码实现在 `lib/tasks/progress.ts`（周历 / 最近的考试）
> 与 `lib/tasks/today.ts`（今日任务），**纯函数、零 IO**，可直接喂假数据跑。
> **总览页在服务端直读，不新建端点**（沿用 P0-2-7 的决策：不轮询、不为一个页面开 API）。

#### 为什么不做「进度条」

`courses` 没有学分、`tasks` 没有工作量字段 —— 「进度」**没有天然分母**。退而求其次用"件数"时，
分母还会**自己长大**：Canvas 只回传老师**已发布**的作业，老师每周新发 → 全学期口径的百分比会**倒退**
（60% → 40%），用户会以为算错了。ADR-016 R5 也禁止庆祝性激励。

所以总览页给的**不是**「完成了多少」，而是「**欠了多少**」。

#### 今日任务口径（`buildTodayTasks()`，P0-3-16）

取代原「已到期作业」债务条（**已于 P0-3-16 删除**：`debt-bar.tsx` / `loadDebtTasks` / `debtWindow` /
`classifyDebt` / `summarizeDebt` 全部移除）。它回答的不是"我欠了多少"，而是「**今天大概要花多少力气**」：

| 组 | 判据 | 权重 |
|---|---|---|
| **逾期未完成**（红，置顶） | 到期日**已过**且未完成，**且** `submission_state ∈ {unsubmitted, missing}` | 各 1 件 |
| **今天到期** | 按**学校本地日历日** = 今天 | 各 1 件（100%） |
| **未来 `horizonDays`（=7）天** | `0 < 剩余天数 ≤ 7` | 各 `1 / 剩余天数`（9/17 看 9/21 到期 = 1/4 = **25%**） |

**今日工作量** = 三组权重之和（一个**加权件数**）—— 越远的事，对今天的压力越小。
剩余天数按**日历键**相减（`lib/time.ts`），不受时区偏移 / 夏令时影响。

> 🔴 **红组只收 Canvas 明确说没交的**（`unsubmitted` / `missing`）。`submission_state = NULL`
> （Canvas 不追踪：`on_paper` / `none` / 考试派生）与 `external_unconfirmed`（Gradescope 等 LTI）
> **不进红组** —— Canvas 不知道你交没交，标红就是诬告（ADR-013）。这类任务归 `P0-3-17` 的「需手动确认」。
>
> 🔴 **已完成（`isEffectivelyDone()`）一律不进** —— 与周历 / 待办清单**共用同一个完成判定**。
> **纯展示、不改写任何状态**（ADR-015：`status` / `submission_state` 只读）。
>
> **取数复用总览清单**（`loadTasks`，窗口 = now + 7d，正好含「逾期 + 今天 + 未来 7 天」）——
> 因此删掉债务条后，总览页从**四路查询降到两路**（`loadTasks` + `loadUpcomingExams`）。

#### 周历口径（`buildWeekCalendar()`）

| 项 | 定义 |
|---|---|
| 跨度 | **滚动 7 天、今天在最左**（不用"本周一–周日"：周日打开会看到一个基本空的日历） |
| 收哪些任务 | **全部来源**（含考试派生 —— 周历**要**显示考试） |
| 排除 | 已完成（`isEffectivelyDone()`，与待办清单**共用同一个函数**） |
| 逾期 | 落在 7 天窗口外且已过期的 → 收成**顶部一整条**（过去的日子没人会往回翻） |
| 日期待定 | `due_date IS NULL` → 底部单列，**不编日期塞进格子**（`Database.md` 3.9） |
| 同日内排序 | 按截止时刻升序 |
| 逾期条排序 | 最近逾期的在最前 |

> ⚠️ **周历与「今日任务」都收全部来源、都用 `isEffectivelyDone()`** —— 同一条任务不会
> 在一个区块算"已完成"、在另一个区块算"待办"。**改取数 / 改完成判定前先读 `lib/tasks/progress.ts` 文件头。**

#### 「最近的考试」条（`buildUpcomingExams()`）

| 项 | 定义 |
|---|---|
| 数据源 | `task_type = 'exam'`（**不是 `is_derived`** —— 后者语义是"派生的缓存"，将来会有非考试的派生任务） |
| 时间范围 | **不受 7 天窗口限制** —— 只排除已过去与已完成的 |
| 条数 | 默认 3 条，按日期升序 |
| 排除 | 已完成 ｜ `due_date IS NULL`（留在周历底部「日期待定」）｜ 已过期 |

> 🔴 **为什么必须单独一条**（2026-09-13 实测触发）：Steven 的 4 场考试**全部在 7 天之外**
> （最近一场 Unit 1 Exam 还有 9 天）。只做周历的话，日历里**一场考试都看不到** ——
> 执行卡要求的「考试日期并进主 Calendar」等于没兑现。而考试是最稀疏、最高风险的一类：
> 一门课一学期 3-5 次，漏看一次期中的代价远大于漏做一个作业。
>
> 取数先取一批候选（`EXAM_POOL = 50`）再在纯函数里筛掉已完成的、切前 3 ——
> 若 SQL 直接 `.limit(3)`，取回的三条可能恰好都被勾完了，条上会白白显示为空。

#### 时区（`lib/time.ts`）

所有"这是哪一天"的判定统一走 `schoolDayKey()`（`America/Los_Angeles`，ADR-004），
并且必须在**服务端**算好再往下传 —— 客户端各算一遍就是 hydration mismatch（P0-3-10 的教训）。

#### 明确不做

❌ 饼图 ｜ ❌ 课程完成度 % ｜ ❌ 学期总进度环 / 仪表盘 ｜ ❌ streak / 连续天数（ADR-016 R5）
｜ ❌「你已完成 47 项」虚荣大数字（与"少打开 Canvas"无关）｜ ❌ 庆祝动画（激励排在最后，M3 不做）

### `PATCH /api/v1/tasks/:id`

可改两类字段：

| 字段 | 准入 | 说明 |
|---|---|---|
| `status`（pending / done） | **任何来源** | 「标记任务完成」的唯一入口，用户主权 |
| `title` / `dueDate`（内容字段） | **仅 `source='manual'`** | P0-3-8b：对话框「改期 / 改名」的落写入口 |

```jsonc
// 改状态
{ "status": "done" }
// 改内容（P0-3-8b，仅手动任务）
{ "dueDate": "2026-09-20" }   // 或 { "title": "…" }；可同时传
// response 200 → 完整的 task 对象（含 courseName）
```

| 情况 | 状态码 | `error.code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthenticated` | |
| 非法 uuid | 400 | `bad_request` | |
| 请求体不是 JSON / 不是对象 | 400 | `bad_request` | |
| 既无 `status` 也无 `title`·`dueDate` | 400 | `bad_request` | |
| `status` 值不是 pending·done | 400 | `validation_failed` | |
| `title` 为空串 | 400 | `validation_failed` | |
| `dueDate` 无法解析 | 400 | `validation_failed` | 复用 `normalizeDueDate`（禁止编造日期） |
| **派生任务**传 `title` / `dueDate` | **422** | `derived_task_immutable` | ADR-004：引导去课程页改 `exam_dates`；`details.immutableFields` 列出被拒字段 |
| **非 manual 任务**传 `title` / `dueDate` | **422** | `source_not_editable` | P0-3-8b：`source ∈ {canvas, syllabus}` 的内容真相在源头，改了会被同步覆盖；`details.source` 给出实际来源 |
| 不存在 / 不属于当前用户 / **课程已归档** | 404 | `not_found` | [ADR-010](./Decisions.md#adr-010) |

> 🔴 **为什么内容字段按 `source` 分准入**（P0-3-8b）：绕过去改 = 造一个下次同步就被覆盖的假相。
> 手动任务（`manual`）真相在 Tempo → 放行；Canvas（`canvas`）真相在 Canvas、考试（派生）真相在
> `exam_dates` → 均 422 并**把用户引导到正确的地方**，而不是静默忽略（静默忽略会让前端以为改成功了）。
>
> **已完成的任务不隐藏**：`GET` 照常返回（`status = "done"`），折叠由前端做
> （Steven 拍板 2026-09-03：横线划掉 + 折叠，不是隐藏、不是置灰混排）。

### `POST /api/v1/tasks` — 创建手动任务（`source = manual`）

- 请求体 `{ tasks: [...] }`（批量）或单条对象；字段 `courseId` / `title` / `taskType` / `dueDate`。
- 路由层**强制** `source='manual'` / `status='pending'` / `is_derived=false` / `submission_state=null`
  —— **不接收**客户端传这几个字段（写入闭环取值，见 `lib/tasks/manual.ts`）。
- `taskType` 只接受 `assignment` / `reading` / `other`；**`exam` 被拒**（权威源是 `exam_dates`，ADR-004）。
- 课程归属显式校验（非当前用户未归档课程 → 404）。响应 **201** + 建成任务数组。

### `DELETE /api/v1/tasks/:id` — 软删除，**仅允许 `source = manual`**

- 置 `is_deleted = true`（软删，不物理删）。
- **同步来的任务（canvas / syllabus）一律拒绝**：删了下次同步又回来，等于"删了个寂寞"还制造困惑 → 引导去源头。
- 重复删除返回 404（幂等）。

> ✅ **`POST` / `DELETE` / `PATCH` 内容编辑已由 P0-3-8 / P0-3-8b 实现**（原 §5 的「未实现」注记作废）。

### `POST /api/v1/tasks/parse` — 课程更新解析（P0-3-8，**不落库**）

对话框「扔进一段课程更新 → 结构化预览」的服务端一半。

```jsonc
// request
{ "text": "Homework 7 截止改到 9/20", "courseId": "…" }
// response 200 —— ⚠️ 只产预览，不写 tasks
{
  "data": {
    "tasks": [ { "title": "Homework 7", "taskType": "assignment", "dueDate": "2026-09-20", "notes": null } ],
    "warnings": []
  }
}
```

- LLM 走 `runStructured`（`purpose='course_update_parse'`，温度 0，审计落 `llm_runs`）。
- **绝不产出 `exam`**：考试日期变更进 `warnings` 提示「请到课程页更新」（ADR-004）。
- `dueDate` 未给则 `null`（禁止编造）。课程归属校验同上。LLM 失败 → 502 `llm_failed`。

### `POST /api/v1/tasks/parse-image` — 课程更新截图解析（P0-3-9，**不落库**）

对话框「扔进一张截图 → 结构化预览」的服务端一半。**与 `/parse` 同形状响应**，下半段（先检索 → 消歧 → 确认 → 落写）完全复用（P0-3-8b）。

```jsonc
// request —— 图片由浏览器压缩后 base64 直传，服务端即用即弃（不落 Storage）
{ "courseId": "…", "image": { "mediaType": "image/jpeg", "dataBase64": "…" } }
// response 200 —— ⚠️ 只产预览，不写 tasks
{
  "data": {
    "tasks": [ { "title": "Homework 6", "taskType": "assignment",
                "dueDate": "2026-09-20", "submitted": true, "notes": "Gradescope 提交成功页" } ],
    "warnings": []
  }
}
```

- **多模态 provider = Qwen 通义千问（中国区 DashScope）**（[ADR-018](./Decisions.md#adr-018)）：`runStructured` 传 `capability:'vision'`，默认 `qwen-vl-plus-latest`（可用 `LLM_MODEL_VISION` 覆写；需切回 Claude 时设 `LLM_PROVIDER_VISION=claude`）。文本档仍走 DeepSeek，**五板块解析零回归**。
- `submitted` 字段：识别到「已提交 / 提交成功页 / Turned in」→ `true`，未交待办 → `false`，看不出 → `null`。**仅作提示**，前端据此把任务默认勾成「标记完成」；落写时只经 `PATCH status`（用户主权），**绝不写 `submission_state` / `submitted_at`**（ADR-015）。
- **图片闸门**：仅收 `image/png` / `image/jpeg` / `image/webp`；base64 解码后 > 5MB → 400。HEIC 等不支持格式明确拒绝（不引转码依赖）。闸门逻辑有纯函数回归 `npm run regress:vision`。
- **截图不落库**（ADR-014「少一处数据少一处合规义务」）：一次性输入，零存储 = 零孤儿文件 + 零截图 PII 留存。
- **🔴 fail closed**：视觉未配置（`DASHSCOPE_API_KEY` 缺失）/ 超时 / 调用失败 → 502 `llm_vision_failed`，文案明确「截图识别服务暂不可用，请改用文字」。**不允许**静默降级成「没识别出任务」（那会把"服务坏了"伪装成"你这张图没内容"）。
- 其余约束与 `/parse` 一致：`exam` 不产出、课程归属校验、`dueDate` 缺失填 `null`。审计 `purpose='course_update_vision'`。

### `GET /api/v1/tasks/search?courseId=<uuid>&q=<标题文本>&limit=5` — 任务候选检索（P0-3-8b）

对话框「**先检索现有任务**」的服务端一半：给定课程 + 一段标题，返回该课里最像的现有任务。

```jsonc
{
  "data": [
    { "id": "…", "title": "HW 7", "dueDate": "2026-09-17T23:59:59Z",
      "taskType": "assignment", "source": "manual", "isDerived": false, "score": 1 }
  ]
}
```

- **确定性匹配、不用 LLM**（`lib/tasks/match.ts`）：缩写归一（HW==Homework）+ 编辑距离 + 二元组 Dice；
  **不写 `llm_runs`、不花 token**。理由：LLM 会幻觉出不存在的任务 id，而改错用户的日程代价与幻觉进日程同级。
- 各来源候选**一并返回**（manual / canvas / syllabus），谁能改由前端判（只有 `manual` 可改，见上 PATCH）。
- `q` 为空 → 返回 `[]`（不是错误）。`limit` 默认 5、上限 20。
- 同名任务返回按 `score` 降序的多个候选，由**用户消歧**（0 命中 → 新增；有命中 → 列举选择）。

### `POST /api/v1/email/inbound` — 邮件入站 webhook（P0-3-11，**落写仅 `status='done'`**）

由 Cloudflare Email Routing Worker 转发调用（见 [ADR-019](./Decisions.md#adr-019)）：发往 `inbound+<token>@<域>` 的邮件 → Worker POST `{ to, from, subject, textBody }` 到本端点。

```jsonc
// request —— Cloudflare Worker 转发，Bearer INBOUND_EMAIL_SECRET 鉴权
{ "to": "inbound+<token>@tempo.app", "from": "no-reply@gradescope.com",
  "subject": "Submission Confirmation", "textBody": "Your submission for Homework 6 was received." }
// response 200 —— 永远 2xx（避免邮件网关重试/退信循环）；结果如实回传
{ "data": { "status": "processed", "action": "mark_done", "taskId": "…", "event": "submitted" } }
```

- **鉴权**：与定时端点同款恒定时间 + fail closed（`authorizeCronRequest`，`INBOUND_EMAIL_SECRET`）。
- **用户识别只用密址 token**：从 `to` 解出 `<token>` → 查 `profiles.inbound_token`。**绝不**用 `from` 识别（可伪造）。token 不存在 → `unknown_address`，邮件被静默接受并丢弃。
- **解析走文本档 DeepSeek（中国，符合 O-08）** `purpose='email_inbound_parse'`。失败 → 仅记审计日志，不落写。
- **🔴 落写纪律**：识别到「已提交」且确定性匹配到现有任务时 `PATCH status='done'`；**绝不自动新建任务、绝不自动改 dueDate**；**绝不写 `submission_state` / `submitted_at`**（ADR-015）。其它事件（改期 / 新作业 / 无关）只入 `email_inbound_events` 审计日志。
- 每次入站都写 `email_inbound_events`（含 `from` / `subject` / 事件 / 动作），`user_id` 可空（未知地址也能记）。

### `GET /api/v1/email/address` — 当前用户的入站密址（P0-3-11）

```jsonc
// response 200
{ "data": { "address": "inbound+<token>@tempo.app" } }
```

- 走用户会话（RLS），非内部端点。token 首次访问时**懒生成**并写回 `profiles.inbound_token`，之后稳定不变。
- 设置页据此展示该地址与转发说明。

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
- `expiresAt` **必填**，取用户实际填写值。~~未填则存 `null`，服务端不做任何估算~~ → ⛔ **已被 2026-09-04 P0-2-1b 实测推翻**：bCourses 的 token 过期时间是强制必填项（弹窗 date + time 均带 `*`），用户手上必然有过期时间。校验规则：必填 / ISO 8601 / 必须晚于当前时间 / 距今不超过 90 天（实测上限）。见 `Sync-Strategy.md` 第 10 节。
- `canvasDomain` 只接受纯主机名（`bcourses.berkeley.edu`），拒绝协议 / 端口 / 路径 / IP / localhost / 内网地址 —— 服务端会拿这个域名发请求，不校验等于开一个 SSRF 口子（P0-2-2 实现）。
- **响应体不含任何密钥字段**（`CanvasCredentialMeta` 类型层面即无此字段，见 `types/canvas.ts`）。
- ~~保存后立即触发一次同步~~ → ⏸ **P0-2-2 未实现**：同步编排属 P0-2-5，届时在此接入。

### `GET /api/v1/canvas/credentials`
只返回元数据：`status` / `expiresAt` / `lastUsedAt` / `lastErrorAt` / `lastErrorMessage` / `canvasDomain`。**不含任何密钥字段。**

### `DELETE /api/v1/canvas/credentials` — 撤销授权（✅ P0-2-9 已实现）
删除加密凭证 + 将 `status` 置为 `revoked` + 停止同步。**已同步的 `tasks` 保留**（用户的学习记录不该因为断开连接而消失），**各门课的 `canvas_course_id` 关联同样保留**（只断凭据；重新连接后立刻恢复同步，不必逐门课重新关联）。同步状态显示为"未连接"。

| 情形 | HTTP | 错误码 | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthenticated` | |
| 没有凭据 **或已经撤销过** | 404 | `not_found` | ADR-010：不存在与越权统一口径。**重复撤销是幂等的**，`revoked_at` 不刷新 |

> 🔴 **实现注意（P0-2-9 踩到，别改回去）**：`secret_encrypted` 是 `NOT NULL`，
> 且 `runCanvasSync` 的顺序是 `loadDecryptedCredential()`（内部**先 `decryptSecret()`
> 再返回 status**）→ 判空 → **才**判 `status !== 'active'`。所以"删除加密凭证" =
> **用占位密文覆盖**（`encryptSecret('revoked')`），**不能置空也不能置空串** ——
> 空串会让 `decryptSecret('')` 抛错，同步从"优雅跳过 `credential_inactive`"
> 退化成"整趟 500"。占位密文格式合法、解密成功，随后被 status 检查拦下，
> 一个请求都不会发给 Canvas；原 token 被覆盖后不可恢复。

### `GET /api/v1/canvas/courses`
服务端代理拉取用户的 Canvas 课程列表，供关联 UI 使用。**忠实返回全部 active enrollment 课程（含 term），代理层不做学期/教学课程筛选** —— 是否过滤掉 "Default Term"/"Projects" 里的入学流程类模块（GBO / PartySafe 等）是 P0-2-4 关联 UI 的产品决策。

```jsonc
// response 200
{ "data": [ { "externalId": "1557957", "name": "MATH 53-LEC-001", "term": "Fall 2026" } ] }
```
- `name` = Canvas 的 `course_code`（非完整课程名）—— 关联 UI 需靠它区分同名课程的 lecture/section（Steven 账号实测 Math 53 分 LEC/DIS 两个 id）。
- `term` = Canvas term 名，可能为 `"Default Term"` / `"Projects"`（入学培训类模块的 term），缺失时为 `null`。
- ⚠️ **只读课程列表**，不返回成绩、花名册等任何其他信息（最小权限，见 `Security-Privacy.md`）。

**错误码**（P0-2-3 实现补充）：

| HTTP | `code` | 触发 |
|---|---|---|
| 401 | `unauthenticated` | 未登录 |
| 404 | `not_found` | 未连接 Canvas（无凭据；与 `GET /api/v1/canvas/credentials` 同口径，ADR-010） |
| 401 | `credential_invalid` | 已连接但 Canvas 拒绝该 token（401/403）→ UI 应引导用户重新生成 |
| 429 | `rate_limited` | Canvas 限流 |
| 502 | `upstream_error` | Canvas 上游故障（5xx / 超时 / 网络 / 坏 JSON）。这是"服务端代理第三方"失败，不伪装成 Tempo 自己的 500 |


### `POST /api/v1/courses/:id/canvas-link` — 关联（✅ P0-2-4 已实现）
```jsonc
// request  { "externalCourseId": "1558822" }   // Canvas 课程 ID（字符串，非数字）
// response 200 → course 对象（canvasCourseId 已填上、canvasLinked: true）
```

- `externalCourseId` 必填，字符集 `[A-Za-z0-9_-]`、长度 1–64。
  Canvas 给的是数字 ID，Tempo 当字符串存（ID 不参与算术）。
  ⚠️ **不校验这个 ID 在 Canvas 上是否真的存在** —— 那要多发一次上游请求（连带限流与失败分支），
  而 UI 只能从列表里选；直接调 API 填错了，最坏是同步时拉不到作业（P0-2-5 会明确报错）。
- ⏸ **不触发同步**（契约原文写了"并触发一次该课程的同步"）：同步编排是 P0-2-5，
  现在塞一个空跑的同步调用等于给假的成功信号。

**409 的三种情形（都说"已关联"，但含义不同，文案必须分开）**

| 情形 | 响应 | 文案 |
|---|---|---|
| 这门 Tempo 课已关联**另一个** Canvas 课 | 409 `already_linked` | 请先解除关联 |
| 这个 Canvas 课已被**另一门 Tempo 课**关联 | 409 `already_linked` | 已关联到「课程名」，一门 Canvas 课只能关联一门 Tempo 课 |
| 重复提交**同一个** ID | **200 幂等**（不报错） | — |

> 第三条是对契约原文"重复关联 → 409"的**收敛**：契约当初写的是防"用户重复点按钮产生脏数据"，
> 但"再点一次已关联的那一项"在 UI 上是常见动作，为此弹一个报错是把防呆用错了地方。
> 真正的脏数据风险（同一 Canvas 课挂两门 Tempo 课、静默换关联）仍然用 409 挡着。

**其余错误码**：未登录 401 `unauthenticated` ｜ 非法 uuid / 请求体不是 JSON / `externalCourseId` 不合法 → 400 ｜
**课程不存在、不属于当前用户、已归档 → 404 `not_found`**（ADR-010 + 归档=删除语义）。

### `DELETE /api/v1/courses/:id/canvas-link` — 解除关联（✅ P0-2-4 已实现）
置 `canvas_course_id = null`，返回更新后的 course 对象。

- **幂等**：本来就没关联时重复调用返回 200 + 当前状态，不报错（多标签页重复点的场景）。
- **归档课程 → 404**（与 POST 同口径）。
- ⏸ 契约原文"解除后该课程的 Canvas 任务保留但标记为不再更新（`last_seen_at` 停止刷新）"**尚未实现**：
  Phase 0 此刻还没有任何 `source = canvas` 的任务（同步在 P0-2-5）。解除只清关联本身，
  `last_synced_at` / `sync_status` / `sync_error` **不动** —— 那是真实的同步历史，不该被抹掉。
  等 P0-2-5 落了 canvas 任务、P0-2-7 做同步状态 UI 时再定"已解除关联"怎么显示。

### `POST /api/v1/sync/now`（✅ P0-2-5 已实现，P0-2-6 第一拍扩展 trigger 入参）
手动/打开时触发同步。遍历**已关联 Canvas 且未归档**的课程，**串行**拉取 `GET /api/v1/courses/:id/assignments`，对齐到 `tasks`。服务端按 `Sync-Strategy.md` 节流（手动 30s / 自动 60s），超限返回 `429` + `retryAfter`。

**请求体（可选，P0-2-6 起）**：

```jsonc
// request（可选；省略 body / 非法 JSON / 不带 trigger 字段 → 一律按 manual 处理，兼容 P0-2-5 时期的裸 POST）
{ "trigger": "manual" }   // 或 "app_open"
```

| `trigger` | 节流窗口 | 调用方 |
|---|---|---|
| `manual`（默认） | 30s | 手动「同步 Canvas」按钮 |
| `app_open` | 60s | 打开应用 / 标签页重新聚焦时（客户端静默触发） |

- 两种 trigger **共用同一个节流窗口**（按最近一次 `sync_runs.started_at` 判断，不区分来源）—— 刚手动同步完，立即聚焦标签页不会再触发自动同步。
- `scheduled` 与任何其他值 → `400 validation_failed`：`/sync/scheduled` 是独立端点（需 `CRON_SECRET`），客户端无权声称自己是定时任务。
- 客户端的 60s 本地闸门（`AUTO_SYNC_MIN_INTERVAL_MS`）只是礼貌；**服务端节流是权威**（Sync-Strategy §6.4），防直连接口 / 多标签页。

```jsonc
// response 200
{
  "status": "partial",              // success / partial / failed（整批的状态）
  "coursesSynced": 4,
  "coursesFailed": 1,
  "tasksCreated": 3, "tasksUpdated": 2, "tasksDeleted": 0,
  "failures": [ { "courseId": "…", "courseName": "…", "message": "Canvas 返回 401" } ],
  "startedAt": "2026-09-04T20:00:47.614Z",
  "finishedAt": "2026-09-04T20:00:52.179Z"
}
```

| 情况 | 状态码 | `error.code` | 说明 |
|---|---|---|---|
| 未登录 | 401 | `unauthenticated` | |
| 未连接 Canvas（无凭据） | 404 | `not_found` | 与 `GET /canvas/credentials` 同口径（ADR-010：不存在与越权统一 404） |
| 凭据状态非 active（expired/revoked/error） | 401 | `credential_invalid` | 一个请求都不发，前端引导重新生成 token |
| 上一次同步还在跑（5 分钟锁内） | 409 | `sync_in_progress` | 不排队，直接拒绝 |
| 距上次同步 < 节流窗口（manual 30s / app_open 60s，共用窗口） | 429 | `rate_limited` | `details.retryAfter`（秒）。**服务端独立校验**，不靠前端置灰 |
| 没有已关联的课程 | 200 | — | 返回全零 summary（不是错误；此时一发请求都不会发，也不触发节流） |

> **检查顺序 = 锁 → 凭据是否存在 → 凭据是否可用 → 有没有课 → 节流。**
> 节流**刻意排最后**：它保护的是 Canvas 的限流额度，一个请求都不会发时回 429 是错误引导
> （实测反例：token 失效时用户看到"同步太频繁，27 秒后重试"，真正该做的是重新生成 token）。
>
> **整批 `status` 与逐课状态的分工**：`partial` 是**一批**同步的属性，只出现在响应与 `sync_runs.status`；
> 逐课状态写在 `courses.sync_status`，**只有 `success` / `failed`**（DB 的 CHECK 约束不含 `partial`，
> 一门课的同步要么成功要么失败）。P0-2-7 拼状态条时两边都要读。
>
> **写入字段是封闭集合**（`title` / `due_date` / `external_updated_at` / `last_seen_at` / `is_deleted`）：
> ⛔ **绝不含 `status`** —— 整行 upsert 会把用户标记的"已完成"打回 pending。
>
> **删除语义**：外部源删了 → 软删除（`is_deleted=true`，不物理删除）；又出现了 → 恢复。
> 本次拉取**不完整**时（翻页被熔断截断）**不做任何删除**。
>
> **无 due date 的作业也同步**（Steven 2026-09-04 拍板），落库 `dueDate = null`（TBD）。
> 已知副作用：Canvas 上的考试（实测 CHEM 1A 的 4 个 exam 条目没有 due date）会与
> syllabus `exam_dates` 的派生任务同名并列 —— 由 **P0-2-11** 的合并展示收口。

**关联成功后也会触发一次同步**：`POST /api/v1/courses/:id/canvas-link` 成功后自动同步**这一门课**。
三条边界：① 同步失败**不影响**关联响应（仍是 200 + course 对象，成败记在 `courses.sync_status`）；
② **不走节流**；③ 同步结果**不进响应体**。

### `POST /api/v1/sync/scheduled`
**仅由 Vercel Cron 或外部调度器调用**，需 `Authorization: Bearer ${CRON_SECRET}`。批量同步全部有效凭据用户。响应为汇总统计，**不返回任何用户的具体数据**。

**为什么 GET 与 POST 都支持**（两份旧文档在这里打架，一并收口）：
- **Vercel Cron 只发 GET**（平台行为，改不了）—— 契约原文写的 POST 是错的；
- Sync-Strategy §3.2 的 T4 外部调度器示例写的又是 GET。
两个方法都导出，行为完全一致，省掉"到底该用哪个"的往返。

**鉴权**：
- Vercel Cron 会**自动**带上 `Authorization: Bearer ${CRON_SECRET}`（项目里配同名环境变量即可，代码无需感知来源）。
- 用 **sha256 + `timingSafeEqual` 恒定时间比较**，不用 `===`（逐字节响应耗时可被侧信道利用）。
- 🔴 **fail closed**：`CRON_SECRET` 未配置 → `500 cron_not_configured`，不管带不带凭证都拒绝执行；`SUPABASE_SERVICE_ROLE_KEY` 未配置 → `500 service_role_key_missing`。**"忘了配环境变量"绝不能退化成一个公开端点。**

```jsonc
// response 200
{
  "startedAt": "2026-09-05T10:00:03.114Z",
  "finishedAt": "2026-09-05T10:00:21.902Z",
  "durationMs": 18788,
  "usersTotal": 6,          // 有效（status=active）凭据用户数，已去重
  "usersSynced": 4,         // 真正跑完一趟的
  "usersFailed": 1,         // 同步过程抛异常的（代码/数据库层错误，非同步失败）
  "usersSkipped": {         // 因前置条件跳过，按原因分列
    "not_connected": 0, "credential_inactive": 1,
    "in_progress": 0, "throttled": 0, "no_courses": 0
  },
  "usersDeferred": 0,       // 超出整批时间预算，留到下一轮 cron
  "coursesSynced": 11, "coursesFailed": 2,
  "tasksCreated": 3, "tasksUpdated": 1, "tasksDeleted": 0,
  "failures": ["Canvas 返回 401"]   // 只含消息：不含 user_id / 课程名
}
```

| 情况 | 状态码 | `error.code` | 说明 |
|---|---|---|---|
| 缺少或错误的 `Authorization` | 401 | `unauthorized` | 非 `Bearer ` 前缀同样 401 |
| `CRON_SECRET` 未配置 | 500 | `cron_not_configured` | 不管带什么凭证都拒绝执行（fail closed） |
| `SUPABASE_SERVICE_ROLE_KEY` 未配置 | 500 | `service_role_key_missing` | 已通过鉴权但遍历不了用户 |
| 内部异常 | 500 | `internal_error` | |

**执行语义**：
- **串行**逐用户（Canvas 并发惩罚，Sync-Strategy §2），一个用户抛异常**不影响其他用户**，只记 `usersFailed` 与消息。
- **不做节流**（`throttleMs` 不传）：一天只跑两次，节流防的是"用户狂点按钮"，定时扫描不存在这个问题；防重跑靠 `sync_runs` 的 5 分钟锁（同一用户上一趟没跑完 → 计 `in_progress` 跳过）。
- **整批时间预算 240 秒**（Vercel 函数上限 300s，留 60s 余量）。超时后剩余用户计 `usersDeferred`，留给下一次 cron —— 不硬撑到被强杀。
- **响应体不含任何用户的具体数据**：`failures` 只有消息文本；`user_id` 只进服务端日志（排障要能定位到人），不进响应。

> 🔴 **实现前提：同步层的用户隔离不能靠 RLS。**
> 本端点用 **service role 客户端**（`lib/supabase/admin.ts`），**绕过 RLS**。因此
> `loadDecryptedCredential` / `loadCredentialMeta` / `findRunningRun` / `findLastRunStartedAt`
> 四个函数的 **`userId` 参数是强制的**（P0-2-6 第二拍加的，不传编译不过），
> 课程查询也显式 `.eq('user_id', userId)`。缺任一处就是跨用户串数据，
> 而在 service role 下 **RLS 不会帮你拦，也不会报错** —— 改动同步编排时新增查询必须带上 `user_id`。

### `GET /api/v1/sync/status`
返回当前用户的同步总览：`lastSyncedAt` / 各课程 `syncStatus` / 凭证状态 / 是否需要续期。供总览页顶部状态条使用。

> ⛔ **决定不实现（Steven 2026-09-05 拍板，P0-2-7）**。
>
> 理由：唯一可能的调用方是总览页的状态条，而 dashboard 与课程详情页**都是服务端组件**，
> 可以直接读 Supabase（`lib/sync/status.ts` 的纯函数就是干这个的）。建端点的**唯一**正当理由是
> 「客户端组件需要轮询」，例如同步进行中实时刷新进度 —— 而实测一趟同步只有 6 秒，
> 现有的「同步中…」按钮态 + `router.refresh()` 已经够用，不值得为它多一层 API。
>
> 数据仍然全部落库（`courses.last_synced_at` / `sync_status` / `sync_error` + `sync_runs`），
> 将来真需要轮询时按本节的形状实现即可。

---

## 7. 账号与隐私（PRD F6 / ✅ P0-3-2）

### `GET /api/v1/account/data-summary`

返回"我们存了你什么"的结构化清单。设置页是服务端渲染，**直接调 `loadDataSummary()`**；端点存在的意义是让这份清单可被脚本 / 验收直接核对，不是给页面自己 fetch 绕一圈。

```jsonc
{
  "courses": 12,             // 未归档课程数
  "archivedCourses": 3,      // 归档课程数（单独列，不混进 courses）
  "syllabi": 5,              // syllabi 行数
  "tasks": 34,               // 未软删（is_deleted = false）的任务数
  "canvas": {
    "connected": true,       // 有凭据且未撤销
    "status": "active",      // null = 从未连接过
    "expiresAt": "2026-11-30T07:59:59.000Z",
    "linkedCourses": 3       // 已关联 Canvas 的未归档课程数
  }
}
```

> **计数失败抛 500，不退成 0。** "有 12 门课"显示成 0，用户会以为数据已经被清掉了 —— 在这个页面上，假数字比报错伤得多（CodingRules 7）。

### `DELETE /api/v1/account/data?scope=canvas`

删除 Canvas 凭据 + **物理删除**全部 `source = canvas` 的任务。**保留** syllabus、手动任务与各门课的 `canvas_course_id`。

- `scope` 只支持 `canvas`，其余取值 `400 bad_request`。
- 与 `DELETE /api/v1/canvas/credentials`（P0-2-9 撤销授权）的**唯一区别**：撤销保留已导入的作业，本端点连它们一起删。两个动作都保留用户自己建立的结构。
- 幂等：没有凭据时 `revoked: false`，重复调用不会报错。

响应 `200`：`{ "revoked": true, "deletedTasks": 12 }`

### `DELETE /api/v1/account`

删除账号及全部数据，**级联范围**：`profiles` / `courses` 及其全部子表（`syllabi` / 五板块 / `tasks`）/ `canvas_credentials` / `sync_runs` / `llm_runs` / `parse_corrections` / `usage_events` / Supabase Storage 中的 syllabus 文件 / Supabase Auth 用户。

- **顺序（实现在 `lib/account/delete-account.ts`）**：① 按 `{user_id}` 前缀删 Storage（含孤儿文件）→ ② `auth.admin.deleteUser()`（FK 级联清空全部业务表）→ ③ 兜底显式删 `profiles` 行。
- **Storage 失败即整趟失败**（500 `delete_failed`）：文件删不掉还继续删账号，等于制造无主文件，且事后查不出文件属于谁。每一步都幂等，可直接重试。
- `SUPABASE_SERVICE_ROLE_KEY` 未配置 → 500 `service_role_key_missing`（删 Auth 用户只能走 admin API，这是它的第四个合法使用方）。

响应 `200`：`{ "dataDeleted": true, "authUserDeleted": true, "storageFilesDeleted": 2 }`

> Storage 文件清理**不可遗漏** —— 只删数据库会留下一堆无主文件，这是最常被漏掉的一步（Security-Privacy A11）。

---

## 8. Demo 与冷启动

### `POST /api/v1/demo/seed`
为新用户复制预置的示例课程（含已解析 syllabus 与示例任务），标记 `isDemo = true`。重复调用返回 `409 already_linked`。
验收：从进入站点到看到有内容的总览页 **≤ 30 秒**（P0-1-10）。

- **预置数据来源（P0-1-10 实现）**：Steven 提供的真实 syllabus `Syllabus 2.pdf`（CHEM 1A Fall 2026），五板块由 `lib/parse` 真实解析结果固化进 `lib/demo/seed-data.ts`（非手写，每条 `sourceExcerpt` 为逐字摘录）。
- **落库复用常态链路**：seed 端点直接复用 `persistParsedSections` 落五板块 + `syncExamToTask` 派生考试任务，**运行时不调 LLM**。
- **留空板块（Steven 拍板）**：`courseOutline` 留空（解析器对 L1–L40 讲座编号课表稳定漏抽，归 P0 期后改进卡）；`officeHours` 留空（原文无具体时间，模型正确返回空）。
- **不建 syllabi 行**：演示课程不写 `syllabi` 表（`file_url`/`file_name` 为 NOT NULL，避免悬挂 Storage 对象 + 失效下载入口）；卡片显示「还没有 syllabus」属预期。
- **流程**：查重（已存在 `isDemo` 课程 → `409`）→ 建 `is_demo=true` 课程 → 落五板块 + 派生 tasks → 写 `profiles.demo_seeded_at`；任一步失败尽力回滚已建课程（避免半截 demo 卡住重试的 409）。
- **响应**：`201` + 课程对象（`isDemo: true`）。

### `DELETE /api/v1/demo`
一键清空全部 `isDemo = true` 的课程及其数据。

- **级联清理**：子表（五板块 + 派生的 tasks）全部对 `courses` 设 `ON DELETE CASCADE`，物理删课程即级联清子数据；`courses` 为 `for all` RLS 策略，只能删自己的。
- **复位**：清 `profiles.demo_seeded_at = null`（让 UI 重新展示「先看看效果」入口）。
- **幂等**：无 `isDemo` 课程时返回 `200 { deleted: 0 }`。
- **响应**：`200 { deleted: <数量> }`。

---

## 9. 健康检查与运营指标

### `GET /api/v1/health`
`{ "status": "ok", "version": "…", "commit": "…" }` —— 部署冒烟测试用，无需登录。

### `GET /api/v1/metrics`　**（P0-3-1）**

四项量化指标，供 Gate 0→1 评审直接读数（G0-2 编辑修正率 / G0-3 人均关联课程数 / G0-7 七日回访）。

- **鉴权**：`Authorization: Bearer ${CRON_SECRET}`，与 `/sync/scheduled` 共用 `lib/api/cron-auth.ts`（sha256 + `timingSafeEqual` 恒定时间比较；**未配置 secret → 500 `cron_not_configured`**，不是放行）。
- **为什么用 service role**：四项都是跨用户指标，而业务表全开 RLS —— 用户级客户端只能看见自己，算出的"人均"永远是 1。这是 `lib/supabase/admin.ts` 的第三个合法使用方。
- **不建管理后台界面**：Phase 0 只有 5-6 个种子用户，一个受保护的 JSON 端点比一个后台页面省事，也不会把指标暴露给任何登录用户。
- **缓存**：`force-dynamic`。缓存一次就会拿着昨天的数做今天的判断。

响应 `200`：

```jsonc
{
  "generatedAt": "2026-09-07T18:42:30.215Z",
  "editCorrectionRate": { "parsedCourses": 4, "correctedCourses": 3, "rate": 0.75 },
  "returnVisits": {
    "users": 2, "windowDays": 7,
    "averageVisits": 3.5, "averageActiveDays": 2.5,
    "perUser": [{ "userId": "…", "windowStart": "…", "windowEnd": "…", "visits": 4, "activeDays": 3 }]
  },
  "linkedCourses": {
    "users": 3, "linkedCourses": 5, "average": 1.667,
    "perUser": [{ "userId": "…", "linkedCourses": 3 }]
  },
  "tokenRenewal": { "remindedUsers": 2, "renewedUsers": 1, "rate": 0.5 }
}
```

**四项口径（`PRD.md` 8.1，实现见 `lib/metrics.ts` 的注释）**

| 指标 | 分母 | 分子 | 说明 |
|---|---|---|---|
| 编辑修正率 | 解析**成功**过的课程数 | 其中有 `parse_corrections` 的课程数 | 分母取"解析完成"而非"上传过"：失败的解析没有可被修正的结果，计入只会稀释 |
| 7 日回访次数 | 连过 Canvas 的用户数 | 各人窗口内打开总览页的次数 | 窗口起点 = `canvas_credentials.created_at`（连接那一刻）；另给 `averageActiveDays`（按天去重）做对照口径 |
| 人均关联课程数 | **全部**用户数（含注册后没建课的） | 未归档且已关联 Canvas 的课程数 | 归档课不计（上学期历史不该抬高"接入门槛"这个信号） |
| token 续期完成率 | 看到过期横幅的人数 | 其中**提醒之后**重新授权的人数 | 提醒前就换过 token 的不算"提醒促成" |

> **分母为 0 时 `rate` 是 `null` 而不是 `0`** —— "一门解析过的课都没有"与"有 10 门但一门都没改"是两个事实，返回 0 会把前者伪装成后者的最差值。

**错误码**：401 `unauthorized`（缺/错凭证）｜ 500 `cron_not_configured`（服务端未配 secret）｜ 500 `service_role_key_missing`｜ 500 `internal_error`（**读数失败一律报错，不返回假 0** —— 表没迁移就是这个错）。

**隐私边界**：`perUser` 只带 `userId`（uuid）与数字，**不含邮箱**。

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
| POST/DELETE | `/api/v1/courses/:id/canvas-link` | 课程关联 / 解除 | ✅ P0-2-4 |
| POST | `/api/v1/sync/now` | 手动同步（串行 / 去重 / 增量） | ✅ P0-2-5 |
| POST | `/api/v1/sync/scheduled` | 定时同步（CRON_SECRET） | P0-2-6（需 service role） |
| GET | `/api/v1/sync/status` | 同步状态 | P0-2-7 |
| GET | `/api/v1/metrics` | 四项量化指标（CRON_SECRET） | ✅ P0-3-1 |
| GET | `/api/v1/account/data-summary` | 数据清单 | ✅ P0-3-2 |
| DELETE | `/api/v1/account/data?scope=canvas` | 清 Canvas 数据（凭据 + 导入任务） | ✅ P0-3-2 |
| DELETE | `/api/v1/account` | 删除账号及全部数据（含 Storage） | ✅ P0-3-2 |
| POST/DELETE | `/api/v1/demo[/seed]` | Demo Workspace | P0-1-10 |
| POST | `/api/v1/email/inbound` | 邮件入站 webhook（Cloudflare Worker 转发，INBOUND_EMAIL_SECRET） | ✅ P0-3-11 |
| GET | `/api/v1/email/address` | 当前用户的邮件入站密址 | ✅ P0-3-11 |
| POST | `/api/v1/reminders/send` | 手动触发当前用户提醒（可选 `?preview=1` 只预览不发送） | P0-3-14（✅ 已上线 2026-09-17） |
| GET/POST | `/api/v1/reminders/scheduled` | 定时批量提醒（CRON_SECRET，service role） | P0-3-14（✅ 已上线 2026-09-17） |
| GET | `/api/v1/reminders/unsubscribe` | 一键退订（公开，token 定位） | P0-3-14（✅ 已上线 2026-09-17） |

---

## 11. 主动提醒 / 优先级（P0-3-14）

ADR-017 点名的"秘书"护城河：**Tempo 找人，不是人找 Tempo**。当前同步靠用户打开 dashboard（T1）触发，用户不来数据就不新 —— 与 ADR-016 直接矛盾。本组端点把"主动提醒"落地为**出站邮件**（渠道 Steven 拍板：邮件；Web Push 排除），优先级口径 = **截止临近排序**（邮件内任务按 dueDate 升序、TBD 排最后，不碰 Phase 2 权重体系）。

> 出站体系与 P0-3-11 的入站体系边界（ADR-019）：入站只做"密址转发 → 解析 → 仅 `status='done'`"，本组端点负责"提醒时机 / 优先级 / 频控 / 退订"全部出站逻辑。

### 邮件口径（聚焦版，Steven 2026-09-17 拍板）
正文**只列「可行动」项**（已逾期 + `DUE_SOON_DAYS=3` 天内到期），其余（远未来 + TBD）**折叠成一行**：「另有 N 项更远的任务（含 M 项日期待定）→ 在 Tempo 查看」。
- 目的：让**主题数字与正文条数一致**，邮件短到一次读完 —— 首版全量平铺在真实数据上会生成 63 行（主题说 20、正文列 63），连续收几天必被无视，违背 ADR-017 秘书定位。
- 结果字段：`shownCount`（正文条数）/ `hiddenCount`（折叠数）/ `hiddenTbdCount`（折叠中含 TBD 的数）/ `totalCount`（= shown + hidden）。
- 排序不变：逾期 → 3 天内 → 更远 → TBD（`sortByDueDateAsc`）。

### 🔴 可提醒范围（「绝不误报」判据，2026-09-17 真发验收后修）
进邮件的每一条都要过 `isRemindable()`（`lib/reminders/build.ts`）：

| `submission_state` | 提醒？ | 理由 |
|---|---|---|
| `submitted` / `graded` / `pending_review` | ❌ | Canvas 外部真相说已完成；`status` 仍 `pending` 只是因为同步永不写它（ADR-015） |
| `external_unconfirmed` | ❌ | 外部平台（Gradescope 等）无可信记录，当"没交"是诬告（ADR-013） |
| `null` | ✅ | Canvas 不追踪（on_paper/not_graded）**含全部 syllabus 派生考试与手动任务**；`null ≠ 不确定` |
| `unsubmitted` / `missing` | ✅ | Canvas 明确说没收到 —— 唯一能理直气壮催的一类 |
| `status='done'`（任意 submission_state） | ❌ | 用户主权优先（ADR-015） |

- **只筛 `status='pending'` 是不够的**：首版就这么写，真发的那封信 21 条里 **18 条是 Canvas 已判定完成**却标着「已逾期 14 天」，**误报率 86%**。判定必须**复用** `isEffectivelyDone()`（`lib/tasks/progress.ts`，全站唯一），别重写。
- 影响：`totalCount` 与折叠计数都按这层筛后的集合算。

### `POST /api/v1/reminders/send`
手动触发**当前登录用户**的提醒（自测 / 想立刻看一眼时用）。需登录（`getCurrentUser()`，否则 401）。
- `?preview=1`：**只组装、回带邮件内容、不发送、不更新时间戳、不卡开关/频控** —— 用来在出站 Worker 还没配好时也能验证排序与口径。
- 响应 `{ data: { userId, sent, reason?, email? } }`。`reason` ∈ `disabled` / `recent` / `no_actionable` / `no_tasks` / `no_email` / `send_failed` / `preview`；`email`（subject/html/text/actionable/shownCount/hiddenCount/totalCount）在 preview 或 `no_actionable` 时回带。

### `GET|POST /api/v1/reminders/scheduled`
定时批量提醒（T3 同款），由 `vercel.json` 的 cron 每天 UTC 14:00（≈美西 07:00）触发一次。service role 遍历全部 `reminder_enabled=true` 的用户逐个组装 + 发送。**与 `/sync/scheduled` 同款鉴权**：`Authorization: Bearer ${CRON_SECRET}` + sha256 恒定时间比较 + fail closed（未配 secret → 500）。
- 响应为聚合计数（不返回任何用户具体数据）：`usersTotal` / `usersReminded` / `usersSkipped{disabled,recent,no_actionable,no_tasks,no_email}` / `usersFailed` / `usersDeferred` / `failures[]`。
- **频控**：每用户**每（本地）天**至多一封（`profiles.last_reminder_at` 是否落在用户时区的「今天」，**不用**固定 24h 窗口 —— 固定窗口配固定时刻的 cron 会退化成「隔天一封」，见 §11 变更记录）。**准确优先于频繁**（ADR-016 R3）：无"逾期或 3 天内到期"任务时不发、也不更新时间戳。

### `GET /api/v1/reminders/unsubscribe?t=<token>`
一键退订（公开，无需登录）。`t` 即身份（每用户一个随机 `reminder_unsub_token`）；按 token 关掉 `reminder_enabled` 并返回退订确认页。`t` 长度 < 12 → 400。

### 出站发送路径
Vercel 引擎组装好邮件后，POST `{ to, subject, html, text }` 给 Cloudflare 出站 Worker（`workers/outbound-email`，独立部署，**不碰已验收的入站 Worker**）；Worker 调用 Email Service 的 `send_email` 绑定发出。`from` 必须是本 zone 已验证的目标地址（`noreply@tempocourse.com`）。Worker 与 Vercel 之间用共享 Bearer 密钥 `OUTBOUND_EMAIL_SECRET` 鉴权。发送失败软降级（不抛错、不炸 cron），返回 `{ok:false,error}`。**启用步骤见 `docs/EMAIL_INBOUND_SETUP.md` §出站启用。**

---

## 12. 变更记录

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
| 2026-09-03 | **§5 两个端点验收通过（Steven 浏览器验收，P0-1-9 ✅）**：`GET /api/v1/tasks` 与 `PATCH /api/v1/tasks/:id` 本地无头 64/64 + 生产 26/26，浏览器交互（标记完成 → 列表刷新 / 已完成折叠与删除线）通过，契约 §5 现状即实现现状，无需再收敛。**§5 的 `POST` / `DELETE`（手动任务）仍为未实现**，留给后续卡片 | P0-1-9 |
| 2026-09-03 | **§8 Demo 端点按 P0-1-10 实现落地**：`POST /api/v1/demo/seed`（建 `is_demo=true` 课程 + 复用 `persistParsedSections` 落五板块 + `syncExamToTask` 派生考试任务，运行时零 LLM；重复 → `409 already_linked`；失败回滚课程）+ `DELETE /api/v1/demo`（级联清子数据 + 复位 `demo_seeded_at`，幂等 `200 {deleted:0}`）。预置数据 = Steven 真实 syllabus（CHEM 1A Fall 2026），`courseOutline`/`officeHours` 按拍板留空，演示课程不建 syllabi 行。现状即实现现状 | P0-1-10 |
| 2026-09-04 | **§6 `POST`/`DELETE /api/v1/courses/:id/canvas-link` 实现落地**（P0-2-4）：① **`Course` 新增 `canvasCourseId`**（未关联为 `null`；`canvasLinked` 由它派生）—— 关联 UI 要显示"关联的是哪门课"，只有布尔值说不出来；② **409 拆成三种情形**：本课已关联另一个 Canvas 课 / 该 Canvas 课已挂到另一门 Tempo 课 / 重复提交同一 ID（**最后一种按 200 幂等处理，不报错** —— 契约原文"重复关联 → 409"的收敛，理由见 §6）；③ 两个端点都幂等，归档课程一律 404；④ 明确**不触发同步**（同步编排是 P0-2-5，现在空跑等于给假成功信号）；⑤ 明确**不校验 ID 在 Canvas 上是否存在**（省一次上游请求与限流额度，UI 只能从列表选）；⑥ 解除关联只清 `canvas_course_id`，`last_synced_at` / `sync_status` / `sync_error` 不动（真实同步历史，且此刻还没有任何 canvas 任务）。**✅ 2026-09-04 11:36 Steven 浏览器验收通过**，契约 §6 现状即实现现状 | P0-2-4 |
| 2026-09-04 | **§6 `POST /api/v1/sync/now` 实现落地**（P0-2-5）：响应体按实现补齐 `startedAt` / `finishedAt`；新增完整错误码表（401 `unauthenticated` / 404 `not_found` 未连接 Canvas / 401 `credential_invalid` 凭据非 active / 409 `sync_in_progress` / 429 `rate_limited` + `details.retryAfter` / 无课可同步 → 200 全零）。**检查顺序明确为 锁 → 凭据 → 课程 → 节流**（节流排最后：一个请求都不会发时回 429 是错误引导）。**整批 `partial` 与逐课 `success`/`failed` 的分工写清**（`courses.sync_status` 的 CHECK 不含 partial，partial 只存在于响应与 `sync_runs`）。**写入字段封闭集合明确排除 `status`**。删除语义补齐：软删除 + 可恢复 + **拉取不完整时不做任何删除**。**无 due date 的作业同步为 TBD**（Steven 拍板），已知副作用（Canvas 考试条目与 syllabus 派生任务同名并列）归 P0-2-11。**`POST canvas-link` 成功后按课程触发一次同步**（P0-2-4 留的口子）：失败不影响关联响应、不走节流、结果不进响应体。`GET /api/v1/sync/status` 与 `POST /sync/scheduled` 标注未实现（分属 P0-2-7 / P0-2-6），并写清后者卡在「需要 service role」 | P0-2-5 |
| 2026-09-05 | **§6 `GET|POST /api/v1/sync/scheduled` 实现落地**（P0-2-6 第二拍，T3 平台定时兜底）：**双方法都支持** —— 契约原文写的 POST 是错的（Vercel Cron 只发 GET），Sync-Strategy §3.2 的 T4 示例写的又是 GET，两份文档打架，此处收口为两个方法行为一致。鉴权用 **sha256 + `timingSafeEqual` 恒定时间比较**（`===` 的逐字节耗时可被侧信道利用）；**fail closed**：`CRON_SECRET` 未配置 → 500 `cron_not_configured`（不管带什么凭证都拒绝执行）、`SUPABASE_SERVICE_ROLE_KEY` 未配置 → 500 `service_role_key_missing`，"忘了配环境变量"绝不退化成公开端点。响应为聚合计数（`usersTotal`/`usersSynced`/`usersFailed`/`usersSkipped` 按原因分列/`usersDeferred` + 课程与任务计数 + 只含消息的 `failures`），**不含任何用户的具体数据**（`user_id` 只进服务端日志）。执行语义：串行逐用户、单用户异常不影响他人、不做节流（靠 5 分钟锁防重跑）、整批 240 秒预算（Vercel 上限 300s）。**🔴 同时给同步层补上强制 `userId` 参数**：本端点用 service role **绕过 RLS**，`loadDecryptedCredential` / `loadCredentialMeta` / `findRunningRun` / `findLastRunStartedAt` 原先全靠 RLS 隐式隔离（查询里没有 `user_id` 条件），在那个客户端下会直接读到**别人的凭据**、把锁与节流变成**全局的**、以及同步**所有人的课程**；四处全部改为显式 `user_id` 过滤且参数**强制**（不传编译不过） | P0-2-6 |
| 2026-09-05 | **§6 `/sync/now` 新增可选 `trigger` 请求体**（P0-2-6 第一拍）：`manual`（默认，30s 节流）/ `app_open`（60s 节流），双档映射服务端权威；两种 trigger 共用同一节流窗口（按 `sync_runs.started_at`，不区分来源）；省略 body / 非法 JSON / 缺字段回退 `manual`（兼容 P0-2-5 裸 POST）；`scheduled` 及非法值 → `400 validation_failed`（定时入口只属于 `/sync/scheduled` + CRON_SECRET）。错误码表 429 行同步改为「按 trigger 的窗口」。配套前端 `components/sync/sync-controls.tsx`（T1 打开/聚焦自动同步 + T2 手动按钮），无 Canvas 关联课程的用户不渲染按钮也不自动同步 | P0-2-6 |
| 2026-09-07 | **§9 新增 `GET /api/v1/metrics`**（P0-3-1，章节由「健康检查」改名为「健康检查与运营指标」）：返回 PRD 8.1 四项指标（编辑修正率 / 7 日回访 / 人均关联课程数 / token 续期完成率）。鉴权与 `/sync/scheduled` 共用 `lib/api/cron-auth.ts`（该文件的恒定时间比较 + fail closed 逻辑此前只存在于定时同步路由，P0-3-1 抽出共用，行为不变）。**分母为 0 时 `rate` 返回 `null` 而非 0**；读数失败一律 500，不返回假 0；`perUser` 只带 uuid 不含邮箱。**§7 `DELETE /api/v1/account` 级联范围补 `usage_events`**（P0-3-2 勿漏） | P0-3-1、`PRD.md` 8.1 |
| 2026-09-09 | **§7 三个端点实现落地**（P0-3-2）：① `GET /api/v1/account/data-summary` 补齐响应形状（课程 / 归档课程 / syllabus / 任务 / Canvas 连接态与过期时间 / 已关联课程数），**计数失败抛 500 不退成 0**；② `DELETE /api/v1/account/data?scope=canvas` 按契约落地为「撤销凭据 + **物理删** `source='canvas'` 的任务」，与 P0-2-9 的 `DELETE /canvas/credentials`（撤销但**保留**已导入任务）**刻意并存**——前者回答"我不想留着从 Canvas 拉来的东西"，后者回答"我想断开但别动我的记录"，两者都保留 syllabus 与手动任务；③ `DELETE /api/v1/account` 明确**删除顺序与失败语义**：Storage 前缀（含孤儿文件）→ `auth.admin.deleteUser()`（FK 级联清库）→ 兜底删 `profiles` 行；**Storage 失败即整趟 500 `delete_failed`**（否则等于制造无主文件）；未配 service role key → 500 `service_role_key_missing` | P0-3-2、`Security-Privacy.md` A11/A12 |
| 2026-09-05 | **§6 `GET /api/v1/sync/status` 标注为「决定不实现」**（P0-2-7，Steven 拍板）：唯一可能的调用方是总览页状态条，而 dashboard 与课程详情页都是**服务端组件**，可直读 Supabase（`lib/sync/status.ts` 的纯函数）；建端点的唯一正当理由是客户端轮询，而实测一趟同步 6 秒，现有「同步中…」+ `router.refresh()`` 已够用。| 2026-09-05 | **§6 `GET /api/v1/sync/status` 标注为「决定不实现」**（P0-2-7，Steven 拍板）：唯一可能的调用方是总览页状态条，而 dashboard 与课程详情页都是**服务端组件**，可直读 Supabase（`lib/sync/status.ts` 的纯函数）；建端点的唯一正当理由是客户端轮询，而实测一趟同步 6 秒，现有「同步中…」+ `router.refresh()` 已够用。数据仍全部落库，将来需要轮询时按本节形状实现即可。**§5 `meta` 里 `staleWarning` / `lastSuccessfulSyncAt` 仍未返回**（同步状态改由 dashboard 服务端渲染，不走 tasks API），归 P0-2-11 | P0-2-7 |
| 2026-09-17 | **§11 新增「主动提醒 / 优先级」（P0-3-14，✅ 已上线）**：ADR-017 点名的"秘书"护城河落地为出站邮件（渠道 Steven 拍板=邮件、Web Push 排除；优先级口径=截止临近排序）。三端点：`POST /api/v1/reminders/send`（用户态、可选 `?preview=1` 只预览不发送）、`GET|POST /api/v1/reminders/scheduled`（cron 批量、service role、CRON_SECRET 鉴权、聚合计数不泄露用户数据）、`GET /api/v1/reminders/unsubscribe`（公开退订）。引擎 `lib/reminders/{build,engine,send,token}.ts`：**纯函数排序/可行动判定/渲染**（`scripts/regress-reminders.ts` 23/23，后扩至 34/34）+ **service role 编排**（每查询显式带 user_id，红线 #3）+ **发送失败软降级**。频控=每用户每天至多一封（`profiles.last_reminder_at`）；准确优先于频繁（无逾期/3天内到期任务则不发）。出站走独立 Cloudflare Worker（`workers/outbound-email`，不碰已验收的入站 Worker）的 `send_email` 绑定。DB 迁移 `20260917130000_reminders.sql`：`profiles` 加 `reminder_enabled`/`last_reminder_at`/`reminder_unsub_token` | P0-3-14、ADR-017、ADR-019 |
| 2026-09-17 | **§11 🔴 修「可提醒范围」漏筛 `submission_state`（真发验收发现，误报率 86%）**（P0-3-14 续三）：Steven 验收真信时发现 `7A Pre-Assessment 02` 在 Tempo 里显示 **已提交（Canvas）**、邮件却标「已逾期 13 天」。**根因**：引擎 SQL 只筛 `status='pending'`，**完全没看 `submission_state`** —— 而 `status` 是用户主权、同步永不写（ADR-015），Canvas 已提交/已评分的任务照样是 `pending`。**实测（真数据只读审计，用真函数 `isEffectivelyDone()`）**：邮件列出的 21 条里 **18 条是 Canvas 已判定完成**（`graded` 21 / `submitted` 2 / `pending_review` 1，全表 64 条 pending 中 24 条属此类），只有 **2 条**是 Canvas 明确说没收到。**修法**：新增 `isRemindable()`（`lib/reminders/build.ts`）= `!isEffectivelyDone()` 且 `!== 'external_unconfirmed'`；**内部调用全站唯一判定**而非重写（dashboard/周历/清单共用 `lib/tasks/progress.ts`）。**三条边界刻意写死**：`submitted`/`graded`/`pending_review` 不提醒；`external_unconfirmed` 不催（ADR-013）；**`null` 照常提醒**（含全部 syllabus 派生考试 —— 因"没外部真相"就不提醒考试是灾难）。修后同一份真实数据：**21 条 → 3 条**（3 条全是真开着的），折叠 43 → 37，总数 64 → 40（= 64 − 24 已判定完成，自洽）。回归 39 → **47** | P0-3-14、ADR-013、ADR-015、ADR-016 R3 |
| 2026-09-17 | **§11 频控判据从「固定 24h 窗口」改为「用户本地日历日」**（P0-3-14 续二，🔴 真发前拦下的静默 bug）：原实现在 `engine.ts` 判 `Date.now() - last_reminder_at < 24h` → 跳过。**根因**：定时任务固定同一时刻触发（`0 14 * * *`），而 `last_reminder_at` 记的是**上一轮发送完成**时刻（必然略晚于本轮触发时刻）→ 下一轮触发时差值**永远不足 24h** → 当天跳过、次日差值已超 24h 才发 → **实际退化成「隔天一封」**，且日志只有 `reason:'recent'`，面板/审计全看不出异常（实测账：昨 14:00:03 发 → 今 14:00:00 查 = 86,397,000ms < 24h = 跳过）。现改为 `isSameLocalDay(last_reminder_at, now, timezone)`（`build.ts` 纯函数，`en-CA` 出 `YYYY-MM-DD` 比较，时区取 `profiles.timezone`，缺省 `DEFAULT_TIMEZONE`），语义与「每用户每天至多一封」字面一致，且不受 cron 抖动 / 发送耗时漂移影响。`DEFAULT_TIMEZONE` 收口到 `build.ts`（原先 `engine.ts` 里硬编了第二处 `'America/Los_Angeles'`）。回归 34 → **39**（新增 5 条：隔天同一时刻必须放行、同日一律拦、跨 PT 零点算新日、UTC 跨日但本地同日仍拦、按用户时区而非 UTC 判定）| P0-3-14、ADR-016 R3 |
| 2026-09-17 | **§11 邮件正文口径收敛为「聚焦版」+ 出站全链路生产验证通过**（P0-3-14 续）：① **聚焦版**（Steven 拍板）—— 正文只列「可行动」项（逾期 + 3 天内），其余折叠成「另有 N 项更远的任务（含 M 项日期待定）→ 在 Tempo 查看」；新增结果字段 `shownCount` / `hiddenCount` / `hiddenTbdCount`；根因=首版全量平铺在真实数据上生成 **63 行**、而主题写 20（口径打架 + 洪水式日报，违背 ADR-016 R3 / ADR-017）。② **出站启用**：迁移执行 ✅、Workers Paid **本就已付费**（免升级）、`noreply@tempocourse.com` 验证 ✅（catch-all zone 上靠**临时精确转发规则**把验证信引到已验邮箱，验完删除）、出站 Worker 部署 ✅（`tempo-outbound-email.stevenli2007.workers.dev` + `send_email` 绑定 + Bearer 密钥）、Vercel 三 env ✅。③ **验收判据**：无凭证打 `/reminders/scheduled` → **401（路由已上线）而非 404（代码没上）** —— env 触发的部署不含未 push 的代码，是本次唯一卡点。④ 本地零副作用预览（service role + 真数据 + `preview:true`）：`actionable=true`、主题 20 / 正文 20 / 折叠 43（= 63）。⑤ 已知数据层问题（**不在本卡**）：`Final Exam` / `Unit 1-3 Exam` 各出现两份（exam 派生任务与 syllabus 重复），单列后续卡 | P0-3-14、ADR-016、ADR-017 |
| 2026-09-17 | **§5.1 删「已到期作业」债务条、新增「今日任务」加权切片**（P0-3-16）：① 删除 `components/overview/debt-bar.tsx` + dashboard 接线 + `lib/tasks.ts` 的 `loadDebtTasks` + `lib/tasks/progress.ts` 的 `debtWindow`/`classifyDebt`/`summarizeDebt` 等死代码（`grep debtWindow` = 0）；② 新增 `lib/tasks/today.ts` 的 `buildTodayTasks()` —— **今天到期 100% + 未来 7 天按 `1/剩余天数` 切片（9/17 看 9/21 = 25%）+ 逾期未完成红组**，三组权重之和即"今日工作量"；③ **红组只收 Canvas 明确说没交的**（`unsubmitted`/`missing`），`null` / `external_unconfirmed` 不进红组（ADR-013）；④ **零新查询**：取数复用总览清单（`loadTasks`，窗口 = now + 7d），总览页从**四路查询降到两路**；⑤ 展示层 `components/overview/today-tasks.tsx`（服务端组件）。回归 `regress:progress` 24 → **27**（删 5 条 debt、加 8 条今日任务） | P0-3-16、ADR-013、ADR-015、ADR-016 |
