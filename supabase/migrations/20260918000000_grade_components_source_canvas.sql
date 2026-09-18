-- =============================================================
-- P0-3-24 · grade_components.source 加 'canvas'
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    本迁移**不进 supabase/migrations/ 的自动执行链**（项目约定：迁移一律手跑），
--    文件只是给 SQL Editor 提供一份可复制的版本。
--
-- 为什么要加 'canvas'：
--   exam_dates.source 从建表起就是 ('syllabus','canvas','manual')，而
--   grade_components.source 只有 ('syllabus','manual') —— 同一个「来源」语义
--   两张表口径不一致。3-25（公告自动进站）与 3-19（资料索引）之后会有
--   **Canvas 侧写入的成绩构成**（如 Assignment Groups 权重），届时必须能标来源。
--   本卡先把枚举补平，避免到 3-25 临时补迁移、卡住部署。
--
-- 为什么用 DO 块动态找约束名：
--   建表时写的是**列内** `check (...)`，约束名由 Postgres 自动生成
--   （`grade_components_source_check`）。直接 `drop constraint` 写死名字
--   在不同环境可能不存在 → 整段 SQL 报错中断。这里按 `pg_constraint` 查真实名字。
--
-- 验收（执行后跑，应返回一行的 conname 与含 'canvas' 的定义）：
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.grade_components'::regclass and contype = 'c';
-- =============================================================

do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.grade_components'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%source%'
  loop
    execute format('alter table public.grade_components drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.grade_components
  add constraint grade_components_source_check
  check (source in ('syllabus', 'manual', 'canvas'));
