import type { Task } from '@/types/task'
import { dropCanvasExamPlaceholders } from '@/lib/tasks'
import { isRemindable } from './build'

/**
 * 提醒邮件的任务筛选（P0-5-5 ③）—— 纯函数，`engine.ts` 与回归脚本共用**同一份**。
 *
 * ### 为什么要有这个文件
 * 这两层筛选原先散在 `engine.ts`（异步 IO 层，回归脚本 import 不了）。
 * 抽出来之后「邮件里到底列了什么」能被 `regress:reminders` 直接钉死 ——
 * 否则这类筛选只能靠真发一封邮件才看得见，而它错了是**静默**的（邮件照发、条数照对）。
 *
 * ### 🔴 顺序：先去空壳，再判可提醒
 * `dropCanvasExamPlaceholders` 要在**全量**上跑：它靠「同课有没有这场考试」建键，
 * 先过一遍 `isRemindable` 会把已完成的考试行滤掉 → 键变少 → 对应的空壳行**漏出来**。
 * 漏出来的空壳没有截止日，虽不进正文（进「另有 N 项」），但那条计数就对不上账了。
 *
 * ### 判据仍只有那两份，这里不写第三条
 * 空壳判据 = `dropCanvasExamPlaceholders`（总览页 / 课程详情页同一份，P0-3-36）；
 * 可提醒判据 = `isRemindable`（`build.ts`）。**绝不**在这里另写「名字像考试就隐藏」。
 */
export function selectReminderTasks(tasks: Task[]): Task[] {
  return dropCanvasExamPlaceholders(tasks).filter(isRemindable)
}
