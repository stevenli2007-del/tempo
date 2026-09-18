-- =============================================================
-- P0-3-19 · 资料索引（Canvas 文件**元数据**）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    顺序：① 跑本 SQL → ② Bud 推代码 → ③ Vercel 部署 → ④ 触发一次同步 → 看课程页「资料」区。
--    漏跑的表现：同步照常成功，但课程页**没有「资料」区**（读取侧 fail soft，返回空数组），
--    且同步日志里会有 42P01（关系不存在）—— **不会炸，只是静默没有功能**。
--
-- 本迁移做两件事：
--   ① 新建 `course_files`（一门课的 Canvas 文件目录）
--   ② `courses` 加一列 `files_scanned_at`（资料区的独立刷新节奏，见下）
--
-- ---------------------------------------------------------------------------
-- 🔴 只存元数据，绝不存内容（本卡的红线）
-- ---------------------------------------------------------------------------
-- 表里**没有任何一列**能装文件内容：没有 bytea、没有 text 正文、没有 storage 路径。
-- `file_url` 是**指回 Canvas 的页面地址**，不是 Tempo 自己的副本。
-- 理由三条：① 零隐私面（不复制老师的课件）；② 零账单（不存不解析）；
-- ③ 要读某个文件时（3-20 大纲漂移 / 3-23 practice test）才按需 `GET` 那一个文件，
--    用 `modified_at` 做差量 —— 目录先建好，内容按需取。
--
-- ---------------------------------------------------------------------------
-- 为什么要 `files_scanned_at`（而不是每轮同步都扫一遍文件）
-- ---------------------------------------------------------------------------
-- 实测（2026-09-18，Steven 真账号 14 门课）：`/files` 端点**单课 1 个请求**，
-- 而单次同步的 Canvas 请求预算只有 **20 个**（Sync-Strategy §5 三级熔断）。
-- 作业要 N 个、公告 1 个，若每轮再把文件扫一遍，6 门课 = 12 个请求，**会定期把预算吃满**，
-- 结果是作业还没同步完就被熔断 —— 主功能被附加功能挤掉。
--
-- 而文件目录是**低频变化**的：老师上传一次课件，可能几周不动。
-- 故资料区走**独立节奏**：一门课扫过一次后 **24 小时内不重扫**（手动刷新除外，
-- 用户点了刷新就该立刻看到 —— 与 T2「手动是明确意图，放宽」同一条纪律）。
--
-- ⚠️ 这个 24h 门槛是**预算保护**，不是"数据新鲜度承诺"：
--    老师刚传的文件最长可能 24 小时后才出现在资料区。这是刻意接受的代价
--    —— 拿主同步的预算去换课件目录的分钟级新鲜度不划算。
--
-- ---------------------------------------------------------------------------
-- 🔴 为什么 `/files` 的 403 不能当"凭证失效"（本次踩到的真雷）
-- ---------------------------------------------------------------------------
-- 实测：14 门课里 **8 门** `/files` 返回 **403**（Assessment Pilot / GBA /
-- Hazing Prevention / PartySafe / SHAPE …—— 这些课**根本没开 Files 区**），
-- 而同一 token 打它们的 `/folders` 与 `/assignments` 全是 200。
-- 若按 Sync-Strategy §8 的通用规则把 403 判成 `unauthorized` →
-- 会立刻把 `canvas_credentials.status` 写成 `error` 并**停掉该用户的全部同步**。
-- --------- 凭证明明有效，却被一门没开 Files 的课连坐 ---------
-- 故代码里：资料区是**附加能力**，它的 401/403 **只跳过那门课、绝不写凭证状态**；
-- 凭证有效性**只由作业同步判定**（作业跑在资料区之前，token 真失效时轮不到资料区）。
-- 这条纪律写在 `lib/sync/canvas-files.ts` 文件头，改同步编排前先读。
--
-- ---------------------------------------------------------------------------
-- 验收（执行后跑，应看到 10 列 + RLS 已开 + courses 多了 files_scanned_at）：
--   select column_name, data_type from information_schema.columns
--   where table_name = 'course_files' order by ordinal_position;
--   select column_name from information_schema.columns
--   where table_name = 'courses' and column_name = 'files_scanned_at';
--   select relrowsecurity from pg_class where relname = 'course_files';  -- 期望 t
-- =============================================================

create table if not exists public.course_files (
  id uuid primary key default gen_random_uuid(),
  -- 归属：子表没有 user_id，RLS 通过 courses 反查（与 grade_components / exam_dates 同模式）。
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Canvas 侧文件 ID（字符串）。去重与增量同步的唯一依据 —— 没有它就无法判断
  -- "这是不是已经索引过的那个文件"，硬写进去只会产生重复条目。
  canvas_file_id text not null,
  -- 展示名（Canvas `display_name`）。不用 `filename`（那是 URL 编码后的原始名，
  -- 形如 `Chem+1A+Fall+26+-+Quiz+4+.pdf`，画到界面上是噪音）。
  display_name text not null,
  -- MIME（`content-type`），如 `application/pdf`。null = Canvas 没给（**不是"未知类型"的假值**）。
  content_type text,
  -- 字节数。null = Canvas 没给。只用来在 UI 上标大小，**不用于任何判定**。
  size_bytes bigint,
  -- Canvas 文件夹的相对路径（`/` 分隔），已剥掉根前缀 `course files/`。
  -- 空串 `''` = 课程文件根目录（不是"未知"）。
  -- 分组展示的唯一依据 —— 验收标准①要的 `Lecture Slides/Unit 1`、`Practice Exams/Unit 1 Exam/Answer Keys`
  -- 全靠它。来源优先用 `/folders` 的 `full_name`（Canvas 直接给全路径，不必自己拼父子链）。
  folder_path text not null default '',
  -- 指回 Canvas 的文件页（`https://{domain}/courses/{canvas_course_id}/files/{file_id}`）。
  -- 🔴 为什么**不用** Canvas 返回的 `url`：那个是 `/files/{id}/download?...&verifier=...`
  --    —— **带 Bearer token 才能取**，用户在浏览器里点开是 401（实测）。
  --    拼出来的 `/courses/:id/files/:file_id` 是 Canvas 的**文件预览页**（实测 200），
  --    用户只要登着 Canvas 就能看。本卡要的是"点开外链回 Canvas"，不是"帮用户下载"。
  file_url text not null,
  -- Canvas 的 `modified_at`。**3-20 / 3-23 按需抓内容时的差量依据**
  -- （内容没变就不重新下载、不重新解析、不再花一次模型钱）。null = Canvas 没给。
  modified_at timestamptz,
  -- 软删除（Database.md §4.3 / §4.4）：老师在 Canvas 上删了文件 → 标 true、不物理删，
  -- 老师删错又传回来是很常见的，物理删会造成"资料凭空消失"。
  -- 🔴 只在**本次拉取完整**时才做删除判定（`lib/sync/canvas-files.ts` 的 `complete`），
  --    翻页被熔断截断时绝不能把没拿到的行判成"已删除"。
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.course_files is
  'P0-3-19 课程资料索引（Canvas 文件**元数据**）。只存目录与外链，绝不存文件内容 —— 内容按需在 3-20/3-23 才抓，用 modified_at 差量。';
comment on column public.course_files.folder_path is
  'Canvas 文件夹相对路径（已剥根前缀 course files/）；空串 = 根目录。分组展示的唯一依据。';
comment on column public.course_files.file_url is
  '指回 Canvas 的文件**预览页**，不是下载链（下载链带 verifier 且需 Bearer，浏览器点开 401）。';
comment on column public.course_files.modified_at is
  'Canvas modified_at。3-20/3-23 按需抓内容时的差量依据；null = Canvas 没给（不是 0）。';
comment on column public.course_files.is_deleted is
  '老师在 Canvas 上删了该文件 → true。只在本次拉取完整时才判定，不完整时绝不删（Sync-Strategy §7）。';

-- 去重唯一索引（Database.md §3.9 同一条纪律）：没有它，同步重试会产生重复条目，
-- 资料区就会出现"两个一模一样的 HW1"。
create unique index if not exists course_files_course_file_unique
  on public.course_files (course_id, canvas_file_id);

-- 读取路径：按课程取全部未删除的文件，再按 folder_path 排序（资料区的主查询）。
create index if not exists idx_course_files_course_path
  on public.course_files (course_id, folder_path)
  where is_deleted = false;

-- 资料区的独立刷新节奏（见文件头「为什么要 files_scanned_at」）。
-- null = 从没扫过（第一次同步就会扫）。
alter table public.courses add column if not exists files_scanned_at timestamptz;

comment on column public.courses.files_scanned_at is
  'P0-3-19 资料区（course_files）最后一次被扫描的时间。与 last_synced_at 分开：文件目录低频变化，走 24h 独立节奏以保住单次同步 20 请求的预算。null = 从没扫过。';

drop trigger if exists trg_course_files_updated_at on public.course_files;
create trigger trg_course_files_updated_at
  before update on public.course_files
  for each row execute function public.set_updated_at();

-- ---------- RLS（与 exam_dates / grade_components 同一写法） ----------

alter table public.course_files enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据只有一处（通过 courses 反查 user_id），
-- 少一条策略就会让整张表谁都写不进（资料区静默空白）。
drop policy if exists course_files_via_course_all on public.course_files;
create policy course_files_via_course_all on public.course_files
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_files.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_files.course_id and c.user_id = auth.uid()
    )
  );
