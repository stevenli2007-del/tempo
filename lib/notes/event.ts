/**
 * 音符的跨组件事件名（P0-5-4）。
 *
 * 一条任务被标记完成后，待办清单（`TaskList`）dispatch 这个事件；
 * 侧栏计数（`NoteCounter`）与彩带层（`ConfettiLayer`）各自监听 ——
 * 两者共用这一个常量，避免字符串字面量在两边各写一份、改一边漏一边
 * （CodingRules §10.1 第 21 条，与 `lib/messages/event.ts` 同一条纪律）。
 */
export const NOTES_UPDATED_EVENT = 'tempo-notes-updated'

/**
 * 事件 detail。
 *
 * `title` 只给读屏用（彩带本身**不带任何文字**，见 `components/notes/confetti.tsx`）——
 * 屏幕阅读器用户拿不到"屏幕上飘了一层彩带"这个信号，用一句中性的事实补上。
 */
export interface NotesUpdatedDetail {
  title: string
}
