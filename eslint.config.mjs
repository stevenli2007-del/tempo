import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// Next 16 的 eslint-config-next 本身就是 flat config array，直接展开即可。
// 不需要 @eslint/eslintrc 的 FlatCompat —— 那层兼容在 ESLint 10 下会崩
// （循环引用 JSON 序列化报错）。
// 另注：Next 16 已移除 `next lint` 命令，lint 改为直接走 eslint CLI。
const config = [
  {
    // `.workbuddy/` 是本地数据区（memory / backups，已在 .gitignore 内）——**不是源码**。
    // 不排除的话，备份进去的 skill 副本（.mjs/.ts）会往门禁里塞 warning，
    // 让「0 error / N warning」的基线随备份内容漂移（2026-09-18 实测：多出 2 条 unused-vars）。
    ignores: [".workbuddy/**"],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
