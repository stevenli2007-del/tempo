import { t } from '@/lib/i18n/translate'
import type { Lang } from '@/lib/i18n/types'
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
export function syllabusStatusText(syllabus: Syllabus | null, lang: Lang = 'zh'): string {
  if (!syllabus) return t(lang, 'syllabus.none')
  if (syllabus.extractStatus === 'pending') return t(lang, 'syllabus.uploadedWaitingExtract')
  if (syllabus.extractStatus === 'failed') {
    return syllabus.extractError ?? t(lang, 'syllabus.extractFailed')
  }
  switch (syllabus.parseStatus) {
    case 'completed':
      return t(lang, 'syllabus.parsed')
    case 'processing':
      return t(lang, 'syllabus.processing')
    case 'failed':
      return syllabus.parseError ?? t(lang, 'syllabus.parseFailed')
    default:
      return t(lang, 'syllabus.extractedWaitingParse')
  }
}
