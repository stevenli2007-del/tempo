-- =============================================================
-- canvas_credentials 约束对齐（P0-2-2）
--
-- 依据 2026-09-04 P0-2-1b 实测：bCourses 的 token 过期时间是**强制必填**，
-- 上限 90 天。Database.md 已据此把 expires_at 改为 NOT NULL，这里让表结构跟上。
--
-- ⚠️ 这是【Steven 手动】步骤：在 Supabase Dashboard → SQL Editor 粘贴执行。
--    代码层（lib/canvas/validate.ts）已经强制 expiresAt 必填，
--    所以本迁移是"约束层加固"，不执行也不影响 P0-2-2 功能验收。
--
-- 执行前先确认表里没有脏数据（本表在 P0-2-2 之前从未写入，应为空）：
--   select count(*) from public.canvas_credentials;
-- =============================================================

-- 1. expires_at 改为 NOT NULL
--
-- 若表里已有 expires_at 为 null 的行，这条会失败 —— 那是正确行为：
-- 说明存在"不知道什么时候过期"的凭据，应先补上或删掉，而不是放宽约束。
alter table public.canvas_credentials
  alter column expires_at set not null;

-- 2. 一个用户只应有一条凭据
--
-- 加了这个约束后，lib/canvas/credentials.ts 的"先查后写"可以换成
-- upsert({ onConflict: 'user_id' })，彻底消除并发下产生两条凭据的可能。
-- 约束就位前后代码都能工作，所以不做强依赖。
alter table public.canvas_credentials
  add constraint canvas_credentials_user_id_key unique (user_id);
