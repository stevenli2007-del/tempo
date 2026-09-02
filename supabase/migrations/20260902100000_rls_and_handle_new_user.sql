-- =============================================================
-- P0-0-5 · RLS 策略 + handle_new_user 触发器
-- 依据：docs/Security-Privacy.md §4 行级安全（RLS）
--      docs/Database.md §7.2 RLS（概要）
--
-- 策略分组：
--   A) 直属用户表（直接持 user_id）    → auth.uid() = user_id
--      profiles / canvas_credentials / sync_runs / parse_corrections
--      courses
--   B) 挂在课程下的子表（无 user_id）   → 经 courses 反查
--      syllabi / grade_components / course_outline_items /
--      exam_dates / office_hours / submission_policies / tasks
--   C) 特殊：llm_runs                   → user_id 可空，仅本人/非空可见
--      （user_id IS NULL 的系统调用日志只能 service role 看）
--
-- handle_new_user 触发器：
--   auth.users 插入 → 在 public.profiles 同步插一行
--   用 SECURITY DEFINER 绕过 RLS（触发器上下文 auth.uid() 为 NULL）
--   ON CONFLICT DO NOTHING 保证幂等（重发注册事件不会爆）
-- =============================================================

-- =============================================================
-- A) 直属用户表的 RLS 策略
-- =============================================================

-- profiles：用户扩展信息表（id = auth.users.id）
alter table public.profiles enable row level security;

create policy profiles_own_all on public.profiles
  for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- courses：用户创建的课程 workspace
alter table public.courses enable row level security;

create policy courses_own_all on public.courses
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- canvas_credentials：Canvas 访问凭证（敏感数据，user_id 直查）
alter table public.canvas_credentials enable row level security;

create policy canvas_credentials_own_all on public.canvas_credentials
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- sync_runs：同步批次日志（user_id 直查，便于"我的同步历史"列表）
alter table public.sync_runs enable row level security;

create policy sync_runs_own_all on public.sync_runs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- parse_corrections：用户修正记录（user_id 直查）
alter table public.parse_corrections enable row level security;

create policy parse_corrections_own_all on public.parse_corrections
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =============================================================
-- B) 子表：通过 courses 反查
-- =============================================================

-- syllabi
alter table public.syllabi enable row level security;

create policy syllabi_via_course_all on public.syllabi
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = syllabi.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = syllabi.course_id and c.user_id = auth.uid()
    )
  );

-- grade_components
alter table public.grade_components enable row level security;

create policy grade_components_via_course_all on public.grade_components
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = grade_components.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = grade_components.course_id and c.user_id = auth.uid()
    )
  );

-- course_outline_items
alter table public.course_outline_items enable row level security;

create policy course_outline_items_via_course_all on public.course_outline_items
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_outline_items.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_outline_items.course_id and c.user_id = auth.uid()
    )
  );

-- exam_dates
alter table public.exam_dates enable row level security;

create policy exam_dates_via_course_all on public.exam_dates
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = exam_dates.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = exam_dates.course_id and c.user_id = auth.uid()
    )
  );

-- office_hours
alter table public.office_hours enable row level security;

create policy office_hours_via_course_all on public.office_hours
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = office_hours.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = office_hours.course_id and c.user_id = auth.uid()
    )
  );

-- submission_policies
alter table public.submission_policies enable row level security;

create policy submission_policies_via_course_all on public.submission_policies
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = submission_policies.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = submission_policies.course_id and c.user_id = auth.uid()
    )
  );

-- tasks
alter table public.tasks enable row level security;

create policy tasks_via_course_all on public.tasks
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = tasks.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = tasks.course_id and c.user_id = auth.uid()
    )
  );

-- =============================================================
-- C) llm_runs：user_id 可为 NULL（系统级调用）
-- =============================================================

alter table public.llm_runs enable row level security;

-- 仅当 user_id 非空且匹配当前 session 时才可见/可写
-- user_id IS NULL 的行（系统日志）只能由 service role 访问
create policy llm_runs_own_non_null on public.llm_runs
  for all
  using (user_id is not null and auth.uid() = user_id)
  with check (user_id is not null and auth.uid() = user_id);

-- =============================================================
-- handle_new_user 触发器
-- 注册时自动在 public.profiles 插一行
-- =============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'display_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 替换可能已存在的旧触发器（idempotent）
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 授权：authenticated 角色可调用 handle_new_user（虽然 SECURITY DEFINER
-- 实际不需要，但显式 grant 让依赖图清晰）
grant execute on function public.handle_new_user() to authenticated;