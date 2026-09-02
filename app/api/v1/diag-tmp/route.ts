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
  return { step, ok: false, detail: message.slice(0, 600) }
}

export async function GET() {
  const steps: Step[] = []
  steps.push(ok('runtime', `${process.version} / ${process.platform} / cwd=${process.cwd()}`))

  // node_modules 到底在不在函数包里
  for (const rel of [
    'node_modules/pdfjs-dist/package.json',
    'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
    'node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
  ]) {
    steps.push(ok(`exists:${rel.split('/').slice(2).join('/')}`, fs.existsSync(path.join(process.cwd(), rel))))
  }

  // 逐级扫 node_modules 顶层，看有没有 pdf 相关的包
  try {
    const nm = fs.readdirSync(path.join(process.cwd(), 'node_modules'))
    steps.push(ok('has_pdfjs_dir', nm.includes('pdfjs-dist')))
    steps.push(ok('node_modules_count', nm.length))
  } catch (error) {
    steps.push(err('read_node_modules', error))
  }

  // 关键：import 到底抛什么
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    steps.push(ok('import_pdfjs_legacy', `typeof getDocument=${typeof mod.getDocument}`))
  } catch (error) {
    steps.push(err('import_pdfjs_legacy', error))
  }

  try {
    const mod = await import('@/lib/extract')
    steps.push(ok('import_lib_extract', `typeof fn=${typeof mod.extractSyllabusText}`))
  } catch (error) {
    steps.push(err('import_lib_extract', error))
  }

  return Response.json(
    { steps, failed: steps.filter((s) => !s.ok).length },
    { headers: { 'cache-control': 'no-store' } },
  )
}
