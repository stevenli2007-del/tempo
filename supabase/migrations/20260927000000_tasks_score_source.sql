-- 手工分数标记（P0-3-34）
--
-- ### 为什么需要这一列
-- Canvas 同步每轮都会照 `include[]=submission` 重写 `submission_score` / `points_possible`。
-- 用户在对话框里手记的分（典型场景：老师只把 quiz 登在 Gradescope 上，Canvas 里那条
-- assignment 的两个分数列恒为 null）会被下一轮同步**覆盖回 null** ——
-- 界面上看起来"什么都没发生"，用户只会以为自己记错了。
-- 这是 ADR-015「用户主权」的同款坑，必须在同步侧有依据地跳过那两列。
--
-- ### 取值
--   null      从未被手工覆盖（旧数据、以及本来就没有分数的行都在这）
--   'canvas'  这两列的权威值是 Canvas 给的 → 同步照写
--   'manual'  用户在 Tempo 里手记的 → 同步**不写也不比**这两列
--
-- ⚠️ 刻意**不 backfill**：null 与 'canvas' 在同步侧的行为完全一样（都可写），
-- 把旧行一律刷成 'canvas' 只是让语义好看一点，却要在生产库上多跑一条全表 update。
--
-- ⚠️ 不加 NOT NULL：三态是有意义的（见上）。
--
-- 幂等写法：可重复执行，重跑不会报错。

alter table public.tasks
  add column if not exists score_source text;

alter table public.tasks
  drop constraint if exists tasks_score_source_check;

alter table public.tasks
  add constraint tasks_score_source_check
  check (score_source is null or score_source in ('canvas', 'manual'));

comment on column public.tasks.score_source is
  '分数来源（P0-3-34）：null=从未手工覆盖 / canvas=Canvas 权威 / manual=用户手记（同步跳过 points_possible 与 submission_score）';
