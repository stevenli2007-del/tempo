import { handleSectionSave } from '@/lib/parse/save'

/**
 * `PUT /api/v1/courses/:id/office-hours（API-Contract.md 第 4 节，P0-1-5b）。
 *
 * 全量替换该课程的Office Hour板块，幂等。
 * 逐字段 diff 写 parse_corrections、不带 id 的行按 manual 来源插入、
 * 库里多出的行删除 —— 全部编排逻辑在 lib/parse/save.ts，路由只做分发。
 */

interface RouteContext {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { id } = await params
  return handleSectionSave(request, id, 'office-hours')
}
