-- =============================================================
-- P0-3-11 · 邮件入站（inbound email）
-- 依据：docs/Phase-0-MVP.md P0-3-11（仅入站）
--      docs/Decisions.md ADR-019（密址绑定 + 入站-only + 砍回信）
-- =============================================================

-- 1) profiles.inbound_token：每个用户的专属入站密址 token
--    形如 inbound+<token>@<域>，token 即身份，构造上不可伪造（行业标配）。
alter table public.profiles
  add column if not exists inbound_token text null;

-- 唯一（仅对非空值建唯一索引，允许多行 token 为 NULL）。
drop index if exists profiles_inbound_token_key;
create unique index profiles_inbound_token_key
  on public.profiles (inbound_token)
  where inbound_token is not null;

-- 2) email_inbound_events：入站邮件审计日志。
--    user_id 可空：便于记录「未知地址」这类无法归属的邮件（service role 写入）。
create table if not exists public.email_inbound_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  received_from text not null,
  subject text,
  event_type text not null,
  matched_task_id uuid,
  action_taken text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists email_inbound_events_user_id_idx
  on public.email_inbound_events (user_id);

alter table public.email_inbound_events enable row level security;

-- 仅本人可读；webhook 经 service_role 写入（绕过 RLS），无需给 anon/authenticated 写权限。
drop policy if exists email_inbound_events_own_select on public.email_inbound_events;
create policy email_inbound_events_own_select on public.email_inbound_events
  for select
  using (auth.uid () = user_id);
