-- =============================================================
-- Supabase Storage：syllabus 文件桶 + storage.objects RLS
-- 迁移：20260902220000_storage_syllabi
--
-- 依据（SSOT）：
--   - Database.md 7.3「Supabase Storage（syllabus 文件）」
--   - ADR-009：syllabus 上传走浏览器直传，不走服务端转发
--   - Security-Privacy.md：私有桶，文件可能含教师姓名 / office hour 地址 / 评分细则
--
-- 执行方式：Supabase Dashboard → SQL Editor → 整段粘贴执行（Dashboard 默认以
--          postgres 角色执行，有权限写 storage schema）。
-- 幂等性：桶用 on conflict do update，策略先 drop if exists 再 create，可重复执行。
-- =============================================================

-- -------------------------------------------------------------
-- 1. 建私有桶 syllabi
-- -------------------------------------------------------------
-- public = false：不生成永久可访问 URL，必须走签名 URL（见 Database.md 7.3）。
-- file_size_limit = 20971520（20MB），与 API-Contract.md §3 的大小上限一致。
-- allowed_mime_types = null：故意不设。docx / pptx 在真实浏览器里常报
--   application/octet-stream 或空值，桶层面做 MIME 白名单会把合法文件误拒。
--   类型校验改由服务端按扩展名做（lib/syllabi.ts），桶只卡大小。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('syllabi', 'syllabi', false, 20971520, null)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -------------------------------------------------------------
-- 2. storage.objects 的 RLS（4 条，按桶 + 路径首段判定）
-- -------------------------------------------------------------
-- 判定式：(storage.foldername(name))[1] = auth.uid()::text
--   对象路径约定为 {user_id}/{course_id}/{syllabus_id}.{ext}，
--   首段恒为上传者 uid，且该路径由服务端在签发上传票据时生成，前端不可伪造。
--
-- 四条都带 bucket_id = 'syllabi' 限定，避免误伤其他桶。
-- 只授予 authenticated：未登录不允许碰文件。

alter table storage.objects enable row level security;

-- SELECT（下载前服务端要签 URL；签名本身也要求有读权限）
drop policy if exists syllabi_objects_select_own on storage.objects;
create policy syllabi_objects_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'syllabi'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- INSERT（浏览器直传走的就是这条；签名上传 URL 同样受 RLS 约束）
drop policy if exists syllabi_objects_insert_own on storage.objects;
create policy syllabi_objects_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'syllabi'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE（覆盖重传；using 与 with check 都写，防止把文件挪到别人目录下）
drop policy if exists syllabi_objects_update_own on storage.objects;
create policy syllabi_objects_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'syllabi'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'syllabi'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- DELETE（P0-3-2 一键删账号时按 user_id 前缀整段清理）
drop policy if exists syllabi_objects_delete_own on storage.objects;
create policy syllabi_objects_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'syllabi'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- =============================================================
-- 验收（执行后跑一遍，确认建对了）
-- =============================================================
-- 1) 桶已建且为私有、上限 20MB：
--    select id, public, file_size_limit, allowed_mime_types
--    from storage.buckets where id = 'syllabi';
--    期望：syllabi | false | 20971520 | null
--
-- 2) 四条策略都在：
--    select policyname, cmd from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname like 'syllabi_objects_%'
--    order by policyname;
--    期望：4 行（select / insert / update / delete）
--
-- 3) 越权隔离（P0-1-1 冒烟时做）：用 B 账号拿 A 账号的 file_url 去签下载 URL，
--    应失败或拿到空 —— RLS 挡在签名之前。
-- =============================================================
