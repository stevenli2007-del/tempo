import type { Syllabus } from '@/types/syllabus'

/**
 * syllabus 一句话状态（卡片摘要与详情页共用）。
 *
 * 单独抽出来是因为「状态文案」要出现在三个地方（卡片摘要、详情页上传区、
 * 未来的总览页），各写一份必然漂移。
 *
 * extract 与 parse 是两件事、会分别失败，所以文案必须分层表达：
 * 「已上传 / 已提取 / 已解析」是三个不同的进度点。
 */
export function syllabusStatusText(syllabus: Syllabus | null): string {
  if (!syllabus) return '还没有 syllabus'
  if (syllabus.extractStatus === 'pending') return '已上传，等待文本提取'
  if (syllabus.extractStatus === 'failed') {
    return syllabus.extractError ?? '文本提取失败，可手动补充'
  }
  switch (syllabus.parseStatus) {
    case 'completed':
      return '已解析完成'
    case 'processing':
      return '解析中…'
    case 'failed':
      return syllabus.parseError ?? '解析失败，可重试或手动补充'
    default:
      return '已提取文本，等待解析'
  }
}
