/**
 * i18n 类型与常量（P0-5-1）。
 *
 * 零依赖：本文件不 import 任何 Next / React / 浏览器 API，可被服务端组件、
 * 客户端组件、纯 lib 函数共用。
 */

export type Lang = 'zh' | 'en'

/** 默认语言。服务端读不到 cookie 时回退到这里。 */
export const DEFAULT_LANG: Lang = 'zh'

/** 语言偏好 cookie 名（与 localStorage 键共用，见 provider）。 */
export const COOKIE_NAME = 'tempo-lang'
