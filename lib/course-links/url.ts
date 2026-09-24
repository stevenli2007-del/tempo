/**
 * 链接 URL 的**客户端轻量预检**（P0-5-3）。
 *
 * 🔴 这是**零依赖模块**，可以被客户端组件直接 import。
 * 权威校验（`isBlockedHostname` / DNS 真实 IP）在 `lib/ingest/url-fetch.ts` 与
 * `lib/course-links/store.ts`，那些模块会拖进 `node:dns`，**绝不能进客户端包**
 * （CodingRules §10.1：客户端边界连动态 import() 都挡不住）。
 *
 * 这里的预检只是让用户在**发请求前**就看到"这不是个网址"，省一次往返；
 * 它不是安全边界 —— 安全边界只在服务端。
 *
 * ⚠️ **唯一出处**：课程详情页的 `CourseLinks` 与全局浮窗的 `LinkComposer` 都用它。
 * 两处各写一份正则迟早会长歪（见 P0-3-15 那类"两处各自都对、说的不是同一件事"的分叉）。
 */

const HTTP_URL = /^https?:\/\/\S+$/i

/** 看起来像个 http(s) 网址（客户端预检；服务端另有权威校验）。 */
export function isHttpUrl(raw: string): boolean {
  return HTTP_URL.test(raw.trim())
}
