/**
 * 全站常量（**只在本文件里改**）。
 *
 * 有独立文件而不是散在组件里的理由：同一个值被多处消费时，
 * 复制的那几份**不会同时被改**（CodingRules §10.1 第 20 条）。
 */

/**
 * 反馈收集入口（P0-3-32）。
 *
 * 🔴 **当前是占位符**（2026-09-20）—— Steven 拿到 Google Form 链接后
 * **只改这一行**，侧栏底部的「反馈」入口、教程卡最后一张里的收尾链接会一起生效。
 *
 * ⚠️ 改动约束：
 * 1. 必须是完整的 `http(s)` 绝对 URL —— 渲染前会过 `readSafeUrl()`（只放行 http/https），
 *    写成 `docs.google.com/xxx`（缺协议）会被判 null、入口**静默消失**。
 *    这条由 `scripts/regress-onboarding.ts` 钉住：常量写坏了回归会红，不会等到线上才发现。
 * 2. 不要在这里放任何密钥 / 带 token 的私有链接（本文件进公开仓库）。
 */
export const FEEDBACK_URL = 'https://example.com/tempo-feedback'
