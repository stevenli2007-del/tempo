-- =============================================================
-- P0-3-25b · 公告 AI 总结（落库缓存，M3.5 追加）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    顺序：① 跑本 SQL → ② Bud 推代码 → ③ Vercel 部署 → ④ 打开消息栏让总结自己生成。
--    漏跑的表现**不严重但会静默**：消息栏照常打开（读取侧 fail soft），
--    只是每条公告都没有 AI 要点、且每次打开都白打一次模型请求（日志里是 42P01/关系不存在）。
--
-- 本迁移只做一件事：新建 `message_summaries`（消息 → AI 要点的缓存）。
--
-- ---------------------------------------------------------------------------
-- 为什么是"落库缓存"而不是"同步时顺手总结"
-- ---------------------------------------------------------------------------
-- ① **不能塞进同步路径**：T1（打开 dashboard 触发同步）是用户**等着的**路径，
--    5 条公告 × 每次 3 秒串行 = 打开明显变慢；而定时同步跑在 service role 下
--    （无 cookies），`runStructured()` 的审计写入依赖会话 client —— 那一轮
--    `llm_runs` 直接写不进去（ADR-003 复审要的数据就断了）。
-- ② **一次生成、永久复用**：公告正文是不可变的（老师改了会是一条新公告，
--    去重键是 Canvas 公告 id），所以要点算出来就是终值，没必要反复花钱。
--
-- ---------------------------------------------------------------------------
-- 为什么 key 带 locale（而不是"一个 message 一个要点"）
-- ---------------------------------------------------------------------------
-- Steven 2026-09-18 拍板：**先出中文要点**（公告原文几乎全是英文），
-- 但"后期 Tempo 也要出英文版给外国人用"。
-- 若不分语言，英文版上线后生成的英文要点会**覆盖**中文那条，
-- 用户在两种界面之间切换就会反复触发重新生成（互相踩踏、每次都花钱）。
-- 分语言后：一个消息可以有 zh-CN / en 两条要点，各用各的、互不干扰，
-- 加一门语言 = 加一行数据，不需要迁移。
--
-- ⚠️ 因此 `locale` **不加 CHECK 约束**（与 `messages.type` 那类"枚举四处同改"不同）：
--    `type` 决定代码分支（哪个 applier 接手），locale 只是数据标签
--    （查询条件 + 展示语言）。加一种语言不该被一次迁移卡住。
--    `status` 是代码分支（ok = 有要点可渲染 / failed = 别再重试）→ 有 CHECK。
--
-- ---------------------------------------------------------------------------
-- 为什么失败也要落一行（status = 'failed'）
-- ---------------------------------------------------------------------------
-- 缓存表的第二职责是"**别反复重试**"。模型对某条公告持续给不出结果时，
-- 只记成功不记失败 = 每次打开消息栏都为同一条公告重打一次模型（用户的操作量没变，
-- 但账单和延迟一直涨）。所以失败也落一行：`points` 为空、`error_message` 留原因，
-- 读取侧把它当"没有要点"（`points = []`）→ 界面不显示任何东西、也不重试。
-- 要重新试一次就删掉那一行（`delete from message_summaries where status = 'failed'`）。
--
-- 验收（执行后跑，应看到 10 列 + RLS 已开）：
--   select column_name, data_type from information_schema.columns
--   where table_name = 'message_summaries' order by ordinal_position;
--   select relrowsecurity from pg_class where relname = 'message_summaries';  -- 期望 t
-- =============================================================

create table if not exists public.message_summaries (
  -- 归属**不直接落在本表**：一条摘要属于哪条消息，消息属于谁 ——
  -- 与 course_announcements / exam_dates 同一模式（一处归属、一处 RLS 判据）。
  message_id uuid not null references public.messages (id) on delete cascade,
  -- 要点语言（`zh-CN` / `en`，白名单在 `lib/messages/summary/locale.ts`）。
  locale text not null,
  -- `ok` = 模型跑通（points 可能为空数组 = 正文没实质信息）；
  -- `failed` = 调用/校验失败，**落这一行的意义是"别再重试"**。
  status text not null default 'ok' check (status in ('ok', 'failed')),
  -- 要点数组（jsonb）。用 jsonb 而不是 text：渲染层逐条画 <li>，
  -- 且将来要加"这条要点出自哪条公告"时不用再改列类型。
  points jsonb not null default '[]'::jsonb,
  -- 实际喂给模型的公告条数 / 这条消息挂着的公告总数。
  -- 🔴 两者不相等时界面必须如实说明（"基于最新 20 条 / 共 40 条"）——
  --    摘要覆盖不全而假装全，就是"计数撒谎"。
  items_used integer not null default 0,
  items_total integer not null default 0,
  -- 写进 llm_runs 的同一组值（实际服务的模型名，不是请求时填的别名）。
  model text,
  -- 失败原因（精简、**不含公告原文**，同 llm_runs.error_message 的纪律）。
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一个消息 + 一种语言只有一行：并发生成（两次打开消息栏撞一起）时靠它收敛，
  -- 不会出现"同一条消息两条要点"这种无法解释的重复。
  primary key (message_id, locale)
);

comment on table public.message_summaries is
  'P0-3-25b 消息的 AI 要点缓存。key = (message_id, locale)：一次生成永久复用，多语言各存一行互不覆盖。status=failed 的行同样保留，作用是"不再重试"。';
comment on column public.message_summaries.points is
  '要点数组（字符串）。空数组是**合法结果**（正文只有寒暄），不等于失败。';
comment on column public.message_summaries.items_used is
  '实际喂给模型的公告条数；与 items_total 不等时渲染层必须如实标注覆盖率，不许假装覆盖全部。';
comment on column public.message_summaries.error_message is
  '失败原因（已精简，不含公告原文）。同 llm_runs 的纪律：日志与错误里不出现用户内容。';

-- 读取路径是「按 message_id 批量查」（消息栏一屏可能十几条）→ 主键已覆盖 message_id 前缀，
-- 无需再建索引。要单独按 language 统计时再加。

drop trigger if exists trg_message_summaries_updated_at on public.message_summaries;
create trigger trg_message_summaries_updated_at
  before update on public.message_summaries
  for each row execute function public.set_updated_at();

-- ---------- RLS（与 course_announcements 同一写法） ----------

alter table public.message_summaries enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据只有一处，
-- 少一条策略就会让整张表谁都写不进（要点静默生成不了）。
drop policy if exists message_summaries_via_message_all on public.message_summaries;
create policy message_summaries_via_message_all on public.message_summaries
  for all
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_summaries.message_id and m.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.messages m
      where m.id = message_summaries.message_id and m.user_id = auth.uid()
    )
  );
