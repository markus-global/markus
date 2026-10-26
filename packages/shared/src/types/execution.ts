/**
 * 执行停止原因（Execution stop reason）—— 唯一权威表示。
 *
 * ── 为什么需要这个类型（2026-10-24 根因修复）──────────────────────────────
 * 历史上「agent 执行被停」只有一个布尔 `cancelToken.cancelled`，停止**原因**
 * 从来没有被表示成数据，于是被三处独立地"猜"：
 *
 *   ① `cancelToken.cancelled = true` 有 9 个写入点，语义各不相同（任务状态迁移
 *      的正常收尾、被新纪元取代、用户点停止、SSE 断开强停、排队超时…），但落
 *      到 token 上全变成一个无差别的 `true`；
 *   ② core 侧把原因**写死**成一句文案
 *      `'Task execution was stopped externally'`；
 *   ③ task-service 从**日志条目内容字符串** `entry.content === 'cancelled'` 反推
 *      控制流（要不要写注记、要不要重放任务）。
 *
 * 后果（老板实测）：agent 正常 `task_submit_review` → 状态 `in_progress → review`
 * → `cleanupOnLeaveStatus` 把 token 置 cancelled（这是**系统自己的正常收尾**）→
 * agent 循环看到 cancelled 就 emit 一句"被外部停止" → task-service 无条件写下
 * 「[System] Task execution cancelled externally (…). Will auto-resume.」
 * 于是**已完成的任务上出现"任务被外部取消、将自动恢复"的幽灵提示**；而所谓
 * "auto-resume" 也是假话 —— 后续 `if (status !== 'in_progress') return` 直接丢弃。
 *
 * ── 修复原则 ────────────────────────────────────────────────────────────
 * 原因由**发起取消的一方**写入（write once，首个原因胜出），消费端只读它、
 * 绝不自行推断，也绝不再从日志文本里反推结构。
 *
 *   产生点 ──cancelExecutionToken(token, reason)──▶ token.stopReason
 *   消费点 ──stopReason 分派──▶ 写什么注记 / 要不要重放
 *
 * 只有「真外部中断」（见 {@link isExternalStopReason}）才允许产生用户可见的
 * 注记与恢复尝试；`lifecycle` / `superseded` 属于平台自身语义，静默写 debug 日志。
 */

export type ExecutionStopReason =
  /** 任务状态迁移导致收尾：submit review / accept / 任务取消 / 修订轮开始。
   *  **这是系统自身的语义，不是"异常中断"** —— 不得产生任何"被外部取消"的注记。 */
  | 'lifecycle'
  /** 同一任务被新的执行纪元取代（重派 / 修订轮 / 手动重跑）。旧执行作废，无需恢复。 */
  | 'superseded'
  /** 被更高优先级项抢占，任务会重新排队（真正的可恢复中断）。 */
  | 'preempted'
  /** 用户在 UI 显式点「停止」。 */
  | 'user_stop'
  /** 邮箱项「取消」/ cancel-processing 导致停止。 */
  | 'user_cancel'
  /** 客户端连接断开超过容忍窗口后被强制停止（长任务被误杀的真凶之一）。 */
  | 'disconnect'
  /** 排队/执行超时。 */
  | 'timeout'
  /** 未知（旧数据或尚未标记原因的路径）。**绝不等同于"外部取消"**。 */
  | 'unknown';

/**
 * 协作式取消令牌。**只通过 {@link cancelExecutionToken} 置位** —— 该 helper 是
 * 唯一写者，保证每次取消都带原因（机检见
 * `packages/org-manager/test/task-execution-stop-ssot.test.ts` 中「全仓扫 .cancelled = true」的用例）。
 */
export interface ExecutionCancelToken {
  cancelled: boolean;
  userStopped?: boolean;
  /** 权威停止原因。由发起取消的一方写入，消费端只读。 */
  stopReason?: ExecutionStopReason;
}

export function createCancelToken(): ExecutionCancelToken {
  return { cancelled: false };
}

/**
 * 唯一的取消写入口。
 *
 * 语义：**首个原因胜出**（幂等）。第一次置位就真的终止了执行，之后的取消请求
 * 不再有业务意义；允许覆盖会让"先 lifecycle 后 user_stop"这类竞态把一条正常
 * 收尾改写成"用户停止"，正是我们要消灭的那类误报。
 */
export function cancelExecutionToken(
  token: ExecutionCancelToken | { cancelled?: boolean; userStopped?: boolean; stopReason?: ExecutionStopReason } | undefined,
  reason: ExecutionStopReason,
  opts?: { userStopped?: boolean },
): void {
  if (!token || typeof token !== 'object') return;
  const t = token as ExecutionCancelToken;
  const alreadyStopped = t.cancelled === true;
  if (t.cancelled !== true) t.cancelled = true;
  if (opts?.userStopped) t.userStopped = true;
  if (!alreadyStopped || !t.stopReason || t.stopReason === 'unknown') {
    t.stopReason = reason;
  }
}

/**
 * 每个停止原因的**完整策略**——三个正交属性，而不是一个「是否外部中断」布尔。
 *
 * 旧抽象是一个 `EXTERNAL_STOP_REASONS` 集合，它把两件无关的事压进同一个判断：
 * 「要不要告诉用户」和「能不能自动恢复」。于是 `user_stop` 因为「该告知」被误归为
 * 「可恢复」——用户在 UI 点停止，30 秒后任务自己又跑起来了。
 *
 * 这两个问题没有任何蕴含关系：
 *   · 用户主动停止：**要告知**（他做的），**不恢复**（他的意图就是停下）
 *   · 连接超时：    **要告知**（异常），  **恢复**（活没干完）
 *   · 状态迁移：    **不告知**（正常收尾），**不恢复**
 *
 * 用 `Record<ExecutionStopReason, …>` 而不是集合：**新增一个停止原因时，
 * 你必须在这里声明它属于哪一类**，否则编译不过。集合则静默地把新成员归为
 * 「不是外部中断」，行为由「没人记得改它」决定。
 */
export interface StopPolicy {
  /** 写一条用户可见注记？（异常要告知；平台正常收尾不打扰用户） */
  readonly notifyUser: boolean;
  /** 允许自动恢复执行？（仅「活没干完」且「不是用户的终局决定」） */
  readonly resumable: boolean;
}

export const STOP_POLICY: Readonly<Record<ExecutionStopReason, StopPolicy>> = {
  // 平台自己的正常收尾：静默、不重放
  lifecycle:   { notifyUser: false, resumable: false },
  superseded:  { notifyUser: false, resumable: false },
  unknown:     { notifyUser: false, resumable: false },
  // 用户的终局决定：告知，但**绝不**替他恢复
  user_stop:   { notifyUser: true,  resumable: false },
  user_cancel: { notifyUser: true,  resumable: false },
  // 真外部中断：活没干完，告知并恢复
  preempted:   { notifyUser: true,  resumable: true  },
  disconnect:  { notifyUser: true,  resumable: true  },
  timeout:     { notifyUser: true,  resumable: true  },
};

/** 停止原因的单一解释点：调用方不得自行组合布尔。 */
export function stopPolicy(reason: ExecutionStopReason | undefined | null): StopPolicy {
  return STOP_POLICY[reason ?? 'unknown'] ?? STOP_POLICY.unknown;
}

/** 人读文案的唯一映射点（agent 侧日志/事件、task-service 注记共用）。 */
export function stopReasonLabel(reason: ExecutionStopReason | undefined | null): string {
  switch (reason) {
    case 'lifecycle': return '任务状态已迁移，本轮执行正常收尾';
    case 'superseded': return '本次执行已被新的执行轮次取代';
    case 'preempted': return '被更高优先级任务抢占';
    case 'user_stop': return '用户手动停止';
    case 'user_cancel': return '任务已被取消';
    case 'disconnect': return '客户端连接中断超时';
    case 'timeout': return '执行超时';
    case 'unknown':
    default: return '停止原因未知';
  }
}
