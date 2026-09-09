import type { createClient } from '@/lib/supabase/server'

/**
 * 删除账号及全部数据（P0-3-2，PRD F6 / API-Contract §7 / Security-Privacy A11）。
 *
 * ### 🔴 顺序：Storage → auth user → 兜底删 profiles
 * 1. **先删 Storage 文件**：`storage.objects` 不在数据库级联链上，
 *    只删库会留下一堆无主文件 —— 这是 A11 单独列一条"不可遗漏"的原因。
 * 2. **再删 auth user**：`profiles.id → auth.users.id` 是 `ON DELETE CASCADE`，
 *    删 auth user 会顺着 FK 把 `profiles` 及**全部**业务表清空（
 *    courses / syllabi / 五板块 / tasks / canvas_credentials / sync_runs /
 *    llm_runs / parse_corrections / usage_events 全部挂在 profiles 或 courses 下）。
 *    先做这一步的好处是**失败模式干净**：auth 删除失败 = 什么都没删，可以直接重试。
 * 3. **兜底显式删 profiles 行**：万一 auth 删除没级联（换环境 / 策略变了），
 *    这条保证数据照样清空；正常情况下它是 no-op。
 *
 * 反过来（先删数据再删 auth）的失败模式是"数据没了、账号还在"，
 * 用户再登录看到的是半截状态，且无法自助恢复 —— 所以不采用。
 *
 * ### 为什么 Storage 失败要中止整趟删除
 * 文件删不掉就继续删账号，等于**制造** A11 要防的那种无主文件，
 * 而且事后连"这些文件属于谁"都查不出来了（账号已经没了）。宁可整趟失败。
 */

type Supabase = Awaited<ReturnType<typeof createClient>>

/** syllabus 文件桶（Database.md §7.3）。私有桶，路径首段恒为 user_id。 */
const SYLLABI_BUCKET = 'syllabi'
/** Storage `list()` 单次上限。 */
const LIST_PAGE_SIZE = 1000
/** `remove()` 一次别塞太多，分批稳一些。 */
const REMOVE_CHUNK = 200

export type StorageCleanupResult = {
  /** 实际删掉的对象数。 */
  deleted: number
  /** null = 全部删干净；非 null = 失败原因，调用方必须中止后续删除。 */
  error: string | null
}

export type DeleteAccountResult = {
  storage: StorageCleanupResult
  /** 业务数据是否已清空（auth 级联或兜底删除任一生效即为 true）。 */
  dataDeleted: boolean
  /** Supabase Auth 用户是否已删除。false 时用户可以重试（幂等）。 */
  authUserDeleted: boolean
  /** 非 null = 整趟失败的原因。 */
  error: string | null
}

/**
 * 递归列出某前缀下的全部对象路径。
 *
 * Storage 的 `list()` 只返回一层，且把"文件夹"也当成条目返回
 * （区分方式：`id` 为 null）。只 list 一层会漏掉
 * `{user_id}/{course_id}/xxx.pdf` 里第二层的文件。
 */
async function listObjectPaths(supabase: Supabase, prefix: string): Promise<string[]> {
  const paths: string[] = []

  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage.from(SYLLABI_BUCKET).list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset,
    })
    if (error) {
      throw new Error(error.message)
    }
    const entries = data ?? []
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`
      if (entry.id === null) {
        // 目录：递归进下一层。
        paths.push(...(await listObjectPaths(supabase, path)))
      } else {
        paths.push(path)
      }
    }
    if (entries.length < LIST_PAGE_SIZE) {
      return paths
    }
  }
}

/**
 * 删掉该用户在 `syllabi` 桶下的全部文件（含孤儿文件）。
 *
 * 按 `user_id` 前缀整段删，而不是照 `syllabi.file_url` 逐条删 ——
 * 后者删不掉"上传成功但没建行"的孤儿文件（ADR-009 两步式直传的已知代价）。
 */
export async function deleteUserFiles(
  supabase: Supabase,
  userId: string,
): Promise<StorageCleanupResult> {
  try {
    const paths = await listObjectPaths(supabase, userId)
    if (paths.length === 0) {
      return { deleted: 0, error: null }
    }

    for (let index = 0; index < paths.length; index += REMOVE_CHUNK) {
      const { error } = await supabase.storage
        .from(SYLLABI_BUCKET)
        .remove(paths.slice(index, index + REMOVE_CHUNK))
      if (error) {
        return { deleted: index, error: error.message }
      }
    }

    return { deleted: paths.length, error: null }
  } catch (cause) {
    return { deleted: 0, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export async function deleteAccountAndData({
  userId,
  supabase,
  adminClient,
}: {
  userId: string
  /** 用户级客户端：删 Storage 走 RLS（只能删自己前缀下的对象）。 */
  supabase: Supabase
  /** Service role 客户端：删 auth user 与兜底删 profiles 必须要它。 */
  adminClient: Supabase
}): Promise<DeleteAccountResult> {
  const storage = await deleteUserFiles(supabase, userId)
  if (storage.error !== null) {
    return { storage, dataDeleted: false, authUserDeleted: false, error: storage.error }
  }

  const { error: authError } = await adminClient.auth.admin.deleteUser(userId)
  if (authError) {
    return {
      storage,
      dataDeleted: false,
      authUserDeleted: false,
      error: `删除登录账号失败：${authError.message}`,
    }
  }

  // 兜底：正常已被级联清空，这里只是保证"数据一定没了"这个结论不依赖级联。
  const { error: profileError } = await adminClient.from('profiles').delete().eq('id', userId)
  if (profileError) {
    return {
      storage,
      dataDeleted: false,
      authUserDeleted: true,
      error: `清理数据失败：${profileError.message}`,
    }
  }

  return { storage, dataDeleted: true, authUserDeleted: true, error: null }
}
