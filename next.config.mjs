/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * pdfjs 体量大（legacy 构建 ~940KB）且内部会按 `import.meta.url` 解析资源，
   * 被打包进 server bundle 容易出幺蛾子。标记为 external：运行时直接从 node_modules 加载。
   */
  serverExternalPackages: ['pdfjs-dist'],

  /**
   * 标准字体数据（Helvetica / Times 等非嵌入字体要用到）是**运行时**按路径读的，
   * 不会被 import 图追踪到，必须显式声明，否则 `standardFontDataUrl` 指向的目录不在函数包里。
   *
   * 缺了它不会崩 —— pdfjs 只是 warn，文本照样抽得出来（实测过），
   * 但会每页打一条 `UnknownErrorException`，且缺字体度量可能影响换行位置。
   */
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/pdfjs-dist/standard_fonts/**/*'],
  },
};

export default nextConfig;
