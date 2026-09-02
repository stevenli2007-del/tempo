import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// Next 16 的 eslint-config-next 本身就是 flat config array，直接展开即可。
// 不需要 @eslint/eslintrc 的 FlatCompat —— 那层兼容在 ESLint 10 下会崩
// （循环引用 JSON 序列化报错）。
// 另注：Next 16 已移除 `next lint` 命令，lint 改为直接走 eslint CLI。
const config = [
  ...coreWebVitals,
  ...typescript,
];

export default config;
