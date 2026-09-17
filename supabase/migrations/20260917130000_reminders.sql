-- =============================================================
-- P0-3-14 · 主动提醒 / 优先级（出站体系）
-- 依据：docs/Phase-0-MVP.md P0-3-14
--      docs/Decisions.md ADR-017（秘书护城河）/ ADR-019（出站归本卡）
-- =============================================================

-- 1) profiles：提醒总开关 + 上次发送时间 + 退订 token
--    reminder_enabled 默认 true：现有与未来用户都默认开启（ADR-016「Tempo 找人」）。
--    last_reminder_at：频控用，约束「每用户每天至多一封」。
--    reminder_unsub_token：退订链接里的随机 token，按 token 定位用户并关提醒。
alter table public.profiles
  add column if not exists reminder_enabled boolean not null default true,
  add column if not exists last_reminder_at timestamptz null,
  add column if not exists reminder_unsub_token text null;

-- 退订 token 唯一（仅对非空值建唯一索引，允许多行 token 为 NULL）。
drop index if exists profiles_reminder_unsub_token_key;
create unique index profiles_reminder_unsub_token_key
  on public.profiles (reminder_unsub_token)
  where reminder_unsub_token is not null;
