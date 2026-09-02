/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * `pdf-parse`（底层是 pdfjs-dist）在运行时要加载自带的 `pdf.worker.mjs`。
   *
   * 被打包进 server bundle 后，这个 worker 文件不会被单独产出，运行时报：
   * `Setting up fake worker failed: Cannot find module '.next/server/chunks/pdf.worker.mjs'`
   * —— 结果就是**所有 PDF 提取静默失败**。
   *
   * 标记为 server external：Next 不再打包它，运行时直接从 node_modules require，
   * worker 按包内的相对路径正常解析。
   */
  serverExternalPackages: ['pdf-parse'],

  /**
   * 光有 serverExternalPackages 在 Vercel 上不够（2026-09-02 实测：该路由整体 500）。
   *
   * 原因：pdfjs 在 Node 下把 worker 解析成**相对路径** `./pdf.worker.mjs`
   * —— external 之后它相对的是本包目录 `node_modules/pdf-parse/dist/pdf-parse/cjs/`，
   * 本地 `next start` 能命中，但 Vercel 给每个函数单独裁剪 node_modules，
   * 这个包（以及它里面的 worker 文件）可能压根没被打进函数包 → 路由连加载都失败。
   *
   * 强制把整个 `pdf-parse/dist` 打进所有 API 函数包。
   */
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/pdf-parse/dist/**/*'],
  },
};

export default nextConfig;
