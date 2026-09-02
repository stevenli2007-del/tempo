import fs from 'node:fs'
import path from 'node:path'

// ⚠️ 临时诊断路由，抓完线上错误立刻删除。不碰数据库、不碰鉴权、不返回任何机密。

export const maxDuration = 60

type Step = { step: string; ok: boolean; detail: string }

function ok(step: string, detail: unknown): Step {
  return { step, ok: true, detail: String(detail) }
}

function err(step: string, error: unknown): Step {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return { step, ok: false, detail: message.slice(0, 800) }
}

export async function GET() {
  const steps: Step[] = []

  steps.push(ok('runtime', `${process.version} / ${process.platform} / ${process.arch}`))

  // 1. worker 文件在不在函数包里
  try {
    const worker = path.join(
      process.cwd(),
      'node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs',
    )
    steps.push(ok('worker_exists', `${fs.existsSync(worker)} (cwd=${process.cwd()})`))
  } catch (error) {
    steps.push(err('worker_exists', error))
  }

  // 2. 逐个 import，定位到底哪个包炸
  let PDFParse: unknown = null
  try {
    const mod = await import('pdf-parse')
    PDFParse = mod.PDFParse
    steps.push(ok('import_pdf-parse', `typeof PDFParse=${typeof PDFParse}`))
  } catch (error) {
    steps.push(err('import_pdf-parse', error))
  }

  try {
    const mod = await import('mammoth')
    steps.push(ok('import_mammoth', `typeof extractRawText=${typeof mod.default?.extractRawText}`))
  } catch (error) {
    steps.push(err('import_mammoth', error))
  }

  try {
    const mod = await import('jszip')
    steps.push(ok('import_jszip', `typeof loadAsync=${typeof mod.default?.loadAsync}`))
  } catch (error) {
    steps.push(err('import_jszip', error))
  }

  // 3. 我们的提取层能不能加载
  try {
    const mod = await import('@/lib/extract')
    steps.push(ok('import_lib_extract', `typeof fn=${typeof mod.extractSyllabusText}`))
  } catch (error) {
    steps.push(err('import_lib_extract', error))
  }

  // 4. 真跑一次 PDF 提取（最小 1 页 PDF，硬编码在下面）
  if (PDFParse) {
    try {
      const { extractSyllabusText } = await import('@/lib/extract')
      const result = await extractSyllabusText('pdf', Buffer.from(MINIMAL_PDF_BASE64, 'base64'))
      steps.push(ok('extract_pdf', JSON.stringify(result).slice(0, 500)))
    } catch (error) {
      steps.push(err('extract_pdf', error))
    }
  }

  return Response.json(
    { steps, failed: steps.filter((s) => !s.ok).length },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/** 最小合法单页 PDF（含文字 "Tempo diag"），带完整 xref，避免解析器容错导致误判。 */
const MINIMAL_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg" +
  "L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg" +
  "UiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIg" +
  "Pj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MiA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoVGVt" +
  "cG8gZGlhZykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFz" +
  "ZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4g" +
  "CjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzIgMDAw" +
  "MDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDIKJSVFT0YK"
