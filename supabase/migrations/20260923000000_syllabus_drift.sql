-- =============================================================
-- P0-3-20 · 大纲漂移检测：courses 加「差量锚点」两列
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    本迁移**不进自动执行链**（项目约定：迁移一律手跑；先 SQL 后部署，
--    否则代码会带着对不存在列的查询上线 → 42703 全挂）。
--    执行顺序：① 跑本 SQL → ② 推代码 → ③ Vercel 部署。
--
-- 为什么需要这两列（2026-09-18 Steven 拍板「courses 加两列」）：
--   3-20 的同步侧只做**零下载**的差量检测 —— 用 3-19 已索引的 `course_files`
--   找出这门课的 syllabus 文件，再比对它的 `modified_at` 有没有变。
--   "上次核对到哪一版"必须落库，否则每轮同步都会重复投递同一份差异提案。
--
--   为什么不做成新表：这两个值就是**每门课一个**的锚点（与 `files_scanned_at`
--   同形），做成表要额外维护 RLS + 唯一键 + 级联，收益只是"能留历史"，
--   而"这个文件核对过几次"目前没有任何消费方。
--
--   为什么叫 `syllabus_seen_modified_at`（而不是 `..._checked_at`）：
--   🔴 它存的是**那个文件在 Canvas 上的 `modified_at`**，不是"我们什么时候核对的"。
--   叫 `checked_at` 会让人以为是个时间戳日志，于是有人拿它做"上次核对于 X"的文案
--   —— 那会印出一个 2026 年的时间，而实际可能是几个月前的文件版本。
--
-- 为什么不需要改任何 CHECK 约束：
--   漂移写入的行用 `source = 'syllabus'`。🔴 判据是**这个事实从哪来**（来自一份
--   syllabus 文档），不是**它托在哪**（那份文件恰好放在 Canvas 上）—— 写成
--   'canvas' 会把两件不同的事混成一件事：`source='canvas'` 在本项目里意为
--   「Canvas 同步写进来的事实」，而 `lib/parse/persist.ts` 的重解析**只清
--   `source='syllabus'` 的行**，写成 'canvas' 会让漂移写入的旧考试被重解析漏掉。
--   （`lib/messages/appliers/syllabus-drift.ts` 文件头「红线二」是同一结论。）
--   `exam_dates.source` 从建表起就放行 ('syllabus','canvas','manual')，
--   `grade_components.source` 也已于 20260918000000 补平到同一组取值。
--   同时 `messages.type` 的 CHECK 从 20260917200000 起就含 'syllabus_drift'。
--   即：本卡**只加两列**，不动任何枚举。
--
-- 🔴 与 ADR-026 的关系：本迁移不触碰"下载内容"那条线。同步侧一个字节都不下载；
--   真去下载那一个文件的是**用户触发的按需路径**（打开消息栏后的懒补 diff），
--   原文不落库、不落盘、不进日志，只把差异结果写进消息的 payload。
--
-- 验收（执行后逐条打真接口，**不信面板的 Success**）：
--   select column_name, data_type from information_schema.columns
--   where table_name = 'courses' and column_name in ('syllabus_file_id','syllabus_seen_modified_at');
--     -- 期望 2 行；查不到报 42703 = 没跑
--   -- 外键真的要存在（不能只看列在不在）：
--   select tc.constraint_type, kcu.column_name, ccu.table_name as ref_table
--   from information_schema.table_constraints tc
--   join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
--   join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
--   where tc.table_name = 'courses' and kcu.column_name = 'syllabus_file_id';
--     -- 期望 1 行 FOREIGN KEY → course_files
-- =============================================================

-- 我们认定的「这门课的 syllabus」是哪一行 `course_files`。
-- 为什么要落库而不是每次现算：① 判据要能复现（换文件时才知道"换过"，不是"没变"）；
-- ② 用户看到的提案必须能指回具体哪个文件，而列表里可能有多个名字含 syllabus 的条目。
-- `on delete set null`：course_files 是软删除（老师删了标 is_deleted），物理删极少见；
-- 真删了就退化成"还没核对过"，下一轮自然重建锚点 —— 不会留下悬空外键。
alter table public.courses
  add column if not exists syllabus_file_id uuid references public.course_files (id) on delete set null;

-- 已核对过的那一版：`course_files.modified_at` 的值（**不是**"什么时候核对的"）。
-- null 的两种语义要分清：① 从没核对过（首次同步会写基线，不提案）；
-- ② 换过文件（`syllabus_file_id` 变了）时一并清空，让新文件重新走一次基线判定。
alter table public.courses
  add column if not exists syllabus_seen_modified_at timestamptz;

comment on column public.courses.syllabus_file_id is
  'P0-3-20 大纲漂移检测：我们认定的这门课 syllabus 对应的 course_files.id。null = 还没定位到（无 Files 区 / 文件被删）。';

comment on column public.courses.syllabus_seen_modified_at is
  'P0-3-20：已核对过的那一版文件的 course_files.modified_at（文件版本，不是核对时间）。null = 还没核对过（首次写基线、不提案）。';
