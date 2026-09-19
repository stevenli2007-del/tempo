-- =============================================================
-- P0-3-31 · 考试复习模式 v1（复习总结 + 上传额外文件）
--
-- 🔴【Steven 手动】执行方式（业务表）：Supabase Dashboard → SQL Editor → 粘贴执行。
--    顺序：① 跑本 SQL → ② 手动建 Storage 桶与策略（见下，**本文件不能整段在 SQL Editor 跑**）
--          → ③ Bud 推代码 → ④ Vercel 部署 → ⑤ 课程页点某场考试的「复习模式」。
--    漏跑的表现：复习页**会明确报「读取复习数据失败（关系不存在）」**（读取侧 fail loud，
--    与 3-19b / 3-23 同一取舍），且每次生成都白打一次模型请求。
--
-- 本迁移建两张表：
--   ① `exam_review_files`       —— 用户在复习页**额外上传**的文件（元数据 + Storage 路径）
--   ② `exam_review_summaries`   —— 「这份考试的多文件合并总结」缓存
--
-- ---------------------------------------------------------------------------
-- 🔴 为什么键是 `(course_id, exam_key)` 而不是 `exam_dates.id`
-- ---------------------------------------------------------------------------
-- `exam_dates` 是**可被整体替换**的：`lib/parse/persist.ts` 的 `replaceAll()` 在重新解析
-- 时会 `delete ... where source='syllabus'` 再 insert —— **每一行的 uuid 都会变**。
-- 若复习数据 FK 到 `exam_dates.id`（哪怕 ON DELETE CASCADE），用户重解析一次 syllabus，
-- 辛苦上传的额外文件与已生成的总结就会**静默消失**（R3：不许静默失败）。
--
-- 所以键取「课程的考试**身份**」= `exam_key`，即考试名归一后的字符串：
--   `Midterm 1` ≡ `Midterm1` ≡ `midterm-1`（唯一实现 = `lib/course-update/exam-match.ts`
--   的 `normalizeExamName()`，P0-3-29 定的口径 —— 本卡**复用**它，绝不另写一份）。
-- 重解析产出同名考试 ⇒ key 不变 ⇒ 复习数据保留（这正是用户期望的"同一场考试"）。
--
-- ⚠️ 归属仍绑在 `course_id`（→ `courses.user_id`，RLS 一处判据），
--    课程被删则复习数据随之走（`on delete cascade`）—— 这是唯一该级联的边。
--
-- ---------------------------------------------------------------------------
-- 🔴 Storage：私有桶 + 路径首段 = uid（跨用户隔离的**第二层**）
-- ---------------------------------------------------------------------------
-- 桶：`exam_review`（私有，不生成永久 URL，只走签名 URL；上限 20MB，MIME 留空）
-- 路径约定：`{user_id}/{course_id}/{file_id}.{ext}` —— 首段恒为上传者 uid。
-- `storage.objects` 的 RLS 靠首段判定归属（与 `syllabi` 桶同一写法，见
-- `20260902220000_storage_syllabi.sql`）。
--
-- 🔴 **桶与策略必须在 Dashboard UI 建，不能在 SQL Editor 建**（2026-09-02 实测）：
--    `CREATE POLICY on storage.objects` 报 `42501: must be owner of table objects`
--    （owner 是平台角色 supabase_storage_admin，SQL Editor 的 postgres 不是 owner）。
--    ✅ 步骤 1：Dashboard → Storage → New bucket
--         Name = exam_review ／ Public = **关闭**
--         File size limit = **20**（🔴 单位下拉选 **MB**）
--             = 20971520 字节，与 `lib/review/storage.ts` 的 REVIEW_MAX_FILE_SIZE_BYTES 一致。
--         ⚠️⚠️ **别照着「20971520」填** —— 那串数字是**字节数**，而输入框按 MB 解释，
--             照填会变成 20 TB（2026-09-19 实测踩到，文件头原来的写法本身就是歧义源）。
--             另：`Edit bucket` 弹窗会把库里的**字节原值**（20971520）回填进单位是 MB 的框里
--             —— 不假思索点 Save 同样会把它放大成 20 TB。**存之前先把框里的值改成 20。**
--         Allowed MIME types = **留空**（docx/pptx 在真实浏览器常报 octet-stream，
--         桶层白名单会误拒；类型校验由服务端按扩展名做，见 `lib/review/storage.ts`）
--    ✅ 步骤 2：Dashboard → Storage → Policies → New policy ×4
--         Target roles 一律 `authenticated`，四条表达式**完全相同**（含桶限定）：
--             bucket_id = 'exam_review' and (storage.foldername(name))[1] = auth.uid()::text
--         （策略名照 `syllabi` 桶的约定，便于用下面的 SQL 点名核对）
--         ⚠️⚠️ **弹窗默认只预填 `bucket_id = 'exam_review'`，归属判据那半句是空的** ——
--             照预填值保存 = **全桶放行**（任何登录用户可读所有人上传的文件），而策略
--             「看起来是建好了的」（`pg_policies` 里有名字）。**必须手动补全整条表达式。**
--             `Target roles` 同样默认空（= public），必须手动选 `authenticated`。
--             （2026-09-19 实测踩到；判据只有行为验证，见 `npm run probe:exam-review` ⑥）
--         ┌────────────────────────────────┬───────────────────┬──────────────────────────┐
--         │ Policy name                    │ Allowed operation │ 表达式填在哪里           │
--         ├────────────────────────────────┼───────────────────┼──────────────────────────┤
--         │ exam_review_objects_select_own │ SELECT            │ USING                    │
--         │ exam_review_objects_insert_own │ INSERT            │ WITH CHECK               │
--         │ exam_review_objects_update_own │ UPDATE            │ USING 和 WITH CHECK 都填 │
--         │ exam_review_objects_delete_own │ DELETE            │ USING                    │
--         └────────────────────────────────┴───────────────────┴──────────────────────────┘
--         UPDATE 两条都填的原因：防止把对象「挪」到别人目录下（读得到 + 写进去的路径也得是自己的）。
--
-- ---------------------------------------------------------------------------
-- 验收（执行后跑，应看到两张表 + RLS 均已开 + courses 无变化）：
--   select column_name, data_type from information_schema.columns
--   where table_name = 'exam_review_files' order by ordinal_position;
--   select column_name, data_type from information_schema.columns
--   where table_name = 'exam_review_summaries' order by ordinal_position;
--   select relrowsecurity from pg_class
--   where relname in ('exam_review_files','exam_review_summaries');  -- 期望两行都是 t
--   select id, public, file_size_limit from storage.buckets where id = 'exam_review';
--   select policyname, cmd from pg_policies
--   where schemaname='storage' and tablename='objects' and policyname like 'exam_review_objects_%'
--   order by policyname;
--   -- 期望 **6 行**，不是 4 行 —— 新 UI 建 UPDATE / DELETE 时会**各自动附加一条 SELECT 策略**
--   -- （`…_update_own_<后缀>_0` = UPDATE、`_1` = SELECT；`…_delete_own_*` 同理），
--   -- 因为带返回值的更新 / 删除需要 SELECT 才拿得到行。同一用户下会看到：
--   --   delete_own _0=DELETE / _1=SELECT ｜ insert_own _0=INSERT
--   --   select_own _0=SELECT ｜ update_own _0=UPDATE / _1=SELECT
--   -- 看到 6 行**不是建多了**；看到 4 行要确认是不是 UPDATE / DELETE 少了伴随 SELECT 那半。
--   -- ⚠️ 行数只证明"策略在"，**不证明"策略在拦"** —— 唯一判据是
--   --    `npm run probe:exam-review` ⑥（自己目录放行 / 别人目录 403 / 正控签得出可下载 / 负控 anon 签不出）。
-- ⚠️ 面板的 `Success` **不构成证据**；真正的确认走 `npm run probe:schema` 与只读真接口探针。
-- =============================================================

-- -------------------------------------------------------------
-- ① exam_review_files（额外上传的文件）
-- -------------------------------------------------------------

create table if not exists public.exam_review_files (
  id uuid primary key default gen_random_uuid(),
  -- 归属锚点：课程属于谁，文件就属于谁（RLS 判据只有这一处）。
  course_id uuid not null references public.courses (id) on delete cascade,
  -- 上传者。与 Storage 路径首段一致（`{user_id}/…`）—— 表与 Storage **双层**都判归属。
  user_id uuid not null,
  -- 考试身份（`normalizeExamName(exam_name)`）。见文件头：绝不用 `exam_dates.id`。
  exam_key text not null,
  -- 建行那一刻的考试展示名（人话标签）。仅用于界面回显，**不参与任何判定**。
  exam_label text not null default '',
  display_name text not null,
  -- Storage 对象路径 `{user_id}/{course_id}/{id}.{ext}`。**不是可 fetch 的 URL** ——
  -- 桶是私有的，读的时候现签短时签名 URL。
  storage_path text not null,
  -- MIME（浏览器给的 `file.type`）。null = 浏览器没给（**不是"未知类型"的假值**）。
  content_type text,
  -- 字节数。null = 前端没给。
  size_bytes bigint,
  -- 软删除：用户移除一份上传件 → 标 true（Storage 对象尽力删）。物理删会让连带关系断掉。
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.exam_review_files is
  'P0-3-31 复习模式里用户**额外上传**的文件（元数据 + Storage 路径）。键是 (course_id, exam_key) —— exam_key = normalizeExamName(exam_name)，避免 syllabus 重解析换 uuid 时丢数据。原文绝不入库/入日志。';
comment on column public.exam_review_files.exam_key is
  '考试身份 = normalizeExamName(exam_name)（唯一实现见 lib/course-update/exam-match.ts）。刻意不用 exam_dates.id：重解析会整体替换那些行。';
comment on column public.exam_review_files.storage_path is
  'Storage 对象路径 {user_id}/{course_id}/{id}.{ext}，首段 = uid（storage.objects RLS 判据）。私有桶，读取现签短时 URL。';

-- 读取路径：按 (课程, 考试身份) 取全部未删除的上传件。
create index if not exists idx_exam_review_files_lookup
  on public.exam_review_files (course_id, exam_key)
  where is_deleted = false;

drop trigger if exists trg_exam_review_files_updated_at on public.exam_review_files;
create trigger trg_exam_review_files_updated_at
  before update on public.exam_review_files
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- ② exam_review_summaries（多文件合并总结的缓存）
-- -------------------------------------------------------------

create table if not exists public.exam_review_summaries (
  -- 归属**不直接落 user_id**：一份总结属于哪门课，课属于谁（与 practice_tests 同一模式）。
  course_id uuid not null references public.courses (id) on delete cascade,
  exam_key text not null,
  -- 语言（`zh-CN` / `en`，白名单在 `lib/review/locale.ts`）。
  -- ⚠️ 与 file_summaries / message_summaries 同一条：locale **不加 CHECK**
  --    （它只是数据标签，加一种语言不该被一次迁移卡住）。
  locale text not null,
  -- `ok` = 合并总结跑通；`failed` = 确定性失败，**落这一行 = 别再重试**。
  status text not null default 'ok' check (status in ('ok', 'failed')),
  -- 生成时用到的**文件清单快照**：`[{ ref, kind:'file'|'extra', id, label, url, modifiedAt }]`。
  -- 读取侧重新算一份当前清单与之比对：一样 = 缓存可用，不一样 = 重算（ADR-026 差量范式）。
  -- ⚠️ 里面只有"用了哪几份、各自什么版本"，**绝不含任何原文**。
  source_manifest jsonb not null default '[]'::jsonb,
  -- 结构化总结 `{ overview, files:[{ref,points}], keyTopics }`。**只含模型写的话**，不含原文。
  summary jsonb not null default '{}'::jsonb,
  -- 喂进模型的总字符数与是否因过长被截断。🔴 截断过必须如实标注（不假装覆盖全）。
  source_chars integer not null default 0,
  source_truncated boolean not null default false,
  model text,
  -- 失败原因（精简、不含用户内容，同 llm_runs 纪律）。
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一门课的一场考试 + 一种语言只有一行（并发重入靠它收敛）。
  primary key (course_id, exam_key, locale)
);

comment on table public.exam_review_summaries is
  'P0-3-31 考试复习的「多文件合并总结」缓存（按需生成，非同步路径）。key=(course_id, exam_key, locale)。只落模型写出的结构化结论，绝不落课件原文。status=failed 的行保留，作用是"不再重试"。';
comment on column public.exam_review_summaries.source_manifest is
  '生成时所用文件的清单快照 [{ref,kind,id,label,url,modifiedAt}]。读取侧比对它决定是否重算（任一份的 modifiedAt 变化即重算）。';
comment on column public.exam_review_summaries.summary is
  '结构化总结 { overview, files:[{ref,points}], keyTopics }。ref 回指 source_manifest 里的一项，供界面挂「原文 ↗」。';

drop trigger if exists trg_exam_review_summaries_updated_at on public.exam_review_summaries;
create trigger trg_exam_review_summaries_updated_at
  before update on public.exam_review_summaries
  for each row execute function public.set_updated_at();

-- ---------- RLS（与 course_files / practice_tests 同一写法） ----------

alter table public.exam_review_files enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据 = 课程属于当前用户
-- **且** 上传者就是当前用户（表层的第二道，Storage 层是路径首段）。
drop policy if exists exam_review_files_via_course_all on public.exam_review_files;
create policy exam_review_files_via_course_all on public.exam_review_files
  for all
  using (
    exam_review_files.user_id = auth.uid()
    and exists (
      select 1 from public.courses c
      where c.id = exam_review_files.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exam_review_files.user_id = auth.uid()
    and exists (
      select 1 from public.courses c
      where c.id = exam_review_files.course_id and c.user_id = auth.uid()
    )
  );

alter table public.exam_review_summaries enable row level security;

-- 归属经 course_id → courses.user_id 反查。
drop policy if exists exam_review_summaries_via_course_all on public.exam_review_summaries;
create policy exam_review_summaries_via_course_all on public.exam_review_summaries
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = exam_review_summaries.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = exam_review_summaries.course_id and c.user_id = auth.uid()
    )
  );
