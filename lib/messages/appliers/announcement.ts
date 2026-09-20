import { applyCourseUpdate, summarizeApply } from '@/lib/course-update/apply'
import {
  readComponentProposals,
  readExamProposals,
} from '@/lib/messages/exam-proposals/ensure'
import { validateExamInput, validateGradeComponentInput } from '@/lib/course-update/normalize'
import { parseCourseUpdate } from '@/lib/course-update/parse'
import type { ParsedExam, ParsedGradeComponent } from '@/lib/course-update/normalize'
import type { ApplyContext, ApplyOutcome, MessageApplier } from '@/lib/messages/apply'

/**
 * 公告的写入器（P0-3-25，Sync-Strategy §14「落点规则」）。
 *
 * ### 两类公告，两种行为（这是本卡的核心）
 * - **有落点**（`payload.landing === true`，文本里有考试 / 成绩构成）：
 *   在**确认这一刻**解析公告正文，把考试 / 成绩构成写进课程页。
 * - **无落点**（如「本周课取消」「office hours 改到周三」）：
 *   刻意空写入，只留一行回执 —— **一个字段都不写**。
 *   Steven 2026-09-17 拍板去掉 office hours 结构化落点，避免造一个没人维护的 OH 模型。
 *   ⚠️ 这类公告在**同步侧**已被合并成一条摘要（C 口径，2026-09-18 拍板，见
 *   `lib/sync/announcements.ts`），所以这里多半一次面对几十条 —— 回执会报出条数。
 *
 * ### 🔴 解析放在「确认」而不是「同步」
 * 同步一轮要给几十条公告判落点，每条打一次模型既慢又贵，而且**同步不该依赖模型可用性**
 * （模型挂了会连累作业同步，那是本末倒置）。所以同步只做关键词粗筛
 * （`lib/course-update/landing.ts`），真正的解析在用户点确认时做 ——
 * 与 3-24「解析不落库、确认才写」完全同形（ADR-015）。
 *
 * ### 🔴 P0-3-29：改期类公告**提前到打开消息栏时**解析，确认时**复用**
 * 「Midterm 1 改期到 9/27」这种最常见的公告，用户点的是一个"会把哪一条改成什么"的按钮 ——
 * 点之前必须看到 `9/28 → 9/27`。所以消息栏打开时会调一次
 * `POST /api/v1/messages/exam-proposals`，把提案（含 `before → after` 与"落到哪一行"）
 * 算好写进 `payload.examProposals`。
 *
 * 本 applier 因此有**两条路**：
 * - `examProposalsStatus` 是 `ready` / `clean` → **照提案写**（不回查正文、不再解析）。
 *   "所见即所写"：重新解析一次可能给出不同结论，那回执就和界面上那句对不上了；
 * - 其余（没算过 / 算失败 / 老数据）→ 退回上面的老路（确认这一刻解析）。
 *   这样懒补那趟链路挂了也**不会让用户没法处理这条公告**。
 *
 * ### 🔴 与对话框写入器共用 `applyCourseUpdate`（不是重写一遍）
 * 那条通道的纪律（只追加、复用 `syncExamToTask` 派生链、按 source 分组合计校验）
 * 一条都不能少。这里只是"文本从哪来"不同。
 *
 * ### 部分校验失败怎么办（与对话框**刻意不同**）
 * `validateApplyBody` 是"单条非法 = 整批拒绝"，因为用户正在看着预览、可以改。
 * 公告这条路用户**没在编辑**：整批拒绝等于让他对着一句"第 3 条考试缺少原文摘录"
 * 干瞪眼。所以这里跳过不合格的、写下合格的，并**在回执里逐条说清跳过了什么**
 * （明确说出来就不算静默失败）。全都不合格时仍然返回失败 —— 那才是真的没写成。
 */

/** 解析出的考试 / 成绩构成 → 校验。返回合格的条目 + 被跳过的原因。 */
function validateExams(rawExams: unknown[]): { items: ParsedExam[]; skipped: string[] } {
  const items: ParsedExam[] = []
  const skipped: string[] = []
  for (const raw of rawExams) {
    const parsed = validateExamInput(raw)
    if (parsed.ok) items.push(parsed.value)
    else skipped.push(parsed.message)
  }
  return { items, skipped }
}

function validateGradeComponents(rawComponents: unknown[]): {
  items: ParsedGradeComponent[]
  skipped: string[]
} {
  const items: ParsedGradeComponent[] = []
  const skipped: string[] = []
  for (const raw of rawComponents) {
    const parsed = validateGradeComponentInput(raw)
    if (parsed.ok) items.push(parsed.value)
    else skipped.push(parsed.message)
  }
  return { items, skipped }
}

export const announcementApplier: MessageApplier = async (
  ctx: ApplyContext,
): Promise<ApplyOutcome> => {
  const { payload, supabase, userId } = ctx

  // ---------- 1) 无落点 → 刻意空写入 ----------
  //
  // `landing !== true` 而不是 `=== false`：字段缺失（老数据、别的产出方）
  // 一律当"没有落点"处理更安全 —— 不确定能不能写的时候，**不写**。
  //
  // ⚠️ C 口径（2026-09-18）之后这类消息多半是**合并摘要**（一轮几十条通知类公告
  // 合成一条）。回执必须说出条数，否则用户点完"知道了"只看到一句
  // "没有要写入的字段"，会以为自己刚才确认的是一条无关紧要的东西。
  if (payload.landing !== true) {
    const digestCount = Array.isArray(payload.digest) ? payload.digest.length : 0
    if (digestCount === 0) {
      return { ok: true, summary: '知道了（这条是通知类公告，没有要写入的字段）' }
    }
    // `digest` 是**截断后**列出的那批（上限 `MAX_DIGEST_ITEMS`），超出的在 `digestOverflow`。
    // 报总数而不是数组长度 —— 说少了对不上账（列表也是同一个数组算的，会自己打架）。
    const overflow =
      typeof payload.digestOverflow === 'number' && payload.digestOverflow > 0
        ? Math.floor(payload.digestOverflow)
        : 0
    const overflowNote =
      overflow > 0 ? `（摘要里列出前 ${digestCount} 条，另 ${overflow} 条请到 Canvas 查看）` : ''
    return {
      ok: true,
      summary: `知道了（${digestCount + overflow} 条通知类公告${overflowNote}，没有要写入的字段）`,
    }
  }

  const courseId = typeof payload.courseId === 'string' ? payload.courseId : ''
  if (courseId === '') {
    return {
      ok: false,
      code: 'announcement_payload_incomplete',
      message: '这条公告消息缺少课程标识，无法写入，请改用对话框处理',
    }
  }

  // ---------- 2') 提案已算好 → 照它写（P0-3-29） ----------
  //
  // 消息栏里那份结论**就是用户看到的那份**：他看到的「9/28 → 9/27」必须等于真正
  // 写进库的东西。这里再解析一次，两处就可能给出不同答案 —— 那回执里那句
  // "更正 1 条"就成了用户核对不了的东西（CodingRules §10.1 第 21 条的形状）。
  const proposalStatus = payload.examProposalsStatus
  if (proposalStatus === 'ready' || proposalStatus === 'clean') {
    return applyFromProposals({ ctx, courseId })
  }

  const announcementId = typeof payload.announcementId === 'string' ? payload.announcementId : ''
  if (announcementId === '') {
    return {
      ok: false,
      code: 'announcement_payload_incomplete',
      message: '这条公告消息缺少公告标识，无法写入，请改用对话框处理',
    }
  }

  // ---------- 2) 回查公告正文 ----------
  //
  // 正文**不在 payload 里**（可能很长，而消息栏只读摘要），所以每次确认都回查一次。
  // 用会话客户端：`course_announcements` 的 RLS 是「course_id 属于我」，
  // 别人的公告 id 在这里查不到 —— 等同不存在（ADR-010 统一 404 语义）。
  const { data, error } = await supabase
    .from('course_announcements')
    .select('id, course_id, title, body_text')
    .eq('id', announcementId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'announcement_load_failed', message: `读取公告失败：${error.message}` }
  }
  if (!data) {
    return {
      ok: false,
      code: 'announcement_not_found',
      message: '找不到这条公告的记录（可能已被清理），无法写入',
    }
  }

  const row = data as { id: string; course_id: string; title: string | null; body_text: string | null }

  // 归属一致性：payload 说的课与账上的课必须一致。不一致说明数据被改过 ——
  // 这时候**停下来报错**，绝不"以账为准"自作主张地往另一门课写。
  if (row.course_id !== courseId) {
    return {
      ok: false,
      code: 'announcement_course_mismatch',
      message: '这条公告所属课程与消息记录不一致，已停止写入，请到课程页手动确认',
    }
  }

  const body = (row.body_text ?? '').trim()
  if (body === '') {
    return {
      ok: false,
      code: 'announcement_empty_body',
      message: '这条公告没有正文（可能只发了标题或附件），没有可写入的内容',
    }
  }

  // ---------- 3) 确认这一刻才解析 ----------
  const parsed = await parseCourseUpdate({
    userId,
    text: body,
    // 与对话框用**不同**的 purpose：将来查"公告这条路解析得准不准"才分得开。
    purpose: 'announcement_apply',
  })
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, message: parsed.message }
  }

  const exams = validateExams(parsed.data.exams)
  const components = validateGradeComponents(parsed.data.gradeComponents)
  const taskCount = Array.isArray(parsed.data.tasks) ? parsed.data.tasks.length : 0
  /**
   * P0-3-34：这条公告里识别到的分数条数。
   *
   * ⚠️ 公告这条路**永远不写分数**（它写不了）：分数必须落到一条**现有任务**上，
   * 而"记到哪一条"是用户的裁决（对话框里有候选列表让人挑）。
   * 无人确认的公告路径替用户猜目标 = 把分记到错的作业上，比不记更糟。
   * 所以这里只**如实说清有几条没写**，绝不静默丢（R3）。
   */
  const scoreCount = Array.isArray(parsed.data.scores) ? parsed.data.scores.length : 0

  if (exams.items.length === 0 && components.items.length === 0) {
    // 粗筛说"有落点"但实际解析不出可写入的东西 —— 如实报错（不是静默成功）。
    const detail = exams.skipped[0] ?? components.skipped[0] ?? ''
    const extra =
      scoreCount > 0
        ? `（另有 ${scoreCount} 条分数信息 —— 分数要你来指定记到哪一条作业上，请用对话框确认）`
        : ''
    return {
      ok: false,
      code: 'nothing_to_write',
      message: detail
        ? `这条公告里没有可写入的考试或成绩构成（${detail}），请到课程页手动处理${extra}`
        : `这条公告里没有可写入的考试或成绩构成，请到课程页手动处理${extra}`,
    }
  }

  // ---------- 4) 写入（复用对话框那条写入器） ----------
  let result
  try {
    result = await applyCourseUpdate(supabase, {
      courseId,
      exams: exams.items,
      gradeComponents: components.items,
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'not_found') {
      return { ok: false, code: 'not_found', message: '课程不存在或无权访问，已停止写入' }
    }
    console.error('[messages] 公告写入失败:', error)
    return { ok: false, code: 'apply_failed', message: '写入失败，请稍后重试或到课程页手动处理' }
  }

  // ---------- 5) 回执：逐条说清查了什么、跳过了什么 ----------
  const parts = [summarizeApply(result)]
  const skipped = [...exams.skipped, ...components.skipped]
  if (skipped.length > 0) {
    parts.push(`跳过 ${skipped.length} 条无法核对的（${skipped[0]}）`)
  }
  if (taskCount > 0) {
    // 作业类的改动需要匹配已有任务再改期，那是"有人看着"的对话框的活 ——
    // 这里**明确说出来**，不让用户以为全部都写进去了。
    parts.push(`另有 ${taskCount} 条作业类信息未写入，请用对话框确认`)
  }
  if (scoreCount > 0) {
    // 同理，且分数还多一层：连目标都要用户指定（见上面 `scoreCount` 的注释）。
    parts.push(`另有 ${scoreCount} 条分数信息未写入（分数需你指定记到哪一条作业），请用对话框确认`)
  }

  // 透传本次写入的行 id：撤销（P0-3-26）按它精准回滚，绝不整表清空。
  // ⚠️ `examRestores`（被更正的旧值）也要一并透传 —— 撤销时对它们是**写回旧值**，
  // 不是删除。漏掉它们的表现是：改期被撤销后，用户原本那条考试的日期没回来。
  const applied = result.applied
  const hasApplied =
    (applied.examDateIds?.length ?? 0) > 0 ||
    (applied.gradeComponentIds?.length ?? 0) > 0 ||
    (applied.examRestores?.length ?? 0) > 0
  return {
    ok: true,
    summary: parts.join(' · '),
    ...(hasApplied ? { applied } : {}),
  }
}

/**
 * 照**已经算好的提案**写（P0-3-29 的新路径）。
 *
 * ### 三条纪律
 * 1. **只写 `create` / `update` 两类**。多命中 / 名字不可辨识 / 已存在一模一样的
 *    一条都不写，并在回执里点名 —— 猜错比不猜更糟（ADR-016 R3：不许静默失败）。
 * 2. `update` 带 `targetExamId`，`create` 带 `null`（强制新增）——
 *    **所见即所写**，写入器不再重新解析一遍。
 * 3. 写入仍然走 `applyCourseUpdate`（不另写一条写库路径）：
 *    只追加 / 复用 `syncExamToTask` / 留旧值快照这三条纪律一条都不能少。
 */
async function applyFromProposals(input: {
  ctx: ApplyContext
  courseId: string
}): Promise<ApplyOutcome> {
  const { ctx, courseId } = input
  const proposals = readExamProposals(ctx.payload)
  const components = readComponentProposals(ctx.payload)

  // `update` 却没有目标 id = 半截数据（手工改库 / 老数据）。不算可写，也不许退化成新增。
  const isWritable = (item: { kind: string; targetId: string | null }) =>
    item.kind === 'create' || (item.kind === 'update' && item.targetId !== null)
  const writable = proposals.filter(isWritable)
  const blocked = proposals.filter((item) => !isWritable(item))

  if (writable.length === 0 && components.length === 0) {
    const first = blocked[0]
    // 空写入的按钮/回执必须是「知道了」（R3）：这里确实一个字段都不会写。
    return {
      ok: true,
      summary: first
        ? `知道了（${first.examName}：${first.reason ?? '没有可写入的变更'}）`
        : '知道了（这条公告里没有可写入的考试 / 成绩构成）',
    }
  }

  const exams: ParsedExam[] = writable.map((item) => ({
    examName: item.examName,
    examDate: item.examDate,
    examTime: item.examTime,
    location: item.location,
    sourceExcerpt: item.sourceExcerpt,
    // `create` 显式传 null = "用户看过了，就是要新增一条"。
    targetExamId: item.kind === 'update' ? item.targetId : null,
  }))
  const gradeComponents: ParsedGradeComponent[] = components.map((item) => ({
    name: item.name,
    weightPercent: item.weightPercent,
    notes: item.notes,
    sourceExcerpt: item.sourceExcerpt,
  }))

  let result
  try {
    result = await applyCourseUpdate(ctx.supabase, { courseId, exams, gradeComponents })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'not_found') {
      return { ok: false, code: 'not_found', message: '课程不存在或无权访问，已停止写入' }
    }
    console.error('[messages] 公告写入失败（提案路径）:', error)
    return { ok: false, code: 'apply_failed', message: '写入失败，请稍后重试或到课程页手动处理' }
  }

  const parts = [summarizeApply(result)]
  if (blocked.length > 0) {
    parts.push(
      `另有 ${blocked.length} 条没写（${blocked[0].examName}：${blocked[0].reason ?? '未写入'}）`,
    )
  }

  const applied = result.applied
  const hasApplied =
    (applied.examDateIds?.length ?? 0) > 0 ||
    (applied.gradeComponentIds?.length ?? 0) > 0 ||
    (applied.examRestores?.length ?? 0) > 0
  return {
    ok: true,
    summary: parts.join(' · '),
    ...(hasApplied ? { applied } : {}),
  }
}
