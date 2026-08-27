/**
 * agent-stall.ts — OB-2 卡顿/卡死定位（O 域可观测性，问题 33/34）
 *
 * 在 OB-1 的 agent-runtime.ts（运行阶段 phase / 最近心跳 / 阻塞依赖标题）之上，
 * 增加「疑似卡死」判定与可定位归因，把「一直转圈 / 不清楚卡在哪」变成
 * 「明确提示：卡在依赖 XX / 心跳停滞 N 分钟 / 最近错误」。
 *
 * 判定（纯函数、时钟可注入、阈值可配置，防误杀正常 running）：
 *   1. stale-heartbeat — phase ∈ {running, thinking, waiting-dependency, blocked,
 *      degraded} 但 lastActivityAt（=max(lastHeartbeat, activity.startedAt, errorAt)）
 *      距今超过 stallAfterMs 且仍被标记干活中 → 疑似卡死（停在原地不动）。
 *   2. dead-dependency — phase ∈ {waiting-dependency, blocked} 且 blockedBy 中任一
 *      被依赖任务已达终态失败（failed / cancelled / archived）→ 依赖已死仍无限等待，
 *      明确「卡在这」并给出被卡任务（currentTaskId）。
 *
 * 本模块不写状态、不自动清理（自动兜底是 OB-3 的职责），只负责「定位+提示」。
 * 与 OB-1/OB-3 同风格：源头数据来自 agent live state，无副作用。
 */
import type { AgentRuntimeInfo } from './agent-runtime.js';

// ─── 配置 ───────────────────────────────────────────────────────────────────
export interface StallConfig {
  /**
   * 无「最近心跳 / 活动 / 错误」进展超过该时长，phase 仍为干活系（running/thinking/
   * waiting-dependency/blocked/degraded）→ 判 stale-heartbeat。默认 10 分钟。
   */
  stallAfterMs: number;
}

export const DEFAULT_STALL_CONFIG: StallConfig = {
  stallAfterMs: 10 * 60_000, // 10 分钟无任何活动进展视为疑似卡死
};

// ─── 判定结果 ────────────────────────────────────────────────────────────────
export type AgentStallKind =
  | 'stale-heartbeat'
  | 'dead-dependency';

export type AgentStallVerdict =
  | { stalled: false; reason: string }
  | {
      stalled: true;
      /** 命中哪条判据 */
      stallKind: AgentStallKind;
      /** 卡住的任务/依赖 id（stale-heartbeat=当前任务；dead-dependency=已死依赖） */
      stuckOnTaskId: string;
      /** 卡住的定位标题 */
      stuckOnTitle: string;
      /** 当前（被卡）任务 id */
      currentTaskId?: string;
      /** 最后活动时间（ISO） */
      lastActivityAt?: string;
      /** 最后活动距今分钟数 */
      lastActivityAgoMin?: number;
      /** 最近一次错误概要（如有） */
      lastError?: string;
      /** 给前端/人工的可读定位 + 建议动作 */
      stuckReason: string;
      suggestions: string[];
    };

/** 被依赖任务视为「已死」的终态失败集合 */
const DEAD_DEP_STATUSES = new Set(['failed', 'cancelled', 'archived']);

/** 心跳停滞判定适用的 phase —— 「应该在动但没动」的集合 */
const ACTIVITY_PHASES = new Set<string>([
  'running',
  'thinking',
  'waiting-dependency',
  'blocked',
  'degraded',
]);

function parseTs(iso?: string): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

function firstDefined(...xs: Array<string | undefined | null>): string | undefined {
  for (const x of xs) if (x) return x;
  return undefined;
}

/**
 * 派生「最后活动时间 + 距今分钟数」。
 * 顺序：lastActivityAt（OB-1 已取 lastHeartbeat 或 activity.startedAt）> lastHeartbeat > lastErrorAt > startedAt。
 */
function lastActivityInfo(runtime: AgentRuntimeInfo, nowMs: number): { at?: string; agoMin?: number } {
  const last = firstDefined(runtime.lastActivityAt, runtime.lastHeartbeat, runtime.lastErrorAt, runtime.startedAt);
  if (!last) return {};
  const t = parseTs(last);
  if (Number.isNaN(t) || nowMs < t) return { at: last, agoMin: 0 };
  return { at: last, agoMin: Math.floor((nowMs - t) / 60_000) };
}

/**
 * 判定某 agent 是否「疑似卡死」，给出可定位归因。
 *
 * @param input.runtime  OB-1 派生的 AgentRuntimeInfo（phase / blockedBy / …）
 * @param now            可注入时钟（ms epoch），保证可测性
 * @param cfg            阈值配置（stallAfterMs 可调，防误杀）
 */
export function evaluateStall(
  input: { runtime: AgentRuntimeInfo },
  now: number = Date.now(),
  cfg: StallConfig = DEFAULT_STALL_CONFIG,
): AgentStallVerdict {
  const r = input.runtime;
  const nowMs = Number.isFinite(now) ? now : Date.now();

  // ── 判据 1：依赖已死仍等待（dead-dependency）—— 优先级最高，最明确「卡在这」。──
  const waitPhase = r.phase === 'waiting-dependency' || r.phase === 'blocked';
  if (waitPhase && r.blockedBy && r.blockedBy.length > 0) {
    const deadDep = r.blockedBy.find((b) => DEAD_DEP_STATUSES.has(b.status));
    if (deadDep) {
      return {
        stalled: true,
        stallKind: 'dead-dependency',
        stuckOnTaskId: deadDep.taskId,
        stuckOnTitle: deadDep.title,
        currentTaskId: r.currentTaskId,
        lastError: r.lastError,
        stuckReason: `依赖任务「${deadDep.title}」已 ${deadDep.status}，但仍被当作未完成依赖无限等待`,
        suggestions: [
          '检查该依赖为何 failed/cancelled/archived，必要时重跑该依赖',
          '若依赖无法恢复，可解除当前任务的 blockedBy 或取消当前任务释放 agent',
          `查看被卡任务 ${r.currentTaskId ?? '(未知)'} 的最近事件确认无其他异常`,
        ],
      };
    }
    // 依赖信息齐全但都在正常状态 → 明确在「等依赖」，不算卡死（正常等待推进）。
    // 说明：waiting/blocked 且依赖存活时，心跳停滞是「等待」而非「卡死在原地」，
    // 故不落到 stale-heartbeat，避免误报。
    return {
      stalled: false,
      reason: `waiting on dependency but all deps are alive (statuses: ${r.blockedBy.map((b) => b.status).join(',')}) — normal wait, not stalled`,
    };
  }

  // ── 判据 2：拥有行为的 phase 但最后活动长期停滞（stale-heartbeat）── ─┐
  if (ACTIVITY_PHASES.has(r.phase)) {
    const info = lastActivityInfo(r, nowMs);
    if (!info.at) {
      return {
        stalled: true,
        stallKind: 'stale-heartbeat',
        stuckOnTaskId: firstDefined(r.currentTaskId, r.activeTaskIds[0]) ?? '',
        stuckOnTitle: firstDefined(r.activityLabel, r.currentTaskId) ?? '(未知任务)',
        currentTaskId: r.currentTaskId,
        lastError: r.lastError,
        stuckReason: `phase=${r.phase} 但无任何最近心跳/活动时间戳，疑似卡死无从定位`,
        suggestions: ['查看该 agent 的最近事件流，确认其是否还在行进', '若无进展，可人工停止该 agent 或重启其容器'],
      };
    }
    // 距今超过阈值 → 卡死；仍在阈值内 → 不算（给了合理 Grace）
    const agoMin = info.agoMin ?? 0;
    if (nowMs - parseTs(info.at) >= cfg.stallAfterMs) {
      return {
        stalled: true,
        stallKind: 'stale-heartbeat',
        stuckOnTaskId: firstDefined(r.currentTaskId, r.activeTaskIds[0]) ?? '',
        stuckOnTitle: firstDefined(r.activityLabel, r.currentTaskId) ?? '(未知任务)',
        currentTaskId: r.currentTaskId,
        lastError: r.lastError,
        lastActivityAt: info.at,
        lastActivityAgoMin: agoMin,
        stuckReason: `已超 ${Math.round(cfg.stallAfterMs / 60_000)} 分钟无新活动（最后活动于 ${agoMin} 分钟前），phase=${r.phase} 但仍被标记为处理中`,
        suggestions: [
          '确认确认 LLM / 工具调用是否卡住（查看最近事件流与错误）',
          '若网络/模型超时，可在 Agent 设置中重试或重置该任务',
          '恢复正常后 agent 应返回 idle；持续异常建议人工介入',
        ],
      };
    }
    // 未超阈值 → 正常；
  }

  // 其余情况——正常进展 / 空闲 / 已显式失败：不判卡死。
  return { stalled: false, reason: 'no stall signal — activity is fresh or phase does not imply stuck processing' };
}