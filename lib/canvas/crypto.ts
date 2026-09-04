import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Canvas 凭证的加解密（Security-Privacy.md 第 4 节）。
 *
 * 算法 **AES-256-GCM**：GCM 是 AEAD，除了保密还提供完整性校验 —— 密文被篡改
 * 会在 `final()` 抛错而不是解出一串垃圾。凭证这种"解错了也不报错就是灾难"的数据
 * 必须用 AEAD，不能用 CBC。
 *
 * 密钥来自环境变量 `CANVAS_TOKEN_ENCRYPTION_KEY`（base64 编码的 32 字节），
 * 不入库、不进前端、不进代码仓库。
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * 密文载荷的版本前缀。
 *
 * 存在的意义是**密钥轮换**：将来换密钥时，新密文用 `v2`，旧密文仍是 `v1`，
 * 解密端按前缀选密钥，就能做到"存量凭证不动、新凭证用新密钥"，
 * 而不必停机一次性重加密全部（Security-Privacy 第 5 节提到的轮换代价）。
 */
const VERSION = 'v1'

const ENV_NAME = 'CANVAS_TOKEN_ENCRYPTION_KEY'

/** 与 `lib/supabase/env.ts` 同思路：缺失立刻抛明确错误，不让 undefined 流进 cipher。 */
function getKey(): Buffer {
  const raw = process.env[ENV_NAME]
  if (!raw) {
    throw new Error(
      `缺少环境变量 ${ENV_NAME}。` +
        '生成方式：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))">' +
        '，填入 .env.local（本地）与 Vercel Environment Variables（生产）。'
    )
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    // 不回显密钥内容（日志红线，Security-Privacy 第 8 节），只说长度不对。
    throw new Error(
      `环境变量 ${ENV_NAME} 必须是 base64 编码的 ${KEY_BYTES} 字节密钥，` +
        `当前解码后为 ${key.length} 字节。`
    )
  }

  return key
}

/**
 * 加密明文凭证，返回可存入 `text` 列的字符串。
 *
 * 格式：`v1:<iv_base64>:<tag_base64>:<ciphertext_base64>`
 * IV 每条密文随机生成（GCM 下 IV 重复 = 密钥泄漏级事故，绝不能用固定 IV）。
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_BYTES })

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * 解密 `encryptSecret` 的产物。
 *
 * 失败一律抛 Error（格式不对 / 版本不支持 / 认证标签校验失败）。
 * ⚠️ 错误消息**绝不**包含明文或密文内容 —— 解密失败时最容易顺手把原文打进日志，
 * 那是把密钥泄漏进日志文件的经典路径（Security-Privacy 第 8 节）。
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4) {
    throw new Error('加密载荷格式不正确')
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts
  if (version !== VERSION) {
    throw new Error(`不支持的加密载荷版本：${version}（当前支持 ${VERSION}）`)
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivPart, 'base64'), {
    authTagLength: TAG_BYTES,
  })
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'))

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64')),
    decipher.final(),
  ])

  return plaintext.toString('utf8')
}
