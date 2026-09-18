-- =============================================================
-- P0-3-25 · 公告自动进站（M3.5 第二张）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    本迁移**必须先执行**，代码才能上线 —— 代码会把 'announcement' 写进
--    `messages.type`，并读写 `course_announcements`。
--    顺序：① 跑本 SQL → ② Bud 写代码 + 推 → ③ Vercel 部署 → ④ 只读探针确认。
--    （`messages.type` 是 CHECK，不是列：漏跑的表现不是 42703，而是
--      **23514 check 约束冲突** —— 公告一条也发不进消息栏，且只在同步日志里。）
--
-- 本迁移做两件事：
--   1. `messages.type` 的 CHECK 加 'announcement'（枚举扩展，四处同改的第 3 处）；
--   2. 新建 `course_announcements` 去重表。
--
-- ---------------------------------------------------------------------------
-- 为什么需要 course_announcements（而不是直接把公告塞进 messages）
-- ---------------------------------------------------------------------------
-- 幂等。规范（Sync-Strategy §14）：**14 天滚动窗口**抓取，必然反复读到同一批公告。
-- 没有去重表就会出现「每同步一次，消息栏多一条同样的公告」—— 这是最伤信任的
-- 静默重复（用户会以为老师发了很多遍）。
-- 去重键 = `(course_id, canvas_announcement_id)`，**按 Canvas 的公告 id**，
-- 不按标题/时间（标题会改、时间有分秒误差）。
--
-- 这张表同时是「我们见过什么」的账：`message_id` 指向由它产生的那条消息，
-- 于是「已发过消息的公告」一眼可查，而不是靠 payload 里比对标题。
--
-- ---------------------------------------------------------------------------
-- 为什么 messages.type 的约束用 DO 块动态找名字
-- ---------------------------------------------------------------------------
-- 建表时写的是**列内** `check (...)`，约束名由 Postgres 自动生成
-- （`messages_type_check`）。写死名字在不同环境可能不存在 → 整段 SQL 报错中断。
-- 这里按「约束定义里含 syllabus_drift」来定位 —— `status` 的约束定义里
-- 是 pending/accepted/dismissed，**不含** syllabus_drift，所以不会误删。
--
-- 验收（执行后跑，应看到 type 约束定义里出现 'announcement'）：
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.messages'::regclass and contype = 'c';
-- =============================================================

-- ---------- 1. messages.type 加 'announcement' ----------

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
  check (type in ('syllabus_drift', 'practice_test', 'routine', 'material', 'announcement'));

comment on constraint messages_type_check on public.messages is
  '提案类型。与 types/message.ts 的 MessageType、lib/messages/view.ts 的 MESSAGE_TYPE_LABELS 必须一致（CodingRules §10.1 第 16 条：枚举扩展四处同改）。';

-- ---------- 2. course_announcements（公告去重账） ----------

-- 归属靠 `course_id → courses.user_id`，**不加 user_id 列** ——
-- 与 exam_dates / grade_components / course_outline_items 同一模式：
-- 一处归属、一处 RLS 判据，不给"两处 user_id 不同步"留口子。
--
-- 🔴 与 exam_dates 一样，`body_text` 存的是**清洗后的纯文本**：
--    Canvas 的 `message` 字段是 HTML，带 <script>/<style>/内联事件。
--    这里只落剥完标签的文本，渲染层再禁 `dangerouslySetInnerHTML` ——
--    两道一起才挡住 stored XSS（只做一道，另一道迟早被人"顺手优化"掉）。
create table if not exists public.course_announcements (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Canvas 的公告 id（数字，但**存 text**：不为了"看起来干净"去做整型转换，
  -- 上游给什么存什么 —— 将来若变成 UUID 也不必再迁移）。
  canvas_announcement_id text not null,
  title text,
  -- 清洗后的纯文本正文（剥标签 + 解实体 + 折叠空白）。
  body_text text,
  -- 回跳 Canvas 原文（Canvas 公告对象的 html_url），「原文链接」用它。
  html_url text,
  -- Canvas 侧的发布时间（posted_at），用于会话流排序与「新公告」判断。
  posted_at timestamptz,
  -- 首次抓到的时刻（我们这边的账）。
  first_seen_at timestamptz not null default now(),
  -- 最近一次在窗口里再次见到的时刻。14 天滚动窗口反复读到同一条时只更新它，
  -- **不新建行、不重发消息**。
  last_seen_at timestamptz not null default now(),
  -- 由本条公告产生的那条消息（可为 null = 无结构化落点、或还没处理）。
  -- 删消息不清公告账（set null）—— 账本来就该留着，否则下轮又当成新公告重发。
  message_id uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, canvas_announcement_id)
);

comment on table public.course_announcements is
  'P0-3-25 公告去重账。唯一键 (course_id, canvas_announcement_id) 保证 14 天滚动窗口反复抓取不会重复进消息栏。';
comment on column public.course_announcements.body_text is
  'Canvas 公告 message 字段**剥标签后**的纯文本（HTML 不落库）。渲染层禁 dangerouslySetInnerHTML。';
comment on column public.course_announcements.message_id is
  '本条公告产生的消息；null = 无结构化落点或尚未处理。删消息置 null，公告账保留（否则下轮会重发）。';
comment on column public.course_announcements.html_url is
  'Canvas 公告原文地址，消息栏「原文」链接回跳用。';

-- 同步每次按「该课 + 窗口内」查已见过的公告 → 走这个索引。
create index if not exists idx_course_announcements_course_posted
  on public.course_announcements (course_id, posted_at desc);

-- 重复同步时 PostgREST 的 upsert 靠它按 (course_id, canvas_announcement_id) 归并；
-- 上面 unique 约束已隐式建索引，无需再建一个。

drop trigger if exists trg_course_announcements_updated_at on public.course_announcements;
create trigger trg_course_announcements_updated_at
  before update on public.course_announcements
  for each row execute function public.set_updated_at();

-- ---------- 3. RLS（与 grade_components 同一写法） ----------

alter table public.course_announcements enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据只有一处，
-- 少一条策略就会让整张表谁都写不进（公告静默抓不进来）。
drop policy if exists course_announcements_via_course_all on public.course_announcements;
create policy course_announcements_via_course_all on public.course_announcements
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_announcements.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_announcements.course_id and c.user_id = auth.uid()
    )
  );
