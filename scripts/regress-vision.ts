/**
 * P0-3-9 截图档纯函数回归（零副作用，不连库、不连 LLM）。
 *
 * 测的是「图片闸门」逻辑 —— 与 `app/api/v1/tasks/parse-image/route.ts` 的 `parseImage`
 * 同口径。这是**唯一一类**「代码照样过、但拦截被悄悄放宽的 bug」：格式白名单 / 体积闸
 * 一旦退化，页面照常渲染、用户也看不出，直到一张 20MB 的 HEIC 把请求打挂。
 *
 * 用 `tsx` 直接 import 真函数不可行（闸在 route 里、依赖 Request），所以这里复制一份
 * 同口径实现并断言。改 route 时务必同步这里（顶部注释已写明）。
 */

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const BASE64_PATTERN = /^[A-Za-z0-9+/=_-]+$/

type ImageInput = { mediaType: string; dataBase64: string }

function parseImage(raw: unknown): { ok: true; image: ImageInput } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'image 必须是对象' }
  }
  const img = raw as Record<string, unknown>
  const mediaType = typeof img.mediaType === 'string' ? img.mediaType : ''
  const dataBase64 = typeof img.dataBase64 === 'string' ? img.dataBase64 : ''
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) return { ok: false, message: '媒体类型不在白名单' }
  if (!BASE64_PATTERN.test(dataBase64)) return { ok: false, message: 'base64 格式非法' }
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length === 0) return { ok: false, message: '空图片' }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, message: '超过 5MB' }
  return { ok: true, image: { mediaType, dataBase64 } }
}

let passed = 0
let failed = 0

function assert(cond: boolean, name: string) {
  if (cond) {
    passed += 1
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

const onePxPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/3pUAAAAAElFTkSuQmCC'

// 1. 白名单：允许的三种
assert(parseImage({ mediaType: 'image/png', dataBase64: onePxPng }).ok, 'PNG 通过')
assert(parseImage({ mediaType: 'image/jpeg', dataBase64: 'aGVsbG8=' }).ok, 'JPEG 通过')
assert(parseImage({ mediaType: 'image/webp', dataBase64: 'aGk=' }).ok, 'WebP 通过')

// 2. 白名单：拒绝 HEIC / GIF / 空
assert(!parseImage({ mediaType: 'image/heic', dataBase64: onePxPng }).ok, 'HEIC 拒绝')
assert(!parseImage({ mediaType: 'image/gif', dataBase64: onePxPng }).ok, 'GIF 拒绝')
assert(!parseImage({ mediaType: '', dataBase64: onePxPng }).ok, '空媒体类型拒绝')

// 3. base64 格式：含非法字符拒绝
assert(!parseImage({ mediaType: 'image/png', dataBase64: 'ab!@#' }).ok, '含非法字符的 base64 拒绝')

// 4. 体积闸：>5MB 拒绝 / ≤5MB 通过（按**解码后字节**判，而非 base64 字符串长度）。
// base64 解码后约 3/4 长度，故用 5MB+1 字节的真实数据构造。
const bigBytes = Buffer.alloc(5 * 1024 * 1024 + 1).fill(1)
const big = bigBytes.toString('base64')
assert(!parseImage({ mediaType: 'image/png', dataBase64: big }).ok, '超过 5MB 拒绝')
// 刚好 5MB 内通过
const okBytes = Buffer.alloc(5 * 1024 * 1024 - 1).fill(1)
const ok = okBytes.toString('base64')
assert(parseImage({ mediaType: 'image/png', dataBase64: ok }).ok, '5MB 以内通过')

// 5. 结构：非对象 / 缺字段拒绝
assert(!parseImage(null).ok, 'null 拒绝')
assert(!parseImage('not object').ok, '字符串拒绝')
assert(!parseImage({ mediaType: 'image/png' }).ok, '缺 dataBase64 拒绝')
assert(!parseImage({ dataBase64: onePxPng }).ok, '缺 mediaType 拒绝')

console.log(`\nregress:vision — ${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
