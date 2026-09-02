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
};

export default nextConfig;
