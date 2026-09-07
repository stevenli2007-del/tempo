-- =============================================================
-- usage_events（P0-3-1 量化指标埋点）
--
-- 依据 PRD 8.1 的四项指标反推：
--   - 7 日回访次数       → 需要「打开总览页」的逐次记录（此前没有任何表记这件事）
--   - token 续期完成率   → 需要「提醒出现过」与「之后真的续期了」两个事件
--   - 编辑修正率         → parse_corrections 已够，不需要新埋点
--   - 人均关联课程数     → courses.canvas_course_id 已够，不需要新埋点
--
-- 所以本表只为**前两项**而建：三类事件，写三处（dashboard 渲染 / 过期横幅 /
-- 重新连接 Canvas）。不为"将来可能想看"的事件预留类型 —— 加了没人用的枚举值
-- 只会让这张表变成垃圾桶。
--
-- ⚠️ 这是【Steven 手动】步骤：在 Supabase Dashboard → SQL Editor 粘贴执行。
--    未执行时：埋点写入会被 lib/usage-events.ts 吞掉（只 console.warn，
--    绝不让总览页白屏），GET /api/v1/metrics 会 500 —— **不会静默返回假数据**。
-- =============================================================

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  event_type text not null check (
    event_type in ('dashboard_view', 'expiry_reminder_shown', 'credential_renewed')
  ),
  created_at timestamptz not null default now()
);

-- 指标查询的两种形态：按「用户 + 事件类型」取时间窗内的行（7 日回访）
-- 与按类型取最近一条（提醒每日只记一次）。一个复合索引都覆盖。
create index if not exists idx_usage_events_user_event_time
  on public.usage_events (user_id, event_type, created_at desc);

alter table public.usage_events enable row level security;

-- 用户只能插入"自己的"事件：埋点走的是带会话的用户级客户端（RLS 生效），
-- 少一条 INSERT 策略就会把整张表变成谁都写不进（也就等于埋点静默失效）。
drop policy if exists usage_events_insert_own on public.usage_events;
create policy usage_events_insert_own on public.usage_events
  for insert to authenticated
  with check (auth.uid() = user_id);

-- SELECT 只给自己：用户本人理论上不读这张表，但留一条自我的读策略，
-- 便于将来做「你最近 7 天打开过 3 次」这类自查；不开放 update / delete
-- （埋点是事实记录，不该被改写，删账号走 profiles 的级联）。
drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using (auth.uid() = user_id);

-- P0-3-2「一键删除账号及全部数据」的级联范围要带上本表：
-- 上面 user_id 的 on delete cascade 已覆盖（删 profiles 行即级联清空），
-- 此处只是把这条约束显式写进迁移，避免 P0-3-2 漏掉它。

-- 验收（执行后跑，应返回 0 或你刚打开总览页产生的行数）：
--   select event_type, count(*) from public.usage_events group by event_type;
