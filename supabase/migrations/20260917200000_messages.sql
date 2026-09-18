-- =============================================================
-- messages（P0-3-18 消息栏 · 系统提案收件箱）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    本迁移必须先执行，P0-3-18 的代码才能上线 —— 代码会把本表加进
--    消息列表 / pending 计数 / 确认与忽略的更新查询；
--    表不存在时 PostgREST 报 42P01 → 消息栏与侧栏徽标**全部**失败。
--    执行顺序：① 跑本 SQL → ② Bud 推代码 → ③ Vercel 部署。
--    ✅ 2026-09-17 已由 Steven 在 SQL Editor 执行完毕（回执：Success. no rows returned）。
--
-- 决策（2026-09-17 Steven 拍板）：
--   - 本表**只存系统提案**（syllabus_drift / practice_test / routine / material），
--     用户自己的对话**不入本表** —— 用户的更新只写 `tasks`（或 `exam_dates`），
--     不进这条时间线；用户消息瞬时存在，与 P0-3-8/3-8b 浮窗行为一致。
--   - 提案生命周期：`pending` → `accepted`（确认才写） / `dismissed`（忽略不写）。
--   - 与 ADR-015 一致：**本表本身不写任何业务数据**；`accepted` 只是"用户点了确认"，
--     真正写 `tasks` / `exam_dates` 的动作由消费方在确认时执行。
--   - 本表是**全站系统提案的唯一出口**（P0-3-20 / P0-3-23 都往这里发，不许各做一套 UI）。
--
-- 为什么 user_id 引用 profiles 而不是 auth.users：
--   与 usage_events 一致，删账号（P0-3-2）走 auth.admin.deleteUser → profiles 级联，
--   引用 profiles 即可被那条链带掉，不需要额外清理逻辑。
--
-- payload 由各提案类型自己定义（jsonb），本表不做 schema 校验 ——
-- 提案的字段形状属消费方（3-20 的 diff / 3-23 的自测卷），
-- 在这里强约束等于把两张卡的设计提前冻结在本文件里。
-- =============================================================

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (
    type in ('syllabus_drift', 'practice_test', 'routine', 'material')
  ),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now()
);

-- 收件箱的两种查询形态：按用户取某状态的列表（列表按时间倒序）
-- 与顶部 pending 计数。一个复合索引都覆盖，不额外建索引。
create index if not exists idx_messages_user_status_time
  on public.messages (user_id, status, created_at desc);

alter table public.messages enable row level security;

-- 用户只能插入"自己的"提案：写入走带会话的用户级客户端（RLS 生效）。
-- 少一条 INSERT 策略会把整张表变成谁都写不进（系统提案静默发不出来）。
drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own on public.messages
  for insert to authenticated
  with check (auth.uid() = user_id);

-- 只读自己的消息。
drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages
  for select to authenticated
  using (auth.uid() = user_id);

-- 确认 / 忽略 = 改 status，同样只能改自己的行。
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 不开放 DELETE：提案是审计痕迹，用户不需要删；删账号经 profiles 级联清空。

-- 验收（执行后跑，应返回 0 或你刚产生的行数）：
--   select status, count(*) from public.messages group by status;
