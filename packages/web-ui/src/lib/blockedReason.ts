/**
 * 「这张卡为什么是 `blocked`」——**唯一判别位**。
 *
 * 背景：`blocked` 一直扛着两件性质完全不同的事，界面上没有任何可读的区分：
 *
 *  · `deps` —— 上游依赖没完成。这是**派生事实**：依赖一完成，引擎自己会把卡放回队列，
 *    没有任何人需要动手。用户对着它「去处理」是徒劳的。
 *  · `hold` —— 有人（人 / agent）主动声明暂停。这是**需要决定**的，它在等人。
 *
 * 引入 `blockedReason` 之前，四个界面各自从 `blockedBy` 反推（"依赖为空或全完成 ⇒ 异常"）。
 * 同一段推断被抄了三遍（任务详情、列表行、看板卡）又加一遍（概览），任何一处改口径，
 * 四处就会给出不同答案——这正是最难查的那类 bug。
 *
 * 现在：服务端在**状态写入那一刻**把缘由记下来（见 task-service.updateTaskStatus），
 * 前端只在这里读它。旧行 `blockedReason` 为 NULL，则回退到原先那套 `blockedBy` 推断，
 * **行为与引入该字段之前逐字一致**，所以不需要数据迁移。
 */
import type { TaskInfo } from '../api.ts';

export type BlockedReasonValue = 'deps' | 'hold';

type BlockedShape = Pick<TaskInfo, 'blockedReason' | 'blockedBy'>;

/**
 * 判定一张 blocked 卡的缘由。
 *
 * @param lookupDep 依赖查找（旧数据回退时用）。不传时按「有依赖 = deps」处理 ——
 *   不知道依赖状态就不要替用户判断「这件事需要你」，宁可让它留在依赖里。
 */
export function blockedReasonOf(
  task: BlockedShape,
  lookupDep?: (id: string) => { status: string } | undefined,
): BlockedReasonValue {
  // 1) 服务端记下的缘由是事实，直接用它。
  if (task.blockedReason === 'deps' || task.blockedReason === 'hold') return task.blockedReason;

  // 2) 旧数据：沿用它当年的推断口径 ——
  //    没有依赖却说 blocked，或者依赖全都完成了却仍 blocked，都意味着「引擎本该恢复却没恢复」，
  //    这时才真的需要人看一眼。
  const deps = task.blockedBy ?? [];
  if (deps.length === 0) return 'hold';
  if (!lookupDep) return 'deps';
  const allDone = deps.every(id => lookupDep(id)?.status === 'completed');
  return allDone ? 'hold' : 'deps';
}

/** 是否需要**人**现在动手。概览据此决定要不要把这张卡放进「等你处理」。 */
export function needsHumanDecision(
  task: BlockedShape,
  lookupDep?: (id: string) => { status: string } | undefined,
): boolean {
  return blockedReasonOf(task, lookupDep) === 'hold';
}
