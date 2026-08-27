/**
 * agent-runtime.ts — OB-1 任务运行轨迹可见（O 域可观测性）
 *
 * 把「笼统的思考中」展开为可读、可定位的 agent 运行阶段（phase）：
 *   idle / thinking / running / waiting-dependency / degraded / blocked / error / offline
 *
 * - phase 由 agent 的 live state（status + currentActivity + activeTaskIds）**派生**，
 *   不改动共享类型 AgentStatus（保持向后兼容）。
 * - blockedBy 用 taskService.getTask 把「依赖任务的 taskId」回填为「依赖任务标题 + 状态」，
 *   让概览页能「一眼定位阻塞点」。
 * - 纯函数、无副作用，便于在 idle/running/blocked 三种情形下做确定性单测。
 */
import type { AgentState } from '@markus/shared';

export type AgentRuntimePhase =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'waiting-dependency'
  | 'degraded'
  | 'blocked'
  | 'error'
  | 'offline';

export interface AgentBlockedByInfo {
  /** blocked-by 任务的 id */
  taskId: string;
  /** blocked-by 任务的标题（未知时回退为 taskId） */
  title: string;
  /** blocked-by 任务当前状态（pending / in_progress / blocked / …） */
  status: string;
}

export interface AgentRuntimeInfo {
  agentId: string;
  phase: AgentRuntimePhase;
  /** 原始 AgentStatus（idle / working / offline / error） */
  status: string;
  /** 正在做的活动类型（task / chat / heartbeat / a2a / …） */
  activityType?: string;
  /** 正在做的可读活动描述（“执行任务 X” / “与 XX 对话” / “心跳巡检”） */
  activityLabel?: string;
  /** 正在执行/等待的任务 id */
  currentTaskId?: string;
  /** 加载中的任务 id 列表 */
  activeTaskIds: string[];
  /** 正在阻塞本 agent 的依赖任务 id 列表（= blockedBy[].taskId） */
  blockingTaskIds: string[];
  /** 阻塞依赖明细（含标题与状态）— 用于「卡在依赖 XX」 */
  blockedBy: AgentBlockedByInfo[];
  /** 当前活动起始时间（ISO） */
  startedAt?: string;
  /** 距 startedAt 的分钟数（用于「已运行 X 分钟」；无起始则为 undefined） */
  runningMinutes?: number;
  /** 最后心跳/最近活动时间（ISO，来自 state.lastHeartbeat） */
  lastHeartbeat?: string;
  /** 以 lastHeartbeat 为准的「最后活动于 HH:mm」原始值，前端本地化展示 */
  lastActivityAt?: string;
  tokensUsedToday: number;
  lastError?: string;
  lastErrorAt?: string;
}

export interface MinimalTask {
  id: string;
  title: string;
  status: string;
  blockedBy?: string[];
}

/** 出现最近错误后，仍视为 degraded（而非干净 running）的时间窗口 */
const DEGRADED_WINDOW_MS = 5 * 60 * 1000;

function firstDefined(...xs: Array<string | undefined | null>): string | undefined {
  for (const x of xs) if (x) return x;
  return undefined;
}

/**
 * 派生一个 agent 的运行时信息。
 *
 * @param input  来自 agent state / summary 的实时字段
 * @param lookupTask  按 taskId 查 MinimalTask（对活动/activeTask 的 blockedBy 回填标题） ——
 *                    传 () => undefined 时可安全地把该 agent 视为无阻塞。
 * @param now  可注入的时钟，便于测试「已运行 X 分钟」。
 */
export function buildAgentRuntimeInfo(
  input: {
    agentId: string;
    status?: string;
    activeTaskCount?: number;
    activeTaskIds?: string[];
    currentTaskId?: string;
    currentActivity?: AgentState['currentActivity'];
    lastHeartbeat?: string;
    tokensUsedToday?: number;
    lastError?: string;
    lastErrorAt?: string;
  },
  lookupTask: (taskId: string) => MinimalTask | undefined = () => undefined,
  now: number = Date.now(),
): AgentRuntimeInfo {
  const status = input.status ?? 'offline';
  const activeTaskIds =
    input.activeTaskIds && input.activeTaskIds.length > 0
      ? [...input.activeTaskIds]
      : input.currentTaskId
        ? [input.currentTaskId]
        : [];

  // 把当前挂起任务的 blockedBy 回填为「标题 + 状态」，做成「卡在依赖 XX」。
  const blockedBy: AgentBlockedByInfo[] = [];
  const seenBlocked = new Set<string>();
  // 当前挂起任务自身是否被标记为 blocked —— 决定 phase=blocked（真·阻塞）还是
  // waiting-dependency（任务就绪但依赖未完成）。
  let currentTaskSelfBlocked = false;
  for (const tid of activeTaskIds) {
    const task = lookupTask(tid);
    if (task?.status === 'blocked') currentTaskSelfBlocked = true;
    for (const depId of task?.blockedBy ?? []) {
      if (seenBlocked.has(depId)) continue;
      seenBlocked.add(depId);
      const dep = lookupTask(depId);
      blockedBy.push({
        taskId: depId,
        title: dep?.title || depId,
        status: dep?.status ?? 'unknown',
      });
    }
  }

  // ── phase 派生 ──
  let phase: AgentRuntimePhase;
  if (status === 'offline') {
    phase = 'offline';
  } else if (status === 'error') {
    phase = 'error';
  } else if (status === 'working') {
    if (blockedBy.length > 0) {
      // 当前任务自身被标 blocked → 卡死在依赖上；否则仅等待依赖完成。
      phase = currentTaskSelfBlocked ? 'blocked' : 'waiting-dependency';
    } else if (input.currentActivity || activeTaskIds.length > 0) phase = 'running';
    else phase = 'thinking'; // 已在劳作但活动未落库 —— 温和而 non-笼统 working
  } else if (status === 'idle') {
    // idle 但仍有 currentActivity：活动未能清理（脏状态的一种），仍展示进度而非静默。
    phase = input.currentActivity ? 'thinking' : 'idle';
  } else {
    phase = 'idle';
  }

  // degraded：working 系 phase + 近期报过错 → 提示留意而非纯 running。
  if ((phase === 'running' || phase === 'thinking' || phase === 'waiting-dependency') &&
      input.lastErrorAt) {
    const errTs = Date.parse(input.lastErrorAt);
    if (!Number.isNaN(errTs) && now - errTs < DEGRADED_WINDOW_MS) phase = 'degraded';
  }

  const startedAt = input.currentActivity?.startedAt;
  const startedTs = startedAt ? Date.parse(startedAt) : NaN;
  const runningMinutes =
    !Number.isNaN(startedTs) && startedTs > 0 && now >= startedTs
      ? Math.max(0, Math.floor((now - startedTs) / 60_000))
      : undefined;

  const lastHeartbeat = firstDefined(input.lastHeartbeat) ?? undefined;
  const lastActivityAt = firstDefined(lastHeartbeat, input.currentActivity?.startedAt) ?? undefined;

  return {
    agentId: input.agentId,
    phase,
    status,
    activityType: input.currentActivity?.type,
    activityLabel: input.currentActivity?.label,
    currentTaskId: firstDefined(input.currentTaskId, input.currentActivity?.taskId) ?? undefined,
    activeTaskIds,
    blockingTaskIds: blockedBy.map((b) => b.taskId),
    blockedBy,
    startedAt,
    runningMinutes,
    lastHeartbeat,
    lastActivityAt,
    tokensUsedToday: input.tokensUsedToday ?? 0,
    lastError: input.lastError,
    lastErrorAt: input.lastErrorAt,
  };
}