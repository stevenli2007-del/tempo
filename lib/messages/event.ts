/**
 * 消息栏跨组件事件名（P0-3-18）。
 *
 * 一条提案被「确认 / 忽略」后，消息页（`MessagesView`）dispatch 这个事件，
 * 侧栏（`Sidebar`）监听它刷新 `pending` 徽标计数 —— 两者共用这一个常量，
 * 避免字符串字面量在两边各写一份、改一边漏一边（CodingRules §10.1 第 21 条）。
 */
export const MESSAGES_UPDATED_EVENT = "tempo-messages-updated"
