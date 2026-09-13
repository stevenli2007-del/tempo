// 侧栏与内容区左右偏移必须严格同步（否则内容会被固定侧栏盖住）。
// D3：先做 ≥960px 三档（Stride 断点 1550 / 1190）。≤960 图标化、≤550 隐藏留 3-12。
export const SIDEBAR_W =
  "w-[220px] min-[1550px]:w-[238px] max-[1190px]:w-[190px]"

export const CONTENT_ML =
  "ml-[220px] min-[1550px]:ml-[238px] max-[1190px]:ml-[190px]"
