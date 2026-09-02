/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * unpdf 里内嵌了一份为 serverless 重新打包的 pdfjs（单文件 ~1MB），
   * 走的是预打包产物，让 Turbopack 再过一遍手没有收益、只有风险。
   * 标记 external：运行时直接从 node_modules 原样加载。
   */
  serverExternalPackages: ['unpdf'],

  /**
   * 字体与 CJK 字符映射数据是**运行时按路径读的文件**，不在 import 图里，
   * 不会被自动追踪，必须显式声明，否则 `standardFontDataUrl` / `cMapUrl` 指向的目录
   * 不会出现在 Vercel 的函数包里。
   *
   * 缺了它不会崩 —— pdfjs 只是 warn，文本照样抽得出来（实测过），
   * 但非嵌入字体的度量会缺失，可能改变换行位置。
   *
   * ⚠️ 数据来源是 `pdfjs-dist` 包，但**只是当数据包用**，不 import 它的 JS（见 `lib/extract.ts`）。
   */
  outputFileTracingIncludes: {
    '/api/**': [
      './node_modules/pdfjs-dist/standard_fonts/**/*',
      './node_modules/pdfjs-dist/cmaps/**/*',
    ],
  },
};

export default nextConfig;
