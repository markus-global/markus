/**
 * C9-B — 「在跑」的唯一权威是 `work_units`，不是「activity 有没有结束时间」。
 *
 * 背景（真实事故，2026-11-14）：页面用「activity 没有 `ended_at`」推断「还在跑」。
 * worker 被杀后那条 activity 永远不会补 `ended_at`，于是僵尸行在 UI 上一直显示
 * 「在跑」，而真正在跑的内部回合（requirement_* / channel_dm:* / session:*）一条
 * 都不显示。C8-E 把 `RunningWorkUnits` 面板改成了只读 work_units，但**读 activity
 * 的那几处仍在自行推断**，本轮把它们全部改指到这里。
 *
 * 设计上刻意做的一件事：`isActivityLive` **不接收 `endedAt`**。判据里读不到这个
 * 字段，就没有人能再把它当状态用 —— 比写注释要求大家别用可靠。
 *
 * 另一点：这里**不解析 ref**。`task_tsk_abc_r2` 的结构由服务端
 * `taskIdOfWorkUnitRef()` 解析后以 `taskId` 字段给出（浏览器包不能引 `@markus/shared`），
 * 客户端只做集合成员判断，避免出现第二个解析器。
 */

/** 读出面（`/api/agents/:id/work-units`）的一行，只取判定需要的字段。 */
export interface WorkUnitLivenessRow {
  ref: string;
  /** 服务端用 `taskIdOfWorkUnitRef(ref)` 解析；非 task 形态为 null/undefined。 */
  taskId?: string | null;
}

/** 判定只需要「这一行是不是工作单元」，因此接受任意带 ref 的行。 */
export function liveRefSet(units: readonly { ref: string }[]): Set<string> {
  return new Set(units.map(u => u.ref));
}

/**
 * 这条 activity 此刻是不是「在跑」。
 *
 * 判据只有一条：它**带着 WorkUnit 身份**，且该身份**出现在 running 集合里**。
 * 没有身份的行（历史行、无 WorkUnit 的旧链路）永远是历史，不主张「在跑」。
 */
export function isActivityLive(
  activity: { workUnitRef?: string | null } | null | undefined,
  liveUnitRefs: ReadonlySet<string>,
): boolean {
  const ref = activity?.workUnitRef;
  if (!ref) return false;
  return liveUnitRefs.has(ref);
}

/** 这张任务卡此刻是否有自己的执行折在跑（别的任务/聊天在跑不算）。 */
export function taskIsLive(units: readonly WorkUnitLivenessRow[], taskId: string): boolean {
  return units.some(u => u.taskId != null && u.taskId === taskId);
}
