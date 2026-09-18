-- =============================================================
-- P0-3-23 · practice test 生成（类型 A 忠实自测卷）
--
-- 🔴【Steven 手动】执行方式：Supabase Dashboard → 左侧 SQL Editor → 粘贴执行。
--    顺序：① 跑本 SQL → ② Bud 推代码 → ③ Vercel 部署 → ④ 课程页资料区某份试卷点「自测卷」。
--    漏跑的表现：自测卷页**会明确报"生成失败：读取自测卷缓存失败（关系不存在）"**
--    （读取侧 fail loud，与 3-19 / 3-19b 同一取舍），且每次打开都白打一次模型请求。
--
-- 本迁移新建两张表：
--   ① `practice_tests`              —— 一份 past exam（+ 它的 answer key）→ 一张自测卷的缓存
--   ② `practice_test_explanations`  —— 逐题「讲解这道题的解法」的缓存
--
-- ---------------------------------------------------------------------------
-- 🔴 这是 ADR-027（按需读取的第二条开口），不是 3-19 红线的推翻
-- ---------------------------------------------------------------------------
-- 3-19 的红线是「**索引/同步路径**一个字节都不下载」，**那条依然成立**：
-- 同步只建目录（文件名 + 文件夹 + 外链），271 个文件仍然零下载。
--
-- ADR-026 开了第一条按需开口（用户点「一键总结」→ 读**那一个**文件）；
-- 本卡是第二条，形态相同但读的是**两份**（试卷 + 答案 key，都是用户自己选的）：
--   ① 触发者是用户（不是后台替他扫）；
--   ② 只碰他点的那两份，**原文与抽取全文绝不落库、不落盘、不进日志**；
--   ③ 落库的是**结构化产物**（题干 / 答案 / 讲解），不是文件的任何一段字节。
--
-- 为什么结构化产物可以落库（ADR-026 定的那条线，这里沿用）：
--   · 它不是"文件的副本"，而是"模型对这份卷子说了什么"——与 `file_summaries` 同性质；
--   · 不落库的代价是**每次打开都重下两份 PDF + 重打一次模型**（实测单文件 3-15 秒），
--     而自测卷是要被反复打开来做的（做题 → 看答案 → 逐题看讲解）。
--
-- 与 ADR-013（不逆向第三方平台）不冲突：文件是 Canvas 通过官方 API 主动提供的，
-- 用的是用户自己的凭据与自己的选课权限。
--
-- ---------------------------------------------------------------------------
-- 🔴 为什么是「缓存 + 差量」而不是「每次现算」
-- ---------------------------------------------------------------------------
-- 与 `file_summaries` / `message_summaries` 同一条纪律：
--   ① 一次生成、多次复用（同一张卷子被打开五次只该花一次钱）；
--   ② **失败也落一行**（`status = 'failed'`），那行的意义是"别再重试"——
--      否则每次打开都为同一份读不出来的 PDF 重打一次模型（账单与延迟一直涨、用户看不出异常）。
--      要重试就删掉那一行：`delete from practice_tests where status = 'failed'`。
--   ③ 差量判据是**两个** `modified_at`（试卷 + 答案 key 各一个）：
--      老师换掉答案 key（题不变、答案变了）时旧自测卷就是**过期的谎话**——
--      而"答案错了"在这个功能里比"没有答案"严重得多。任一不同即重算。
--
-- ---------------------------------------------------------------------------
-- 为什么 key 是 `exam_file_id` 而不是 (exam, key) 二元组
-- ---------------------------------------------------------------------------
-- 用户的动作是「给**这份试卷**出一张自测卷」，答案 key 是**自动配对**出来的、且可以在
-- 页面上换（换完是同一条记录被重算，不是并存两条）。所以唯一键落在试卷上：
-- 一份试卷永远只有一张当前有效的自测卷 —— 关闭了"同一份试卷两条自测卷"这种无法解释的状态。
-- 配到哪一份 key 记在 `answer_key_file_id` / `pairing_rule` 里，**看得见也说得清**。
--
-- ⚠️ `answer_key_file_id` 可空，且 `on delete set null`：答案 key 在 Canvas 上被删掉时，
--    自测卷**不该跟着消失**（题本身还在），只是从此每一题都没有答案（如实标注）。
--
-- ---------------------------------------------------------------------------
-- 验收（执行后跑，应看到两张表 + RLS 均已开）：
--   select column_name, data_type from information_schema.columns
--   where table_name = 'practice_tests' order by ordinal_position;
--   select column_name, data_type from information_schema.columns
--   where table_name = 'practice_test_explanations' order by ordinal_position;
--   select relrowsecurity from pg_class
--   where relname in ('practice_tests', 'practice_test_explanations');  -- 期望两行都是 t
-- ⚠️ 面板的 `Success` **不构成证据**（一次 Run 里前面的语句可能已提交、后面的没跑）。
--    真正的确认走 `npm run probe:schema`（零写入枚举探针）与只读真接口探针。
-- =============================================================

-- -------------------------------------------------------------
-- ① practice_tests
-- -------------------------------------------------------------

create table if not exists public.practice_tests (
  id uuid primary key default gen_random_uuid(),
  -- 归属**不直接落在本表**：一张自测卷属于哪门课，课属于谁 ——
  -- 与 course_files / file_summaries 同一模式（一处归属、一处 RLS 判据）。
  course_id uuid not null references public.courses (id) on delete cascade,
  -- 试卷本体（用户选的那一份）。唯一键就在它上面（见文件头）。
  exam_file_id uuid not null references public.course_files (id) on delete cascade,
  -- 配到的答案 key（可能没有 → null，或之后被删 → set null）。
  answer_key_file_id uuid references public.course_files (id) on delete set null,
  -- 配对是靠哪条规则命中的（`lib/practice-test/pairing.ts` 的 PairingRule）。
  -- 记下来是为了**能解释"为什么配到这一份"**——配错时不必猜是代码的错还是数据的错。
  pairing_rule text,
  -- 卷面标题（模型起的，如「Practice Midterm 1 (F23)」；模型没给就用文件名）。
  title text not null default '',
  -- `ok` = 切题跑通（可以一题都没有答案 = 没配到 key，那不是失败）；
  -- `failed` = 下载/抽取/调用/校验失败，**落这一行的意义是"别再重试"**。
  status text not null default 'ok' check (status in ('ok', 'failed')),
  -- 卷面：`{ title, questions: [{ key, number, text, answer }] }`。
  -- ⚠️ 里面**只有题干与答案**，**绝不含 PDF 原文的任何一段字节**（见文件头）。
  paper jsonb not null default '{}'::jsonb,
  -- 抽取到多少字符（试卷 / 答案各一个）与是否因过长被截断。
  -- 🔴 截断过就必须在界面上如实说明 —— 覆盖不全却假装全，就是"计数撒谎"
  --    （`file_summaries.source_truncated` 同一条纪律）。
  exam_source_chars integer not null default 0,
  key_source_chars integer not null default 0,
  source_truncated boolean not null default false,
  -- PDF 页数（docx 为 null）与所用抽取器（`pdf_text` / `docx`）。
  exam_page_count integer,
  key_page_count integer,
  extract_method text,
  -- **生成时**两份文件在 Canvas 上的 `modified_at`。读取侧比对它们决定要不要重算。
  exam_modified_at timestamptz,
  key_modified_at timestamptz,
  -- 写进 llm_runs 的同一组值（实际服务的模型名，不是请求时填的别名）。
  model text,
  -- 失败原因（精简、**不含试卷内容**，同 llm_runs.error_message 的纪律）。
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一份试卷只有一张当前有效的自测卷（并发点开 / 流式渲染重入时靠它收敛）。
  unique (exam_file_id)
);

comment on table public.practice_tests is
  'P0-3-23 自测卷缓存（按需生成，非同步路径）。key = exam_file_id：一份 past exam 一张卷。只落结构化产物（题干/答案），绝不落 PDF 原文。status=failed 的行同样保留，作用是"不再重试"。';
comment on column public.practice_tests.answer_key_file_id is
  '自动配对到的答案文件（可空）。on delete set null：答案被删时卷子不消失，只是每题都没有答案（界面如实标注）。';
comment on column public.practice_tests.pairing_rule is
  '配对命中哪条规则（answer-key-folder / solution-folder / same-folder-key-name / same-stem-anywhere）。配错时靠它区分"代码错"与"数据长得怪"。';
comment on column public.practice_tests.paper is
  '卷面 { title, questions: [{ key, number, text, answer }] }。answer=null 表示答案文件里没找到这一题 —— **绝不用模型推断的答案填进去**。';
comment on column public.practice_tests.exam_modified_at is
  '生成时试卷在 Canvas 上的 modified_at。与 key_modified_at 一起做差量：任一变化即重算（老师换掉答案 key 时，旧卷子的答案就是错的）。';
comment on column public.practice_tests.error_message is
  '失败原因（已精简，不含试卷内容）。同 llm_runs 的纪律：日志与错误里不出现用户内容。';

-- 读取路径永远是「按 exam_file_id 取一行」→ unique 已覆盖，无需再建索引。
-- 按课程统计「这门课出了几张卷」时再加（现在没有这个界面）。

drop trigger if exists trg_practice_tests_updated_at on public.practice_tests;
create trigger trg_practice_tests_updated_at
  before update on public.practice_tests
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- ② practice_test_explanations
-- -------------------------------------------------------------

-- 为什么单独一张表而不是塞进 `practice_tests.paper` 的 jsonb：
-- 讲解是**逐题、懒生成**的（用户点哪一题才算哪一题），一次读-改-写整份 paper
-- 会把"并发点两道题"变成互相覆盖。拆表之后每一题一行、各写各的，
-- 与 `message_summaries` / `file_summaries` 的形态一致（缓存表 + 状态列）。

create table if not exists public.practice_test_explanations (
  practice_test_id uuid not null references public.practice_tests (id) on delete cascade,
  -- 题目键（`q1` / `q2` …，由 `questionKey()` 按**切题顺序**生成）。
  -- ⚠️ 它跟着顺序走：重新生成卷子（文件变了）后键会重排 —— 旧讲解因此不会被错配到新题上，
  --    代价是重算一次讲解。这是刻意的取舍：**错配的讲解比没有讲解坏得多**。
  question_key text not null,
  -- 讲解语言（`zh-CN` / `en`，白名单在 `lib/practice-test/prompt.ts`）。
  -- 与 file_summaries 同一理由：不加 CHECK（locale 只是数据标签，加一种语言不该被迁移卡住）。
  locale text not null,
  -- `ok` = 讲解跑通；`failed` = 模型给不出符合 schema 的结果 → **别再重试**。
  status text not null default 'ok' check (status in ('ok', 'failed')),
  -- 讲解载荷：`{ steps: string[], concepts: string[] }`。
  explanation jsonb not null default '{}'::jsonb,
  model text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (practice_test_id, question_key, locale)
);

comment on table public.practice_test_explanations is
  'P0-3-23 逐题讲解缓存（懒生成：用户点哪一题算哪一题）。PK (practice_test_id, question_key, locale)。status=failed 的行保留，作用是"不再重试"。';
comment on column public.practice_test_explanations.question_key is
  '题目键（q1/q2…按切题顺序）。重新生成卷子后键会重排 → 旧讲解不会被错配到新题上（错配的讲解比没有讲解坏得多）。';
comment on column public.practice_test_explanations.explanation is
  '讲解载荷 { steps, concepts }。**由题目与答案推导**，不允许编造新题或假答案（本卡的红线）。';

drop trigger if exists trg_practice_test_explanations_updated_at on public.practice_test_explanations;
create trigger trg_practice_test_explanations_updated_at
  before update on public.practice_test_explanations
  for each row execute function public.set_updated_at();

-- ---------- RLS（与 file_summaries / course_files 同一写法） ----------

alter table public.practice_tests enable row level security;

-- 一条 `for all` 覆盖 select/insert/update/delete：归属判据只有一处
-- （通过 course_id → courses.user_id 反查），少一条策略就会让整张表谁都写不进
-- （自测卷静默生成不了）。
drop policy if exists practice_tests_via_course_all on public.practice_tests;
create policy practice_tests_via_course_all on public.practice_tests
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = practice_tests.course_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = practice_tests.course_id and c.user_id = auth.uid()
    )
  );

alter table public.practice_test_explanations enable row level security;

-- 归属经 practice_tests 再经 courses 反查（两跳）。
-- ⚠️ 不查 course_files：卷子所属的课才是判据，而课在 practice_tests 上已经有列了 ——
--    多绕一跳只多一个出错的地方（且答案文件可能已被删成 null，那条路会断）。
drop policy if exists practice_test_explanations_via_test_all on public.practice_test_explanations;
create policy practice_test_explanations_via_test_all on public.practice_test_explanations
  for all
  using (
    exists (
      select 1 from public.practice_tests t
      join public.courses c on c.id = t.course_id
      where t.id = practice_test_explanations.practice_test_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.practice_tests t
      join public.courses c on c.id = t.course_id
      where t.id = practice_test_explanations.practice_test_id and c.user_id = auth.uid()
    )
  );
