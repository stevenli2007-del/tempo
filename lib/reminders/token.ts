import { randomBytes } from 'node:crypto'

/**
 * 退订 token（P0-3-14）。
 *
 * 每个用户一个随机 token，嵌在提醒邮件的退订链接里。点击后端点按 token 定位用户并关提醒。
 *
 * ### 为什么和入站密址（inbound_token）分开
 * 退订链接是**公开、可分享**的（会出现在邮件正文、可能被转发），而 inbound_token 是
 * 私密入站地址、绝不能出现在退订链接里 —— 否则任何人拿到退订邮件就能反推出别人的入站密址。
 * 两者用途与保密级别不同，必须各用各的随机 token。
 */

/** token 最小长度，与入站 token 同档（避免极短 token 被暴力撞中）。 */
export const MIN_UNSUB_TOKEN_LENGTH = 12

/** 生成一个不可预测的退订 token（18 字节随机 → 36 字符全小写 hex）。 */
export function generateUnsubToken(): string {
  return randomBytes(18).toString('hex')
}
