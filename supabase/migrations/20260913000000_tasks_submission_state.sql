-- P0-3-10：Canvas 提交状态同步 + 日期时区修复 的数据层
-- 执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行（本项目无自动 migrator）。
-- 同时作用于 local + prod（两者共享同一个实例）。
--
-- 新增两列：
--   submission_state  Canvas 真相（同步写，用户主权 status 永不改，ADR-015）
--   submitted_at     Canvas submission.submitted_at 原样落地（timestamptz）
--
-- submission_state 取值语义（与同步层 deriveSubmission 一一对应）：
--   null                   Canvas 不追踪完成态（on_paper / none / not_graded → 用户手勾；或 external_tool 待判定）
--   'unsubmitted'          Canvas 追踪但用户未交
--   'submitted'            已提交、未评分
--   'pending_review'       已交、待查重
--   'graded'               已评分（视为完成）
--   'missing'              Canvas 标记缺交（逾期且未交）
--   'external_unconfirmed' 外部平台（Gradescope 等 LTI 外链）提交，Canvas 无记录 → 展示「待确认」
--
-- ⚠️ 已存在的行 submission_state 默认 null；下次同步会被同步层重新计算覆盖，无需回填。

alter table public.tasks
  add column if not exists submission_state text
    check (
      submission_state is null
      or submission_state in
        ('unsubmitted', 'submitted', 'pending_review', 'graded', 'missing', 'external_unconfirmed')
    ),
  add column if not exists submitted_at timestamptz;

comment on column public.tasks.submission_state is
  'Canvas 真相（同步写，用户主权 status 永不改，ADR-015）。null = Canvas 不追踪完成态；取值语义见 P0-3-10 执行卡。';
comment on column public.tasks.submitted_at is
  'Canvas submission.submitted_at 原样落地（timestamptz）；展示层按学校时区（America/Los_Angeles）渲染。';
