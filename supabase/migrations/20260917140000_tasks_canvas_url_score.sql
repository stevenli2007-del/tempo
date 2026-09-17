-- P0-3-17：课程详情重排 + 抓取信息落地 的数据层
-- 执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行（本项目无自动 migrator）。
-- 同时作用于 local + prod（两者共享同一个实例）。
--
-- 🔴【Steven 手动】本迁移必须先执行，P0-3-17 的代码才能上线 ——
--    代码把这三列加进了 `TASK_COLUMNS`（列表与单条查询共用），
--    列不存在时 PostgREST 会报 42703 undefined_column → 总览页与课程页的任务查询**全部**失败。
--    执行顺序：① 跑本 SQL → ② Bud 推代码 → ③ Vercel 部署。
--
-- 新增三列（全部可空，**不回填**：Canvas 下次同步会写进去）：
--   canvas_url       Canvas 作业页地址（html_url 原样落地）→ 「点任务名跳 Canvas」
--   points_possible  该作业满分（Canvas 作业对象上的 points_possible）
--   submission_score 当前用户的得分（Canvas submission.score）
--
-- ⚠️ score 与 points_possible 都可能为 null，且**含义不同**：
--   points_possible = null → Canvas 没设满分（不是 0 分）
--   submission_score = null → 尚未评分（不是 0 分）
--   展示层必须按「null 不画进度条」处理，禁止用 0 代替（Database.md §3.9 的同一原则）。

alter table public.tasks
  add column if not exists canvas_url text,
  add column if not exists points_possible numeric(10, 2),
  add column if not exists submission_score numeric(10, 2);

comment on column public.tasks.canvas_url is
  'Canvas 作业页地址（html_url）。任务名渲染为此外链（P0-3-17）；null = 非 Canvas 来源或 Canvas 未给。';
comment on column public.tasks.points_possible is
  'Canvas 作业满分（points_possible）。null = Canvas 未设满分（**不等于 0 分**），此时不画分数条。';
comment on column public.tasks.submission_score is
  'Canvas submission.score（当前用户得分）。null = 尚未评分（**不等于 0 分**）。与 points_possible 一起画分数条。';
