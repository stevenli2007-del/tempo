/**
 * Canvas 课程列表拉取（P0-2-3，API-Contract.md 第 6 节 `GET /api/v1/canvas/courses`）。
 *
 * 用已交付的 `canvasGet()`（P0-2-2）发请求，本文件只负责：
 * 把 Canvas 返回的课程对象 **忠实映射** 成对外的 `CanvasCourse`（externalId / name / term），
 * 并把失败归类抛给调用方（GET route）决定怎么回 HTTP 状态。
 *
 * ### 边界与理由
 * - **不筛选学期 / 不判断"是不是教学课程"**。Canvas 的 active enrollment 里可能混着
 *   入学流程类模块（GBO / PartySafe / Hazing / SHAPE 等，term 是 "Default Term"/"Projects"），
 *   是否给用户过滤属于关联 UI（P0-2-4）的产品决策，不是本层该替用户做的。
 *   本层忠实返回全部，`term` 完整保留，让用户在 P0-2-4 自己辨认。
 * - **不做翻页**。Phase 0 规模下 `per_page=100` 一页足以装下（Steven 实测 13 门）。
 *   真超 100 门的翻页需求等 P0-2-5 同步要拿 assignments 时再处理 —— 那时 `canvasGet()`
 *   需要能返回 `Link` 头，作为对已验收 client 的一次独立扩展，不在本卡夹带。
 * - **不写库、不重试**（与 `canvasGet` 一致的职责边界；状态落库归同步编排 P0-2-5）。
 *
 * ### 🔴 日志红线（Security-Privacy 第 8 节）
 * 本文件不打印 token、Authorization 头或完整 URL。错误归类由 `canvasGet` 的
 * `CanvasFailureKind` 决定，文案不含凭据。
 */
import { canvasGet, type CanvasFailureKind } from '@/lib/canvas/client'
import type { CanvasCourse } from '@/types/canvas'

/** Canvas 课程列表接口返回的最小字段（Canvas 官方 `/api/v1/courses` 对象）。 */
type CanvasApiCourse = {
  /** 源侧课程 ID（数字，当字符串处理，ID 不参与算术）。 */
  id: number
  /** 完整课程名，如 "Multivariable Calculus (Fall 2026)"。 */
  name: string
  /** 课程代码，如 "MATH 53-LEC-001"。关联 UI 靠它区分同名课程的 lecture/section。 */
  course_code: string
  /** `include[]=term` 时返回的学期对象；未传 include 时该字段不存在。 */
  term?: { name?: string | null } | null
}

/** 拉取结果：成功返回课程数组；失败时 kind/message 与 `canvasGet` 一致。 */
export type CanvasCoursesResult =
  | { ok: true; data: CanvasCourse[] }
  | { ok: false; kind: CanvasFailureKind; message: string }

/**
 * 拉取当前 token 可见的全部 active 课程，映射为对外 `CanvasCourse`。
 *
 * @param domain Canvas 主机名（已通过 SSRF 校验后存库的值）
 * @param token  明文 PAT（只在本次调用内存在，不落盘不进日志）
 */
export async function fetchCanvasCourses(
  domain: string,
  token: string,
): Promise<CanvasCoursesResult> {
  const path =
    '/api/v1/courses?enrollment_state=active&include[]=term&per_page=100'
  const result = await canvasGet<CanvasApiCourse[]>(domain, token, path)

  if (!result.ok) {
    return { ok: false, kind: result.kind, message: result.message }
  }

  const raw = result.data
  const courses: CanvasCourse[] = Array.isArray(raw)
    ? raw.map((c) => ({
        externalId: String(c.id),
        // name 用 course_code 而非 name：关联 UI 需要靠它区分
        // 同名课程（如 "Multivariable Calculus (Fall 2026)" 的 LEC 与 DIS），
        // 且 course_code 更接近用户在 Tempo 里认的课程标识。契约例子的
        // "MATH 53 - …" 也是 code 起头的风格。
        name: c.course_code || c.name,
        term: c.term?.name ?? null,
      }))
    : []

  return { ok: true, data: courses }
}
