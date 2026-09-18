-- =============================================================
-- P0-3-19b · 单文件「一键总结」（落库缓存，M3 追加）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    顺序：① 跑本 SQL → ② Bud 推代码 → ③ Vercel 部署 → ④ 课程页点某个文件的「一键总结」。
--    漏跑的表现：总结页**会明确报"总结生成失败"**（读取侧 fail loud，
--    与 3-19 资料区同一取舍），且每次打开都白打一次模型请求（日志里是 42P01/关系不存在）。
--
-- 本迁移只做一件事：新建 `file_summaries`（课件文件 → AI 总结的缓存）。
--
-- ---------------------------------------------------------------------------
-- 🔴 这张表的存在，是 3-19 那条红线的一次**有边界**的开口
-- ---------------------------------------------------------------------------
-- 3-19 立项时的红线是「**只存元数据，绝不下载文件内容**」（零解析、零隐私面、零账单），
-- 那条红线**依然成立**，且它说的是**同步/索引路径**：索引期一个字节都不下载。
--
-- 本卡加的是**按需**读取：用户在某个文件上主动点了「一键总结」，才为**那一个文件**
-- 下载内容、抽文本、喂模型。区别是三处，都是有意的：
--   ① **触发者是用户**（不是在后台替他扫全部 271 个文件）；
--   ② **只碰那一个文件**，不留副本（内容只在内存里过一遍，**不落库、不进 Storage**）；
--   ③ 只有**抽出来的文本**参与总结，**原文永不入库** —— 所以本表存的也不是课件内容，
--      而是「模型对这份材料说了什么」+ 一组用于判\"要不要重算\"的元数据。
-- 与 ADR-013（不逆向第三方平台）不冲突：文件是 Canvas 通过官方 API 主动提供的，
-- 用的还是用户自己的凭据与自己的选课权限。
--
-- ---------------------------------------------------------------------------
-- 为什么是"落库缓存"而不是"每次打开重算"
-- ---------------------------------------------------------------------------
-- ① **一次生成、多次复用**：同一份课件被点开五次，只该花一次钱；
--    Vercel 函数也有超时上限，而"下载 + 抽文本 + 模型"是一条真会跑到十几秒的链。
-- ② **失败也要落一行**（status = 'failed'）：模型对某份材料持续给不出结果时，
--    只记成功 = 每次点开都为同一份文件重打一次模型（账单与延迟一直涨、用户看不出异常）。
--    要重试就删掉那一行（`delete from file_summaries where status = 'failed'`）。
--
-- ---------------------------------------------------------------------------
-- 为什么 key 带 locale
-- ---------------------------------------------------------------------------
-- 与 `message_summaries`（ADR-024）**同一个理由**：先出中文总结，
-- 但英文版上线后若共用一个 key，英文总结会覆盖中文那条，
-- 用户在两种界面间切换就会反复触发重新生成（互相踩踏、每次都花钱）。
-- 分语言后一份文件可以有 zh-CN / en 两条总结，各用各的。
--
-- ⚠️ 因此 `locale` **不加 CHECK 约束**（与 `messages.type` 那类"枚举四处同改"不同）：
--    locale 只是数据标签（查询条件 + 展示语言），加一种语言不该被一次迁移卡住。
--    `status` 是代码分支（ok = 有总结可渲染 / failed = 别再重试）→ 有 CHECK。
--
-- ---------------------------------------------------------------------------
-- 为什么记 `source_modified_at`（差量判据）
-- ---------------------------------------------------------------------------
-- 老师**换掉**了同一份课件（Canvas 上文件 id 不变、`modified_at` 变，
-- 实测 `modified_at` 与 `updated_at` 是两回事）时，旧总结就是**过期的谎话**。
-- 所以存下"总结时那份文件的 `modified_at`"，读取侧比对：一样 = 缓存可用，
-- 不一样 = 重算。与同步层的"拉取不完整不删"是同一套思路：**先证明还是同一份东西**。
--
-- 验收（执行后跑，应看到 12 列 + RLS 已开）：
--   select column_name, data_type from information_schema.columns
--   where table_name = 'file_summaries' order by ordinal_position;
--   select relrowsecurity from pg_class where relname = 'file_summaries';  -- 期望 t
-- =============================================================

create table if not exists public.file_summaries (
  -- 归属**不直接落在本表**：一份总结属于哪个文件，文件属于哪门课，课属于谁 ——
  -- 与 message_summaries / course_announcements 同一模式（一处归属、一处 RLS 判据）。
  -- `on delete cascade`：文件在 Canvas 上被删除、同步软删后硬清时，总结跟着走。
  course_file_id uuid not null references public.course_files (id) on delete cascade,
  -- 总结语言（`zh-CN` / `en`，白名单在 `lib/course-files/summary/locale.ts`）。
  locale text not null,
  -- `ok` = 模型跑通（要点可能为空数组 = 材料没有实质内容）；
  -- `failed` = 下载/抽取/调用/校验失败，**落这一行的意义是"别再重试"**。
  status text not null default 'ok' check (status in ('ok', 'failed')),
  -- 结构化总结（jsonb）：`{ overview, points, formulas }`。
  -- 用 jsonb 而不是一段 markdown：渲染层要逐条画列表、要给每类内容单独排版，
  -- 且校验层（`validateSummaryOutput`）能把"模型写歪"拦在入库前。
  -- ⚠️ 里面**只有模型生成的概述与要点**，**绝不含课件原文**。
  summary jsonb not null default '{}'::jsonb,
  -- 抽取到多少字符（喂模型前的原始量）／是否因过长被截断。
  -- 🔴 截断过就必须在界面上如实说明（"基于前 N 页"）——
  --    覆盖不全却假装全，就是"计数撒谎"（message_summaries.items_used 同一条纪律）。
  source_chars integer not null default 0,
  source_truncated boolean not null default false,
  -- PDF 页数（docx/pptx 为 null）与所用抽取器（`pdf_text` / `docx` / `pptx`）。
  page_count integer,
  extract_method text,
  -- **总结时**那份文件在 Canvas 上的 `modified_at`。读取侧比对它决定要不要重算。
  source_modified_at timestamptz,
  -- 写进 llm_runs 的同一组值（实际服务的模型名，不是请求时填的别名）。
  model text,
  -- 失败原因（精简、**不含课件内容**，同 llm_runs.error_message 的纪律）。
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一份文件 + 一种语言只有一行：并发点开（或流式渲染重入）时靠它收敛，
  -- 不会出现"同一份文件两条总结"这种无法解释的重复。
  primary key (course_file_id, locale)
);

comment on table public.file_summaries is
  'P0-3-19b 课件文件的 AI 总结缓存（按需生成，非同步路径）。key = (course_file_id, locale)：一次生成永久复用、多语言各存一行。status=failed 的行同样保留，作用是"不再重试"。';
comment on column public.file_summaries.summary is
  '结构化总结 { overview, points, formulas }。**只含模型的概述与要点，绝不含课件原文** —— 3-19「不下载内容」的红线在按需路径下依然按"不落副本"执行。';
comment on column public.file_summaries.source_chars is
  '抽取到的字符数（喂模型前的原始量）。与 source_truncated 一起决定界面上要不要标"覆盖不全"。';
comment on column public.file_summaries.source_modified_at is
  '生成这份总结时，该文件在 Canvas 上的 modified_at。读取侧与当前值比对：不同 = 老师换过文件 = 重算（旧总结会是过期的谎话）。';
comment on column public.file_summaries.error_message is
  '失败原因（已精简，不含课件内容）。同 llm_runs 的纪律：日志与错误里不出现用户内容。';

-- 读取路径永远是「按 course_file_id + locale 取一行」→ 主键已覆盖，无需再建索引。
-- 要按课程统计"这门课总结了几份"时再加（现在没有这个界面）。

drop trigger if exists trg_file_summaries_updated_at on public.file_summaries;
create trigger trg_file_summaries_updated_at
  before update on public.file_summaries
  for each row execute function public.set_updated_at();

-- ---------- RLS（与 message_summaries / course_files 同一写法） ----------

alter table public.file_summaries enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据只有一处
-- （通过 course_files → courses 反查 user_id），少一条策略就会让整张表谁都写不进
-- （总结静默生成不了）。
drop policy if exists file_summaries_via_file_all on public.file_summaries;
create policy file_summaries_via_file_all on public.file_summaries
  for all
  using (
    exists (
      select 1 from public.course_files f
      join public.courses c on c.id = f.course_id
      where f.id = file_summaries.course_file_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.course_files f
      join public.courses c on c.id = f.course_id
      where f.id = file_summaries.course_file_id and c.user_id = auth.uid()
    )
  );
