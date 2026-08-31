/**
 * agent-dirty.ts — OB-3 无任务「处理中」脏状态自动清理/兜底（O 域可观测性）
 *
 * 问题 22「没任务但一直处理中」：agent 的 live state 被标记为 thinking/running/degraded
 * （status=working 或有 currentActivity 痕迹），但实际没有任何在跑的任务、会话、心跳或
 * 事件支撑 —— 是一种「遗留脏状态」，可能把 agent 永久卡死在假性忙碌上。
 *
 * 本模块：
 * - 纯函数 `evaluateDirtyState` 判定某 agent 当前是否为「脏态」，并给出恢复动作建议。
 * - 与 OB-1 的 agent-runtime.ts 同风格：只读 live state + 任务查询，无副作用，确定性可测。
 * - 只清 agent 运行态脏标记，不改任务调度/依赖推进逻辑（严格 O 域）。
 * - 可开关（配置 feature flag）、幂等（对非脏态永远返回 not-dirty）。
 */
import type { AgentActivity } from '@markus/shared';

// ─── 恢复动作 ────────────────────────────────────────────────────────────────
/**
 * 对脏态的兜底级恢复动作：
 * - `reconcile-idle`    有残留 currentActivity 但无真实任务 → 可安全清除该活动痕迹并回收至 idle。
 * - `trigger-heartbeat` 有 working 无活动/无任务/心跳停滞 → 先引导一次恢复心跳，让 agent 自愈。
 * - `human-review`      无法自动判定（degraded 近期报错 / 依赖存疑）→ 明确提示 + 建议人工介入。
 */
export type AgentDirtyRecovery = 'reconcile-idle' | 'trigger-heartbeat' | 'human-review';

export interface AgentDirtyConfig {
  /** 总开关（feature flag）。false 时 evaluate 恒返回 not-dirty（兜底完全关闭）。 */
  enabled: boolean;
  /** 一段「processing 痕迹」无任何真实任务支撑、持续超过该时长，才判定为脏态。 */
  staleAfterMs: number;
  /** lastHeartbeat 距今小于该值视为 agent 存活中（自巡检未停）——不判脏，避免误杀。 */
  heartbeatGraceMs: number;
}

export const DEFAULT_DIRTY_CONFIG: AgentDirtyConfig = {
  enabled: true,
  staleAfterMs: 5 * 60_000, // 5 分钟无进展
  heartbeatGraceMs: 2 * 60_000, // 心跳 2 分钟内视为存活
};

export interface AgentDirtyInput {
  agentId: string;
  /** 原始 AgentStatus（idle / working / offline / error） */
  status: string;
  /** 当前活动痕迹（thinking / running 的可读标记） */
  currentActivity?: AgentActivity | null;
  /** 加载中的任务 id 列表 */
  activeTaskIds?: string[];
  /** 最后心跳时间（ISO，可能缺失） */
  lastHeartbeat?: string;
  /** 最近一次错误时间（ISO，degraded 风险提示用） */
  lastErrorAt?: string;
}

export interface MinimalTaskForDirty {
  id: string;
  status: string;
  title?: string;
  blockedBy?: string[];
}

/**
 * 判定结果。not-dirty 时也带 reason（便于可观测日志说明为什么不算脏）。
 */
export type AgentDirtyVerdict =
  | { dirty: false; reason: string }
  | {
      dirty: true;
      /** 命中的 agent（reconcile 可据此定位恢复目标） */
      agentId: string;
      reason: string;
      /** 判定命中的判据标签（事件/前端定位用） */
      criterion: 'no-live-task' | 'stale-activity' | 'no-heartbeat';
      /** 建议的兜底恢复动作 */
      recovery: AgentDirtyRecovery;
      /** 给前端/人工的可读建议动作 */
      suggestions: string[];
    };

/** 判为「存活任务」的 task 状态集合 —— 有这些里的任一，说明 agent 有真实工作在做，不判脏。 */
const LIVE_TASK_STATUSES = new Set(['in_progress', 'review', 'blocked']);

function parseTs(iso?: string): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * 派生某 agent 的脏态判定。
 *
 * @param input       来自 agent live state 的实时字段
 * @param lookupTask  按 taskId 查任务（对 activeTaskIds 判断是否还有存活任务）；
 *                    传 () => undefined 时会把所有 activeTaskIds 视为「已死」，
 *                    便于纯单测注入确定性的任务视图。
 * @param now         可注入时钟，保证「是否超时」可测。
 * @param cfg         判定阈值/开关。
 */
export function evaluateDirtyState(
  input: AgentDirtyInput,
  lookupTask: (taskId: string) => MinimalTaskForDirty | undefined = () => undefined,
  now: number = Date.now(),
  cfg: AgentDirtyConfig = DEFAULT_DIRTY_CONFIG,
): AgentDirtyVerdict {
  const status = input.status;
  const hasActivity = !!input.currentActivity;
  const agentId = input.agentId;

  // 总开关关闭 → 不判脏。
  if (!cfg.enabled) return { dirty: false, reason: 'dirty-state cleanup disabled by config' };

  // 非「processing 系」：idle 无活动、offline、error 显式失败态 → 不算脏。
  const processingLike = status === 'working' || hasActivity;
  if (!processingLike) {
    return { dirty: false, reason: `not processing-like (status=${status}, no activity)` };
  }
  if (status === 'offline') {
    return { dirty: false, reason: 'agent offline (session liveness concern, not a stuck dirty state)' };
  }
  if (status === 'error') {
    return { dirty: false, reason: 'explicit error state — surfaces error UI, not a silent stuck dirty state' };
  }

  const nowMs = Number.isFinite(now) ? now : Date.now();

  // ① 有存活任务 → 真在干活 / 真阻塞在依赖，剔除（防误杀正常 running/blocked）。
  const activeTaskIds = input.activeTaskIds ?? [];
  const aliveTasks = activeTaskIds.filter((tid) => {
    const t = lookupTask(tid);
    if (!t) return false;
    return LIVE_TASK_STATUSES.has(t.status);
  });
  if (aliveTasks.length > 0) {
    return { dirty: false, reason: `has ${aliveTasks.length} live task(s) — genuinely processing` };
  }

  // ② 心跳新鲜 → agent 活着在自巡检，给它自愈机会，再等等。
  const lh = parseTs(input.lastHeartbeat);
  const hbFresh = !Number.isNaN(lh) && nowMs - lh < cfg.heartbeatGraceMs;
  if (hbFresh) {
    return { dirty: false, reason: 'heartbeat fresh — agent still self-patrolling' };
  }

  // ③ 当前活动刚启动（未超 staleAfterMs）→ 给时间，先别动。
  const actStartedTs = input.currentActivity?.startedAt ? parseTs(input.currentActivity.startedAt) : NaN;
  const activityStale = Number.isNaN(actStartedTs) || nowMs - actStartedTs >= cfg.staleAfterMs;

  if (hasActivity && !activityStale) {
    return { dirty: false, reason: 'activity just started — within stale window' };
  }

  // 已通过 ①② 且活动超时（或缺失）→ 命中脏态，下面细分恢复动作。
  const nosoActivity = hasActivity && activityStale;
  const blockedUnresolved = activeTaskIds.some((tid) => lookupTask(tid)?.status === 'blocked');

  // 近期报错（degraded 风险）或依赖状态可疑 → 无法安全自动回收，给人工提示。
  const lastErrAt = parseTs(input.lastErrorAt);
  const degradedRecent = !Number.isNaN(lastErrAt) && nowMs - lastErrAt < 5 * 60_000;

  if (degradedRecent || blockedUnresolved) {
    return {
      dirty: true,
      agentId,
      criterion: 'no-live-task',
      recovery: 'human-review',
      reason: `agent marked processing but has no live task${degradedRecent ? ' and recently errored' : ''}${blockedUnresolved ? ' (stale blocked dependency)' : ''}`,
      suggestions: degradedRecent
        ? ['核对最近一次错误信息，确认模型/工具是否卡死', '必要时在 Agent 设置中手动重置该 agent 的容器/进程', '恢复正常后应自动回到 idle']
        : ['检查该任务为何处于 blocked 且未被清理', '若为遗留依赖，可解除或取消以释放该 agent'],
    };
  }

  // 有残留活动痕迹（已超时）→ 可安全清掉该活动痕迹并回收至 idle。
  if (nosoActivity) {
    return {
      dirty: true,
      agentId,
      criterion: 'stale-activity',
      recovery: 'reconcile-idle',
      reason: `activity "${input.currentActivity?.label ?? input.currentActivity?.type}" stale for ${Math.round((nowMs - actStartedTs) / 1000)}s with no live task — leftover processing marker`,
      suggestions: ['自动清除该残留活动并回收至 idle', '若 agent 继续异常，可人工停止或重启'],
    };
  }

  // 仅 working 但无活动、无任务、无心跳 → 引导触发一次恢复心跳，让 agent 自愈。
  return {
    dirty: true,
    agentId,
      criterion: 'no-heartbeat',
    recovery: 'trigger-heartbeat',
    reason: 'status=working but no activity, no live task, no fresh heartbeat — stuck busy flag',
    suggestions: ['触发一次恢复心跳，让 agent 自行核对并回到 idle', '若持续如此，可人工重启该 agent'],
  };
}