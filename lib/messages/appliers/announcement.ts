import { applyCourseUpdate, summarizeApply } from '@/lib/course-update/apply'
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
  const announcementId = typeof payload.announcementId === 'string' ? payload.announcementId : ''
  if (courseId === '' || announcementId === '') {
    return {
      ok: false,
      code: 'announcement_payload_incomplete',
      message: '这条公告消息缺少课程或公告标识，无法写入，请改用对话框处理',
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

  if (exams.items.length === 0 && components.items.length === 0) {
    // 粗筛说"有落点"但实际解析不出可写入的东西 —— 如实报错（不是静默成功）。
    const detail = exams.skipped[0] ?? components.skipped[0] ?? ''
    return {
      ok: false,
      code: 'nothing_to_write',
      message: detail
        ? `这条公告里没有可写入的考试或成绩构成（${detail}），请到课程页手动处理`
        : '这条公告里没有可写入的考试或成绩构成，请到课程页手动处理',
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

  return { ok: true, summary: parts.join(' · ') }
}
