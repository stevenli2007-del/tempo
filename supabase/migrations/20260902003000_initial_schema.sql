-- =============================================================
-- Tempo 初始 schema（P0-0-4）
-- 13 张表 + 外键 + updated_at 触发器 + 索引
--
-- 单一事实源：docs/Database.md。本文件只是它的 SQL 落地。
-- 约束：
--   * 表名/字段名与 Database.md 一字不差（snake_case）
--   * 枚举用 text + CHECK，不用 Postgres enum 类型
--   * 软删除（is_deleted / is_archived），Phase 0 不做物理删除
--   * 可重复执行（create table if not exists / create index if not exists）
--
-- 说明：CHECK 约束只加在「闭合的业务枚举」上；「可插拔/开放式」标识
--   （llm_runs.provider、llm_runs.purpose）故意不加 CHECK —— provider 要能
--   无缝切换，purpose 会随功能增长（Database.md 原文「syllabus_parse 等」）。
-- =============================================================

-- gen_random_uuid() 依赖（幂等；Supabase 已默认可用，这里兜底）
create extension if not exists pgcrypto;

-- =============================================================
-- updated_at 自动维护触发器
-- =============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================
-- 3.1 profiles（用户扩展信息）
-- =============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'America/Los_Angeles',
  demo_seeded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.2 courses（课程 Workspace）
-- =============================================================
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  semester text not null,
  course_name text not null,
  course_code text,
  instructor_name text,
  canvas_course_id text,
  is_demo boolean not null default false,
  is_archived boolean not null default false,
  last_synced_at timestamptz,
  sync_status text not null default 'never'
    check (sync_status in ('never', 'success', 'failed')),
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.3 syllabi（Syllabus 文件与解析记录）
-- =============================================================
create table if not exists public.syllabi (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  file_url text not null,
  file_name text not null,
  extract_method text
    check (extract_method in ('pdf_text', 'docx', 'pptx', 'manual')),
  extract_status text not null default 'pending'
    check (extract_status in ('pending', 'extracted', 'failed')),
  extract_error text,
  raw_text text,
  page_count integer,
  parse_status text not null default 'pending'
    check (parse_status in ('pending', 'processing', 'completed', 'failed')),
  parse_error text,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.4 grade_components（成绩构成）
-- =============================================================
create table if not exists public.grade_components (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  name text not null,
  weight_percent numeric,
  notes text,
  is_confirmed boolean not null default false,
  source text not null default 'syllabus'
    check (source in ('syllabus', 'manual')),
  source_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.5 course_outline_items（课程大纲/章节）
-- =============================================================
create table if not exists public.course_outline_items (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  order_index integer not null default 0,
  week_label text,
  topic text not null,
  source text not null default 'syllabus',
  source_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.6 exam_dates（考试日期 —— 权威源）
-- =============================================================
create table if not exists public.exam_dates (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  exam_name text not null,
  exam_date date,
  exam_time text,
  location text,
  status text not null default 'tbd'
    check (status in ('confirmed', 'tbd')),
  is_confirmed boolean not null default false,
  source text not null default 'syllabus'
    check (source in ('syllabus', 'canvas', 'manual')),
  source_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.7 office_hours（Office Hour）
-- =============================================================
create table if not exists public.office_hours (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  person_name text not null,
  day_of_week text,
  start_time text,
  end_time text,
  location text,
  source text,
  source_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.8 submission_policies（提交政策）
-- =============================================================
create table if not exists public.submission_policies (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  description text not null,
  platform_name text,
  source text,
  source_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.9 tasks（统一任务列表 —— 总览页核心数据源）
-- =============================================================
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  due_date timestamptz,
  task_type text not null
    check (task_type in ('assignment', 'exam', 'reading', 'other')),
  source text not null
    check (source in ('canvas', 'syllabus', 'manual')),
  source_id text,
  status text not null default 'pending'
    check (status in ('pending', 'done')),
  is_derived boolean not null default false,
  external_updated_at timestamptz,
  last_seen_at timestamptz,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.10 canvas_credentials（Canvas 访问凭证）
-- =============================================================
create table if not exists public.canvas_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  secret_encrypted text not null,
  credential_type text not null default 'pat'
    check (credential_type in ('pat', 'ical', 'oauth')),
  canvas_domain text not null,
  expires_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'expired', 'revoked', 'error')),
  last_used_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 3.11 sync_runs（同步批次日志）—— 日志表，无 updated_at 触发器
-- =============================================================
create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  trigger_type text not null
    check (trigger_type in ('app_open', 'manual', 'scheduled')),
  status text not null
    check (status in ('running', 'success', 'partial', 'failed')),
  courses_synced integer not null default 0,
  tasks_created integer not null default 0,
  tasks_updated integer not null default 0,
  tasks_deleted integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- =============================================================
-- 3.12 llm_runs（LLM 调用审计）—— 日志表，无 updated_at 触发器
-- =============================================================
create table if not exists public.llm_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  purpose text not null,
  syllabus_id uuid references public.syllabi(id) on delete cascade,
  provider text not null,
  model text not null,
  prompt_version text not null,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  status text not null
    check (status in ('success', 'failed')),
  error_message text,
  created_at timestamptz not null default now()
);

-- =============================================================
-- 3.13 parse_corrections（用户修正记录）—— 日志表，无 updated_at 触发器
-- =============================================================
create table if not exists public.parse_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  syllabus_id uuid references public.syllabi(id) on delete cascade,
  llm_run_id uuid references public.llm_runs(id) on delete cascade,
  entity_type text not null
    check (entity_type in ('grade_component', 'exam_date', 'outline_item', 'office_hour', 'submission_policy')),
  entity_id uuid not null,
  field_name text not null,
  original_value text,
  corrected_value text,
  correction_type text not null
    check (correction_type in ('edit', 'delete', 'add')),
  created_at timestamptz not null default now()
);

-- =============================================================
-- updated_at 触发器（10 张非日志表）
-- =============================================================
drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_courses_updated_at on public.courses;
create trigger trg_courses_updated_at
  before update on public.courses
  for each row execute function public.set_updated_at();

drop trigger if exists trg_syllabi_updated_at on public.syllabi;
create trigger trg_syllabi_updated_at
  before update on public.syllabi
  for each row execute function public.set_updated_at();

drop trigger if exists trg_grade_components_updated_at on public.grade_components;
create trigger trg_grade_components_updated_at
  before update on public.grade_components
  for each row execute function public.set_updated_at();

drop trigger if exists trg_outline_items_updated_at on public.course_outline_items;
create trigger trg_outline_items_updated_at
  before update on public.course_outline_items
  for each row execute function public.set_updated_at();

drop trigger if exists trg_exam_dates_updated_at on public.exam_dates;
create trigger trg_exam_dates_updated_at
  before update on public.exam_dates
  for each row execute function public.set_updated_at();

drop trigger if exists trg_office_hours_updated_at on public.office_hours;
create trigger trg_office_hours_updated_at
  before update on public.office_hours
  for each row execute function public.set_updated_at();

drop trigger if exists trg_submission_policies_updated_at on public.submission_policies;
create trigger trg_submission_policies_updated_at
  before update on public.submission_policies
  for each row execute function public.set_updated_at();

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

drop trigger if exists trg_canvas_credentials_updated_at on public.canvas_credentials;
create trigger trg_canvas_credentials_updated_at
  before update on public.canvas_credentials
  for each row execute function public.set_updated_at();

-- =============================================================
-- 索引（与 Database.md 7.1 一一对应）
-- =============================================================

-- 课程按用户查（最高频）
create index if not exists idx_courses_user_id on public.courses(user_id);

-- 任务按课程查 + 按 due_date 排序（总览页主查询）
create index if not exists idx_tasks_course_id on public.tasks(course_id);
create index if not exists idx_tasks_due_date on public.tasks(due_date) where is_deleted = false;

-- 去重唯一索引（Database.md 3.9，必须建）
create unique index if not exists tasks_source_unique
  on public.tasks(course_id, source, source_id)
  where source_id is not null;

-- 各子表按课程查
create index if not exists idx_grade_components_course_id on public.grade_components(course_id);
create index if not exists idx_exam_dates_course_id on public.exam_dates(course_id);
create index if not exists idx_outline_items_course_id on public.course_outline_items(course_id);

-- 同步日志按用户 + 时间倒序
create index if not exists idx_sync_runs_user_started on public.sync_runs(user_id, started_at desc);
