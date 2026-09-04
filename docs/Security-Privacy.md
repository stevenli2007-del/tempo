# Security-Privacy.md — Tempo 安全与隐私

> **这份文档回答一个问题：我们把用户的数据交给了谁、存在哪、能不能删干净。**
>
> Tempo 的整个产品建立在信任之上（"替学生消化元工作"的前提是学生信你）。**一次数据事故对 Tempo 的伤害，大于三个新功能带来的收益。**
>
> 风险定级规则见 `Decisions.md` ADR-008；具体数据字段见 `Database.md`；接口层的密钥红线见 `API-Contract.md`。

---

## 1. 风险分级（ADR-008 落地）

**不同性质的风险不能混为一谈** —— 混着说会导致决策误判（把 ToS 小事当法律大事，或反过来）。

| 级别 | 类型 | 定义 | Tempo 中的例子 | 处置姿态 |
|---|---|---|---|---|
| **R1** | **平台政策（ToS）风险** | 违反服务条款，最坏后果是**服务方终止接入 / 撤销 token** | Phase 0 使用 Canvas Personal Access Token（[ADR-002](./Decisions.md#adr-002)） | 定性为**验证期临时手段**；iCal 作 Plan B；Phase 1 必换 OAuth |
| **R2** | **法律风险** | 可能招致法律责任 | **Phase 4** 的 past paper 共享（版权）、UGC 中的他人隐私（FERPA） | **Phase 0-3 完全不触碰**；Phase 4 立项前单独评估 |
| **R3** | **声誉风险** | 不违法、不违规，但损害信任 | 静默展示过期数据、未经说明把数据发给第三方 AI | **可预防性最高，优先级不低** |
| **R4** | **安全工程风险** | 实现缺陷导致的数据泄露 | token 未加密、RLS 漏配、密钥进前端 | 靠本文档的验收清单强制拦截 |

> **Phase 0-3 不存在 R2 级法律风险。** 每个学生访问的都是自己账号本来就能看到的数据，不涉及第三方隐私。文档和讨论中提到"法律风险"时，**必须指明是哪一级**。

---

## 2. 我们存什么（数据清单）

| 数据 | 来源 | 敏感级别 | 存储位置 | 删除方式 |
|---|---|---|---|---|
| 邮箱、密码哈希 | 用户注册 | 中 | Supabase Auth（`auth.users`） | 删除账号时级联 |
| 显示名、时区 | 用户填写 | 低 | `profiles` | 同上 |
| 课程名/学期/教师名 | 用户填写 | 低 | `courses` | 同上 |
| **Syllabus 文件** | 用户上传 | **中**（可能含教师联系方式、课程政策） | Supabase Storage（私有桶） | 删除账号/课程时**必须一并删除** |
| Syllabus 提取文本 | 文件抽取 | 中 | `syllabi.raw_text` | 同上 |
| 五个板块结构化数据 | LLM 解析 + 用户修正 | 低 | 各子表 | 同上 |
| **Canvas 作业标题与 due date** | Canvas API | 中 | `tasks` | 删除账号或解除连接时可选清除 |
| **Canvas 访问凭证** | 用户提供 | **高** | `canvas_credentials.secret_encrypted`（**AES 加密**） | 撤销授权 / 删除账号时**立即删除** |
| LLM 调用元数据 | 系统生成 | 低 | `llm_runs` | 同上 |
| 同步日志 | 系统生成 | 低 | `sync_runs` | 同上 |

**明确不存**：成绩、提交内容、讨论区发言、花名册、Canvas 上除"作业标题 + due date"以外的任何数据。

> **最小权限原则的实际体现**：不请求的数据，就不存在泄露它的可能。这也是 `Sync-Strategy.md` 第 14 节把同步范围限制在 assignments 的原因之一。

---

## 3. 凭据保护（最高优先级）

| 要求 | 规定 |
|---|---|
| 加密 | `secret_encrypted` 使用 **AES-256-GCM** 加密后存储，**绝不存明文** |
| 密钥管理 | 加密密钥放在服务端环境变量 **`CANVAS_TOKEN_ENCRYPTION_KEY`**，不入库、不进前端、不进代码仓库 |
| 请求位置 | **所有 Canvas 请求经由服务端代理**，token 只在内存中解密使用 |
| 响应红线 | **任何 API 响应中不得出现 token 或其派生形式**（`API-Contract.md` 第 1.5 节） |
| 前端红线 | token **不进入 localStorage / sessionStorage / 任何前端状态** |
| 日志红线 | **禁止在日志、错误信息、埋点中记录 token 或其前缀** |
| 传输 | 全站 HTTPS（Vercel 默认强制） |
| 撤销 | 用户提供"一键断开授权"，删除加密凭证并停止同步 |

**P0-2-2 验收方式**：抓包确认前端所有响应中不含 token；在数据库中确认凭证为密文。

**P0-0-5 验收方式**：用两个测试账号交叉验证，A 通过任何接口都取不到 B 的任何一行数据。

---

## 4. 行级安全（RLS）

**没有 RLS 策略的表 = 数据裸奔，不允许上线。** 每张业务表 `ENABLE ROW LEVEL SECURITY`。

```sql
-- 直属用户的表
CREATE POLICY "own rows" ON courses
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 挂在课程下的子表（没有直接 user_id，需反查 courses）
CREATE POLICY "via course" ON tasks
  FOR ALL USING (
    EXISTS (SELECT 1 FROM courses c WHERE c.id = tasks.course_id AND c.user_id = auth.uid())
  );
```

| 表 | 策略依据 |
|---|---|
| `profiles` / `canvas_credentials` / `sync_runs` / `parse_corrections` | `auth.uid() = user_id` |
| `courses` | `auth.uid() = user_id` |
| `syllabi` / `grade_components` / `course_outline_items` / `exam_dates` / `office_hours` / `submission_policies` / `tasks` | 通过 `courses` 反查 |
| `llm_runs` | `user_id`（可为 null 的系统调用需单独策略） |

**Service Role Key**：仅在服务端环境使用，**禁止出现在任何 `NEXT_PUBLIC_` 变量或前端代码中**。前端只用 anon key + RLS。

---

## 5. 环境变量与密钥清单

| 变量 | 是否密钥 | 前缀 | 存放位置 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 否 | ✅ 公开 | Vercel / `.env.local` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 否（受 RLS 保护） | ✅ 公开 | 同上 |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔴 **是** | ❌ 无前缀 | **仅服务端** |
| `CANVAS_TOKEN_ENCRYPTION_KEY` | 🔴 **是** | ❌ 无前缀 | **仅服务端** |
| `CRON_SECRET` | 🔴 **是** | ❌ 无前缀 | **仅服务端** |
| `LLM_PROVIDER` / `LLM_API_KEY` | 🔴 **是** | ❌ 无前缀 | **仅服务端** |

规则：
1. **`.env.local` 永不入库**（`.gitignore` 必须包含），只提交 `.env.example`。
2. 任何带 `NEXT_PUBLIC_` 前缀的变量都会打进前端产物 —— **密钥绝对不能用这个前缀**。
3. 轮换：发现泄露或 Phase 0 结束时轮换一次 `CRON_SECRET` 与加密密钥（**轮换加密密钥需要先解密再重新加密全部凭证，不是改个变量就完事**）。

---

## 6. 🔴 数据出境：syllabus 会离开美国

**这一节必须让 Steven 明确知情并做决定，不能默认通过。**

`syllabus` 文本会被发送给 LLM 服务商进行解析。当前默认 provider 是 **DeepSeek**（[ADR-003](./Decisions.md#adr-003)），其 API 服务位于**中国境内**。也就是说：

> **学生上传的课程材料会被传输到美国境外进行处理。**

**风险程度评估（诚实版）**：

- Syllabus 通常**不是机密文件** —— 绝大多数是公开分发的课程大纲，学校自己也放在公开页面上。
- 但仍可能包含：教师个人邮箱与电话、Zoom 链接与会议密码、未公开的课程安排。
- **多数 LLM API 服务商声明不保留请求数据用于训练，但这一点无法由我们验证或保证** —— 我们只能基于对方的政策声明，不能承诺"数据一定被删除"。

**Phase 0 的处置方式（已写入本档，可调整）**：

| # | 措施 |
|---|---|
| 1 | 上传界面**明确告知**："你上传的 syllabus 将发送给 AI 服务商进行解析" |
| 2 | 设置页列出当前使用的 provider 及其服务地区 |
| 3 | **不含任何"数据不会被保存"的承诺** —— 无法保证的事不说（呼应 `CodingRules.md` 的诚实原则） |
| 4 | 若切换 provider（如 Claude），同步更新告知文案 |

**需要你拍板的选项**（记为待决事项 **O-08**）：

| 选项 | 代价 |
|---|---|
| **A. 维持 DeepSeek，做好告知** | 数据出境，需用户知情；成本最低 |
| **B. 解析改用美国境内 provider（Claude / OpenAI）** | 无出境问题，但成本更高，且偏离"DeepSeek 优先" |
| **C. 混合**：syllabus 解析走境内 provider，其余仍用 DeepSeek | 复杂度略增，但只在真正接触用户数据的环节切换 |

> 我倾向 **A（Phase 0）+ 在 Phase 1 正式对外前重新评估**。理由：Phase 0 是 5-6 人自用的验证阶段，且 syllabus 敏感性低；但对外的产品版本，这个问题值得重新算一遍账。你的判断优先。

---

## 7. FERPA 边界

**FERPA**（美国家庭教育权利与隐私法）约束的是**学校及其承包商对教育记录的处理方式**。

- Tempo **不是学校的承包商**，学生用 Tempo 访问**自己账号内本来就可见的数据** —— 这不构成 FERPA 意义上的"未经授权披露"。
- 但我们仍按 FERPA 的精神守住三条：
  1. **不向任何第三方共享用户数据**（不含分析 SDK 上传课程内容；如接入埋点，只传行为事件，不传内容）。
  2. **不公开展示任何用户数据**（课程评价、past paper 等 UGC 功能在 Phase 4 立项时必须单独做版权与隐私评估）。
  3. **不给教师、助教、学校任何数据访问入口** —— Phase 0-3 不提供。

---

## 8. 日志与可观测性的隐私边界

| 允许记录 | 禁止记录 |
|---|---|
| 请求 ID、耗时、状态码、错误码 | Canvas token 或其任何片段 |
| `llm_runs` 的 provider / 模型 / token 数 / 耗时 / 状态 | **LLM 请求与响应的全文**（含 syllabus 全文） |
| `sync_runs` 的变更统计与失败原因 | 用户 syllabus 内容 |
| 埋点行为事件（上传、保存、同步） | 埋点中夹带课程名、作业标题等内容字段 |

> `llm_runs` **只存元数据，不存 prompt 与响应原文**。这条要写进代码评审清单 —— 调优需要的是"哪次调用、用了哪个模型、花了多少 token"，不是原始文本。原始文本本来就在 `syllabi.raw_text` 里，不需要重复存一份在日志表里。

---

## 9. 学校关系原则

`Tempo_产品总蓝图.md` 中的原则 5：**"学校关系是战略资产，不是事后考虑。"** 落到具体行为：

1. **不宣传"绕过官方接入"** —— 产品文案里不出现"不需要学校授权""直连你的 Canvas"这类表述。
2. **不做批量爬取** —— Phase 0 只同步已关联课程（见 `Sync-Strategy.md` 第 14 节）。
3. **Phase 1 主动申请 OAuth Developer Key**，且**与 Phase 0 并行启动**（机构审批以月计，串行会损失一个学期）。
4. **被联系即配合** —— 若学校 IT 或 Instructure 联系我们要求停止某种接入方式，**立即停止并切换到 OAuth/iCal**，不争辩。相关预案已在 `Sync-Strategy.md` 第 11 节的降级阶梯 L3。
5. **规模扩张前先解决合规** —— PAT 在 5-6 人自用下风险趋近于零（[ADR-008](./Decisions.md#adr-008)），但**规模一大即不成立**。对外公开发布前，PAT 必须已被替换。

---

## 10. 事件响应（Phase 0 最小版）

不做复杂流程，只定两条：**出事时谁做什么。**

| 事件 | 立即动作 | 后续 |
|---|---|---|
| **Canvas token 疑似泄露** | 1) 提醒该用户立即在 Canvas 撤销 token<br>2) 删除库中对应加密凭证<br>3) 停止该用户全部同步 | 排查泄露路径（日志？响应？前端？），修复后再恢复 |
| **用户数据疑似被越权访问** | 1) 立即下线受影响接口<br>2) 全表审查 RLS 策略<br>3) 通知受影响用户 | 修复后补一条 RLS 验收用例 |

**Phase 0 不设值班 / 不搭告警系统。** 每周人工看一次 `sync_runs`（见 `Sync-Strategy.md` 第 13 节）即可。

---

## 11. Phase 0 安全验收清单

每个 task 交付时逐条打勾，**未通过不允许进入下一阶段**。

| # | 检查项 | 关联 task | 状态 |
|---|---|---|---|
| A1 | `.env.local` 已 gitignore，仓库中无任何密钥 | P0-0-2 | ☐ |
| A2 | 所有表已启用 RLS，两账号交叉验证通过 | P0-0-5 | ☐ |
| A3 | Service Role Key 未出现在任何 `NEXT_PUBLIC_` 变量或前端产物中 | P0-0-6 | ☐ |
| A4 | 生产环境变量已配置，部署后无密钥泄漏 | P0-0-6 | ☐ |
| A5 | Canvas 凭证在数据库中为密文 | P0-2-2 | ✅ **2026-09-04 已验证**：用户自己 access_token 打 Supabase REST 直查 `secret_encrypted`，确认为 `v1:...` 四段密文且不含明文 |
| A6 | 抓包确认前端所有响应不含 token | P0-2-2 | ✅ **2026-09-04 已验证（API 层）**：POST 201 / GET 200 / 诊断路由三类响应均断言不含 token 明文与 `secretEncrypted` 字段。⚠️ 本卡无前端 UI（关联 UI 在 P0-2-4），UI 层抓包待 P0-2-4 补验 |
| A7 | 日志中无 token、无 syllabus 全文 | P0-2-3 | ☐ |
| A8 | `llm_runs` 只存元数据，不存 prompt / 响应原文 | P0-1-3 | ☐ |
| A9 | `/api/v1/sync/scheduled` 校验 CRON_SECRET（恒定时间比较） | P0-2-6 | ☐ |
| A10 | 撤销授权后凭证被清除、同步停止 | P0-2-9 | ☐ |
| A11 | 删除账号级联清除 Storage 文件（不可遗漏） | P0-3-2 | ☐ |
| A12 | 设置页已含数据说明 + 明确告知 syllabus 会发送给 AI 服务商 | P0-3-2 | ☐ |

---

## 12. 待确认事项

| 编号 | 事项 | 需要谁决定 | 备注 |
|---|---|---|---|
| **O-08** | **LLM 数据出境策略**（DeepSeek 中国 / 切换境内 provider / 混合） | **Steven** | 见第 6 节。Phase 0 暂按选项 A 执行，对外发布前必须重新评估 |
| **O-09** | 是否接入第三方埋点（如 Vercel Analytics / PostHog） | Steven | 若接入，需确认不上传任何内容字段（第 8 节） |
| O-10 | 隐私政策页面的正式文案 | 共担 | Phase 0 可用简洁版，但**不能缺失** |

---

## 13. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-09-01 | 初版 | ADR-002（PAT）、ADR-008（风险分级）、PRD F6（设置与凭据管理）、`Database.md`、`API-Contract.md` |
