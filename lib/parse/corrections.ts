import type { getCurrentUser } from '@/lib/api/response'

/**
 * 五板块保存的 diff 与 `parse_corrections` 落库（P0-1-5b）。
 *
 * **为什么 diff 集中在这一个文件**：五个保存端点共用同一套「按 id 匹配 →
 * 逐字段比对 → 写修正记录」的逻辑，散在 5 个路由里迟早长出 5 种口径。
 * 各板块的差异只有两样：字段列表（`FieldSpec`）和 `entity_type`。
 *
 * ### 修正记录的粒度（设计决定，2026-09-03）
 *
 * `parse_corrections` 一行对应**一处字段差异**（`Database.md` 3.13 的原话：
 * "把变更前后的值对比后写入本表，一条记录对应一个被修改的字段"）：
 * - **edit**：匹配上的行，每个取值不同的字段一条（original → corrected）；
 * - **delete**：库里多出的行被删除，按该行**原有值的每个字段**各一条
 *   （original = 原值，corrected = null；本来就是 null 的字段跳过 —— 空对空没有信息量）；
 * - **add**：不带 id 的新增行，按**新值的每个字段**各一条（original = null，
 *   corrected = 新值；null 字段同样跳过）。
 *
 * 三类统一成"字段级"的好处：按 field_name 聚合统计"哪个字段最常被改"时
 * 三种行为可加在一起，不用写三种查询。
 *
 * ### `order_index` 的例外
 *
 * 大纲条目的顺序变化**不写修正**：重排序不是"解析错了"，混进统计只会稀释
 * "字段准确率"这个我们真正关心的信号。顺序本身仍会按数组位置写回库里。
 *
 * ### 归因（`syllabus_id` / `llm_run_id`）
 *
 * 同一份 correction 行的归因字段取「该课程最新一份 syllabus 的最近一次
 * **成功**解析」。课程从没传过 syllabus（全是手动数据）就都是 null ——
 * 两列在表上都是 nullable，`Database.md` 3.13 允许。
 */

type SupabaseClient = Awaited<ReturnType<typeof getCurrentUser>>['supabase']

/** 与 `parse_corrections.entity_type` 的 CHECK 约束一致。 */
export type SectionEntityType =
  | 'grade_component'
  | 'outline_item'
  | 'exam_date'
  | 'office_hour'
  | 'submission_policy'

export type CorrectionType = 'edit' | 'delete' | 'add'

/** 一条待写入的 `parse_corrections`（归因字段由 `writeCorrections()` 统一补）。 */
export type PendingCorrection = {
  entityId: string
  fieldName: string
  originalValue: string | null
  correctedValue: string | null
  correctionType: CorrectionType
}

/**
 * 一个板块里参与 diff 的字段。`column` 是 DB 列名（直接进 `field_name`，
 * `Database.md` 3.13 的示例就是列名）；`get` 取库里的旧值，`pick` 取表单的新值。
 */
export type FieldSpec<TStored, TInput> = {
  column: string
  get: (stored: TStored) => unknown
  pick: (input: TInput) => unknown
}

/**
 * 比较两个取值是否"用户视角相同"。
 *
 * - null 与 undefined 视为同一个东西（"没填"）；
 * - 字符串按 trim 后比较（库里是模型原样输出，前后空白不该算差异；
 *   写回值本身在校验层已经 trim 过了）；
 * - 数字按数值比较（Postgres `numeric` 在个别驱动下会以字符串回来）。
 */
function sameValue(a: unknown, b: unknown): boolean {
  const left = a === undefined ? null : a
  const right = b === undefined ? null : b
  if (left === null && right === null) return true
  if (typeof left === 'number' || typeof right === 'number') {
    return Number(left) === Number(right)
  }
  return String(left).trim() === String(right).trim()
}

/** 值 → `parse_corrections` 的 text。值一律存 text（开工提示：不做类型化）。 */
function toText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  return String(value).trim()
}

/**
 * 按 id 把「库里现有行」与「表单提交的行」对齐，产出 edit / delete 两类修正
 * （add 类需要等插入拿到新行 id，见 `buildAddCorrections()`）。
 *
 * @returns `unmatchedInputIds`：提交里带了 id 但库里（本课程、RLS 可见范围内）
 * 没有的行 —— 大概率是前端数据过期，调用方应整单 400 拒绝，而不是静默当新增。
 */
export function diffRows<TStored extends { id: string }, TInput extends { id?: string }>(
  existing: TStored[],
  incoming: TInput[],
  fields: Array<FieldSpec<TStored, TInput>>,
): { corrections: PendingCorrection[]; unmatchedInputIds: string[]; deletedIds: string[] } {
  const byId = new Map(existing.map((row) => [row.id, row]))
  const referenced = new Set<string>()
  const corrections: PendingCorrection[] = []
  const unmatchedInputIds: string[] = []

  for (const input of incoming) {
    if (input.id === undefined) continue
    const stored = byId.get(input.id)
    if (!stored) {
      unmatchedInputIds.push(input.id)
      continue
    }
    referenced.add(input.id)
    for (const field of fields) {
      const before = field.get(stored)
      const after = field.pick(input)
      if (!sameValue(before, after)) {
        corrections.push({
          entityId: stored.id,
          fieldName: field.column,
          originalValue: toText(before),
          correctedValue: toText(after),
          correctionType: 'edit',
        })
      }
    }
  }

  const deletedIds: string[] = []
  for (const stored of existing) {
    if (referenced.has(stored.id)) continue
    deletedIds.push(stored.id)
    for (const field of fields) {
      const before = toText(field.get(stored))
      if (before === null) continue
      corrections.push({
        entityId: stored.id,
        fieldName: field.column,
        originalValue: before,
        correctedValue: null,
        correctionType: 'delete',
      })
    }
  }

  return { corrections, unmatchedInputIds, deletedIds }
}

/** 新增行 → add 类修正（插入返回 id 之后才能建，所以单独一步）。 */
export function buildAddCorrections<TStored, TInput>(
  insertedId: string,
  input: TInput,
  fields: Array<FieldSpec<TStored, TInput>>,
): PendingCorrection[] {
  const corrections: PendingCorrection[] = []
  for (const field of fields) {
    const after = toText(field.pick(input))
    if (after === null) continue
    corrections.push({
      entityId: insertedId,
      fieldName: field.column,
      originalValue: null,
      correctedValue: after,
      correctionType: 'add',
    })
  }
  return corrections
}

/**
 * 把修正写入 `parse_corrections`，并统一补归因。
 *
 * 空数组直接返回，连归因查询都不发 —— "保存但什么都没改"是正常路径
 * （幂等保存），不该在日志表里留下任何噪音。
 */
export async function writeCorrections({
  supabase,
  userId,
  courseId,
  entityType,
  corrections,
}: {
  supabase: SupabaseClient
  userId: string
  courseId: string
  entityType: SectionEntityType
  corrections: PendingCorrection[]
}): Promise<void> {
  if (corrections.length === 0) return

  const { syllabusId, llmRunId } = await resolveAttribution(supabase, courseId)

  const rows = corrections.map((correction) => ({
    user_id: userId,
    syllabus_id: syllabusId,
    llm_run_id: llmRunId,
    entity_type: entityType,
    entity_id: correction.entityId,
    field_name: correction.fieldName,
    original_value: correction.originalValue,
    corrected_value: correction.correctedValue,
    correction_type: correction.correctionType,
  }))

  const { error } = await supabase.from('parse_corrections').insert(rows)
  if (error) {
    throw error
  }
}

/**
 * 归因到「最近一次解析」。
 *
 * 一份课程可能先后传过多份 syllabus；板块数据跟着最新那份走
 * （`persist.ts` 只删 `source='syllabus'` 再插），所以取最新的 syllabus。
 * 只认 `status = 'success'` 的 run：失败的解析没产生过任何可被修正的值。
 * 查不到（课程没传过 syllabus / 没有成功记录）就都是 null，不阻断保存。
 */
async function resolveAttribution(
  supabase: SupabaseClient,
  courseId: string,
): Promise<{ syllabusId: string | null; llmRunId: string | null }> {
  const { data: syllabus } = await supabase
    .from('syllabi')
    .select('id')
    .eq('course_id', courseId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!syllabus) {
    return { syllabusId: null, llmRunId: null }
  }
  const syllabusId = (syllabus as { id: string }).id

  const { data: run } = await supabase
    .from('llm_runs')
    .select('id')
    .eq('syllabus_id', syllabusId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return { syllabusId, llmRunId: run ? (run as { id: string }).id : null }
}
