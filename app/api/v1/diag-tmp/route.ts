import fs from 'node:fs'
import path from 'node:path'

// ⚠️ 临时诊断路由（第三轮：验证 unpdf 在线上能不能跑）。抓完立刻删除。
// 不碰数据库、不碰鉴权、不返回任何机密。

export const maxDuration = 60

type Step = { step: string; ok: boolean; detail: string }

function ok(step: string, detail: unknown): Step {
  return { step, ok: true, detail: String(detail) }
}

function err(step: string, error: unknown): Step {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return { step, ok: false, detail: message.slice(0, 600) }
}

/** 最小合法单页 PDF（含文字 "Tempo diag"）。纯手搓，不依赖任何工具。 */
const MINIMAL_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5' +
  'cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVu' +
  'dCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAv' +
  'RjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MiA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcy' +
  'IDcwMCBUZCAoVGVtcG8gZGlhZykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0' +
  'eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAow' +
  'MDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAw' +
  'MDAwIG4gCjAwMDAwMDAzMzIgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0' +
  'MDIKJSVFT0YK'

export async function GET() {
  const steps: Step[] = []
  steps.push(ok('runtime', `${process.version} / ${process.platform} / cwd=${process.cwd()}`))

  // 最关键的一条：import 之前 DOMMatrix 到底在不在。
  // 在 = 环境里有 @napi-rs/canvas（本地 macOS 就是这样，会掩盖问题）；
  // 不在 = Vercel 的真实条件，pdf-parse / pdfjs-dist 都会在这上面崩。
  steps.push(ok('DOMMatrix_before_import', typeof globalThis.DOMMatrix))

  try {
    const nm = fs.readdirSync(path.join(process.cwd(), 'node_modules'))
    steps.push(ok('has_unpdf', nm.includes('unpdf')))
    steps.push(ok('has_canvas_dir', fs.existsSync(path.join(process.cwd(), 'node_modules/@napi-rs'))))
    steps.push(ok('node_modules_count', nm.length))
  } catch (error) {
    steps.push(err('read_node_modules', error))
  }

  for (const rel of [
    'node_modules/unpdf/dist/index.mjs',
    'node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
    'node_modules/pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap',
  ]) {
    steps.push(ok(`exists:${rel.replace('node_modules/', '')}`, fs.existsSync(path.join(process.cwd(), rel))))
  }

  try {
    const mod = await import('unpdf')
    steps.push(ok('import_unpdf', `typeof extractText=${typeof mod.extractText}`))
  } catch (error) {
    steps.push(err('import_unpdf', error))
  }

  try {
    const mod = await import('@/lib/extract')
    steps.push(ok('import_lib_extract', `typeof fn=${typeof mod.extractSyllabusText}`))
  } catch (error) {
    steps.push(err('import_lib_extract', error))
  }

  // 真跑一次：走的就是生产代码路径
  try {
    const { extractSyllabusText } = await import('@/lib/extract')
    const result = await extractSyllabusText('pdf', Buffer.from(MINIMAL_PDF_BASE64, 'base64'))
    steps.push(ok('extract_pdf', JSON.stringify(result).slice(0, 400)))
    if (result.status !== 'extracted') {
      steps.push({ step: 'extract_status', ok: false, detail: `status=${result.status} error=${result.error}` })
    }
  } catch (error) {
    steps.push(err('extract_pdf', error))
  }

  const failed = steps.filter((s) => !s.ok).length
  return Response.json({ steps, failed }, { headers: { 'cache-control': 'no-store' } })
}
