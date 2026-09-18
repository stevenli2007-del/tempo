-- =============================================================
-- P0-3-26 · 回执 + 撤销（M3.5 第三张）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    顺序（代码已写完并 commit `4202050`，只差这步）：
--      ① Steven 跑本 SQL（加 decided_at + CHECK 放 undone）
--      ② Bud 跑 `npm run probe:schema` 确认 CHECK 真放宽（undone 不再被拒）
--      ③ 推到 main（Vercel 自动部署）—— ⚠️ 必须 ①②③ 顺序，先 SQL 后部署，否则 decided_at 缺失 42703 全挂。
--
-- 本迁移做两件事：
--   1. 加 `decided_at timestamptz` 列：记录"确认 / 撤销"那一刻，
--      供 24h 撤销窗口判定（撤销只在确认后 24h 内允许，终态）；
--   2. `messages.status` 的 CHECK 加 'undone'（枚举扩展，四处同改的第 3 处）。
--
-- 撤销语义（详见 docs/Phase-0-MVP.md 的 P0-3-26 卡面）：
--   - 确认后 24h 内可撤销：把当时写入的考试 / 成绩构成回滚，并同步移除派生任务；
--   - 超过窗口或已撤销都不可再操作；撤销后 status='undone'（终态，不可再确认）。
--
-- 🔴 与 P0-3-25 同一手法：用 DO 块按约束定义内容定位 status 约束再 drop，
--   因为建表时它是列内 check，名字由 PG 自动生成，不同环境可能不一样。
--   status 约束的定义里含 'pending'（type 约束含的是 syllabus_drift，不会误删）。
-- =============================================================

-- ---------- 1. decided_at 列 ----------
alter table public.messages
  add column if not exists decided_at timestamptz;

-- ---------- 2. messages.status 加 'undone' ----------
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%pending%'
  loop
    execute format('alter table public.messages drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.messages
  add constraint messages_status_check
  check (status in ('pending', 'accepted', 'dismissed', 'undone'));

comment on constraint messages_status_check on public.messages is
  '提案状态。pending=待处理 / accepted=已确认(确认才写) / dismissed=已忽略 / undone=已撤销(24h 内可撤销，终态)。与 types/message.ts 的 MessageStatus、lib/messages/registry.ts 的 MESSAGE_STATUSES 必须一致（CodingRules §10.1 第 16 条：枚举扩展四处同改）。';

-- 验收（执行后跑，应看到 status 约束定义里出现 'undone'）：
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.messages'::regclass and contype = 'c';
