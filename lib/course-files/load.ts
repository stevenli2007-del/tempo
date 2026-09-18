import { createClient } from '@/lib/supabase/server'

import type { CourseFileView } from '@/lib/course-files/grouping'

/**
 * 课程资料区（P0-3-19）的**读取**。
 *
 * 🔴 本文件带服务端依赖（`lib/supabase/server` → `next/headers`），
 * 只能在服务端组件 / 路由里用。纯逻辑（分组 / 格式化）在 `./grouping.ts`，
 * 那条边界的来由写在那里，别把纯函数挪进本文件。
 *
 * ### 与同步的分工
 * - 写（Canvas → `course_files`）在 `lib/sync/canvas-files.ts`
 * - 读（`course_files` → 界面）在这里
 * 两边不共享代码，只共享表结构 —— 同步关心"这次拉到了什么、和库里差多少"，
 * 读取关心"怎么摆给用户看"，搅在一起会让任一方改动都牵动另一方。
 *
 * ### 🔴 只读元数据，永不碰文件内容
 * 返回的东西里没有任何文件内容，只有一个指回 Canvas 的链接。
 */

/** 服务端 Supabase 客户端（与 `lib/course-detail.ts` 同一写法）。 */
type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** 一次最多取回多少个文件（兜住极端数据，不是展示上限）。 */
const COURSE_FILES_LIMIT = 500

/**
 * 取一门课的全部资料（未删除的）。
 *
 * ### 查询失败要**显式报错**，不降级成空数组
 * CodingRules 7：一个静默的空列表会被读成"这门课没有资料"。
 * 所以返回 `{ files, error }` 而不是只回数组 —— 调用方必须处理 `error` 并画出来。
 *
 * ⚠️ 迁移没跑时（42P01）这里也会报错 —— 那是**预期内的**：
 * 界面显示"资料加载失败"比假装"没有资料"诚实。
 *
 * 归属由 RLS 保证（`course_files` 的策略通过 `courses.user_id` 反查）；
 * 调用方传入的 `courseId` 已经过详情页的存在性校验。
 */
export async function loadCourseFiles(
  supabase: ServerSupabase,
  courseId: string,
): Promise<{ files: CourseFileView[]; error: string | null }> {
  const { data, error } = await supabase
    .from('course_files')
    .select('id, display_name, folder_path, file_url, content_type, size_bytes, modified_at')
    .eq('course_id', courseId)
    .eq('is_deleted', false)
    .order('folder_path', { ascending: true })
    .order('display_name', { ascending: true })
    .limit(COURSE_FILES_LIMIT)

  if (error) {
    return { files: [], error: error.message }
  }

  type Row = {
    id: string
    display_name: string
    folder_path: string
    file_url: string
    content_type: string | null
    size_bytes: number | null
    modified_at: string | null
  }

  const rows = (data ?? []) as Row[]
  const files: CourseFileView[] = rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    folderPath: row.folder_path,
    fileUrl: row.file_url,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
  }))

  return { files, error: null }
}
