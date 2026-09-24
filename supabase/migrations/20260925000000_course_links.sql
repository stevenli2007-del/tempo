-- =============================================================
-- P0-5-3 · 外部课程网站链接监控
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    本迁移**必须先执行**，代码才能上线 —— 代码会把行写进 `course_links`、
--    把 'link_change' 写进 `messages.type`。
--    顺序：① 跑本 SQL → ② Bud 写代码 + 推 → ③ Vercel 部署 → ④ 只读探针确认。
--    （`messages.type` 是 CHECK，不是列：漏跑的表现不是 42703，而是
--     **23514 check 约束冲突** —— 链接变更消息一条也发不进消息栏，且只在同步日志里。）
--
-- 本迁移做两件事：
--   1. 新建 `course_links` 表（用户贴的外部课程站点链接 + 抓取指纹快照）。
--   2. `messages.type` 的 CHECK 加 'link_change'（枚举扩展，四处同改的第 3 处）。
--
-- ---------------------------------------------------------------------------
-- 为什么需要 course_links（而不是直接把"变了"塞进 messages）
-- ---------------------------------------------------------------------------
-- 幂等。每日 Cron 重抓同一批链接，必然反复读到同一页面。
-- 没有落库的状态（上次指纹），就会出现「每轮 Cron 都发一条『变了』」——
-- 这是最伤信任的静默重复。存上一次的指纹，比对时才只报**真变化**。
--
-- ---------------------------------------------------------------------------
-- 🔴 ADR-026 红线：绝不存原文
-- ---------------------------------------------------------------------------
-- `fingerprint` 是**分段归一化指纹**（每段一个 `{label, hash}`），原文**不落库**
-- （见 `lib/course-links/fingerprint.ts`）。`label` 只是该段的**简短锚点**
-- （段落前 ~60 字），不是内容；要"哪块变了"靠它给一句人话，而非存全文。
-- 三道闸门（协议 / 字面量主机 / DNS 真实 IP）在发请求前，见 `lib/ingest/url-fetch.ts`。
--
-- ---------------------------------------------------------------------------
-- 为什么 messages.type 的约束用 DO 块动态找名字
-- ---------------------------------------------------------------------------
-- 建表时写的是**列内** `check (...)`，约束名由 Postgres 自动生成
-- （`messages_type_check`）。写死名字在不同环境可能不存在 → 整段 SQL 报错中断。
-- 这里按「约束定义里含 syllabus_drift」来定位 —— `status` 的约束定义里
-- 是 pending/accepted/dismissed/undone，**不含** syllabus_drift，所以不会误删。
--
-- 验收（执行后跑，应看到 type 约束定义里出现 'link_change'）：
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.messages'::regclass and contype = 'c';
-- =============================================================

-- ---------- 1. course_links ----------

create table if not exists public.course_links (
  id uuid primary key default gen_random_uuid(),
  -- 归属靠 `course_id → courses.user_id`，**不加 user_id 列**（与 exam_dates /
  -- grade_components / course_announcements / course_files 同一模式：一处归属、一处 RLS 判据）。
  course_id uuid not null references public.courses (id) on delete cascade,
  -- 用户贴的外部链接（已校验：http(s) + 非本机/内网，见 lib/course-links/store.ts）。
  url text not null,
  -- 用户给的备注名（可空）；展示时回退到 page_title，再回退到 host。
  label text,
  -- 抓取到的 <title>（可空，Cron 重抓时若抽到就回填；目前 Cron 只取正文，故多为 null）。
  page_title text,
  -- 🔴 ADR-026：只存分段指纹，**绝不存原文**。null = 还没成功抓过（待首次检查）。
  fingerprint jsonb,
  -- 最近一次 Cron 重抓的时刻（null = 还没检查过）。
  last_checked_at timestamptz,
  -- 最近一次检查的结果（给用户看的可见状态，R3「失败要可见」）。
  last_status text not null default 'pending'
    check (last_status in ('pending', 'ok', 'unreachable', 'blocked', 'unsupported')),
  -- 失败的人话原因（如「打不开这个链接」「出于安全考虑，不能抓取本机/内网地址」）。
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 同一门课不能重复监控同一个 URL。
  unique (course_id, url)
);

comment on table public.course_links is
  'P0-5-3 外部课程网站链接监控。存 URL + 上一次抓取的分段指纹（ADR-026：原文绝不落库）；每日 Cron 重抓比对，变化进消息栏。';
comment on column public.course_links.fingerprint is
  '分段归一化指纹（[{label, hash}]）。label 是段落前 ~60 字的简短锚点，hash 是段落 sha256。原文绝不落库。';
comment on column public.course_links.last_status is
  '最近一次检查可见状态：pending(待首次检查)/ok/unreachable(打不开)/blocked(SSRF 拦截)/unsupported(非网页)。';
comment on column public.course_links.last_error is
  '失败的人话原因；成功时为 null。';

-- 按课程取监控列表（课程页主查询）。
create index if not exists idx_course_links_course on public.course_links (course_id);
-- unique(course_id, url) 已隐式建索引，无需再建。

drop trigger if exists trg_course_links_updated_at on public.course_links;
create trigger trg_course_links_updated_at
  before update on public.course_links
  for each row execute function public.set_updated_at();

-- ---------- 2. RLS（与 grade_components / course_files 同一写法） ----------

alter table public.course_links enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据只有一处，
-- 少一条策略就会让整张表谁都写不进（链接静默存不进来）。
drop policy if exists course_links_via_course_all on public.course_links;
create policy course_links_via_course_all on public.course_links
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_links.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_links.course_id and c.user_id = auth.uid()
    )
  );

-- ---------- 3. messages.type 加 'link_change' ----------

do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%syllabus_drift%'
  loop
    execute format('alter table public.messages drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.messages
  add constraint messages_type_check
  check (type in ('syllabus_drift', 'practice_test', 'routine', 'material', 'announcement', 'link_change'));

comment on constraint messages_type_check on public.messages is
  '提案类型。与 types/message.ts 的 MessageType、lib/messages/view.ts 的 MESSAGE_TYPE_LABELS 必须一致（CodingRules §10.1 第 16 条：枚举扩展四处同改）。';
