-- =============================================================
-- P0-3-30 · syllabus 第二个来源：`syllabi` 记住「是从哪个 Canvas 文件导的」
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    本迁移**不进自动执行链**（项目约定：迁移一律手跑；先 SQL 后部署，
--    否则代码会带着对不存在列的查询上线 → 42703 全挂）。
--    执行顺序：① 跑本 SQL → ② 推代码 → ③ Vercel 部署。
--
-- 为什么需要这一列（而不是"看这门课有没有 syllabi 行"来判断幂等）：
--   一键导入必须能回答「这份文件是不是已经导过」—— 第二次点同一个文件要
--   **一个外部请求都不发**（不下载、不调模型）。
--   用「这门课有没有 syllabi 行」判断会误伤：用户可能先**手动上传**过一份，
--   那一行的来源是本地文件，与 Canvas 上的这份无关；而 `canvas_file_id is null`
--   不参与下面的 unique 约束，两种来源可以并存，互不顶掉。
--
-- 为什么是可空 + `on delete set null`：
--   ① 手动上传的行天然没有这一列的值（历史行全部为 null，不改数据）；
--   ② `course_files` 的行被同步软删 / 物理删时，**syllabi 行要留着**
--      —— 那份解析结果（五板块）已经在库里、且可能被用户改过，
--      级联删掉等于一次不可逆的数据丢失。置 null 只是丢掉"从哪来"的标记。
--
-- 为什么 unique 用 `(course_id, canvas_file_id)` 两列而不是只 `canvas_file_id`：
--   一个 Canvas 文件在极端情况下可能属于多门课（跨课共享的公共 syllabus），
--   单列 unique 会让第二门课导不进去。两列才表达"这门课导过这份文件"。
--   ⚠️ Postgres 的 unique 对 NULL 不去重（NULL 互不相等），
--   所以手动上传的多行不受这条约束影响 —— 这正是上面那个场景要的行为。
--
-- 验收（执行后逐条查，**不信面板的 Success**）：
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'syllabi' and column_name = 'canvas_file_id';
--   -- 期望：uuid / YES，且**有值**（没跑的话这里 0 行，代码会报
--   -- 「数据库还缺 syllabi.canvas_file_id 列」并拒绝导入，不会静默写坏数据）
--
--   select indexdef from pg_indexes where tablename = 'syllabi';
--   -- 期望见到 unique (course_id, canvas_file_id)
-- =============================================================

alter table public.syllabi
  add column if not exists canvas_file_id uuid
  references public.course_files (id) on delete set null;

-- 幂等的唯一键：同一门课 + 同一个 Canvas 文件 → 只允许一行。
-- （Postgres 的 UNIQUE 对 NULL 不去重 → 手动上传的行不受影响。）
create unique index if not exists syllabi_course_canvas_file_key
  on public.syllabi (course_id, canvas_file_id)
  where canvas_file_id is not null;

comment on column public.syllabi.canvas_file_id is
  'P0-3-30：这一行是从哪个 Canvas 文件导入的（手动上传的行为 null）。'
  '🔴 与 file_url 不同：file_url 存的是**站内路径** /courses/{cid}/files/{fid}，'
  '绝不写 Canvas 单文件端点返回的 url（那是 capability URL，ADR-026 第 3 条）。';
