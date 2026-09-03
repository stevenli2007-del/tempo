import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { CourseActions } from '@/components/courses/course-actions'
import { SyllabusUpload } from '@/components/courses/syllabus-upload'
import { SectionEditor } from '@/components/sections/section-editor'
import { UUID_PATTERN } from '@/lib/api/params'
import { loadCourseDetail } from '@/lib/course-detail'
import { createClient } from '@/lib/supabase/server'

/**
 * 课程详情页（P0-1-8，路由 `/courses/[id]`）。
 *
 * 一门课的全部操作都在这里：syllabus 上传 + 解析、五板块查看 / 编辑、课程信息编辑、归档删除。
 * 读逻辑在 `lib/course-detail.ts`，与 `GET /api/v1/courses/:id` 共用一份 ——
 * 页面直查 DB（RLS 保护），不 fetch 自己的 API（省一次往返）。
 *
 * 约定：**列表页在 `/dashboard`**（不新增 `/courses` 列表路由），详情页挂在 `/courses/[id]`。
 */

export const metadata = {
  title: '课程详情 · Tempo',
}

// 依赖用户 session，绝不能被静态预渲染。
export const dynamic = 'force-dynamic'

interface PageProps {
  // Next 15+ 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>
}

export default async function CourseDetailPage({ params }: PageProps) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // proxy（原 middleware，Next 16 更名）已拦过一道，这里再兜一次底。
  if (!user) {
    redirect('/login')
  }

  if (!UUID_PATTERN.test(id)) {
    notFound()
  }

  const { found, detail, error } = await loadCourseDetail(supabase, id)

  // 查询失败必须让用户看见，不能降级成「课程不存在」（CodingRules 7）。
  if (error) {
    return (
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div role="alert" className="rounded-lg border border-destructive/40 bg-card p-4">
            <p className="text-sm font-medium text-destructive">课程详情加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
          <Link href="/dashboard" className="mt-4 inline-block text-sm text-muted-foreground">
            ← 返回总览
          </Link>
        </div>
      </main>
    )
  }

  // ADR-010：不存在 / 不属于当前用户 / 已归档，统一按不存在处理。
  if (!found || !detail) {
    notFound()
  }

  const meta = [detail.courseCode, detail.instructorName].filter(Boolean).join(' · ')

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            ← 总览
          </Link>
          <span className="text-sm font-semibold">Tempo</span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.courseName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[detail.semester, meta].filter(Boolean).join(' · ') || '未填写学期与编码'}
          </p>
        </div>

        <CourseActions course={detail} />

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-medium text-foreground">Syllabus</h2>
          <SyllabusUpload courseId={detail.id} syllabus={detail.syllabus} />
        </section>

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <SectionEditor
            courseId={detail.id}
            sections={{
              gradeComposition: detail.gradeComponents,
              courseOutline: detail.outlineItems,
              testDates: detail.examDates,
              officeHours: detail.officeHours,
              submissionPolicy: detail.submissionPolicies,
            }}
            parseStatus={detail.syllabus ? detail.syllabus.parseStatus : 'none'}
            defaultOpen
          />
        </section>
      </div>
    </main>
  )
}
