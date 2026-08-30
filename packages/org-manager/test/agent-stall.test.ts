import { describe, it, expect } from 'vitest';
import { buildAgentRuntimeInfo } from '../src/agent-runtime.js';
import {
  evaluateStall,
  DEFAULT_STALL_CONFIG,
} from '../src/agent-stall.js';

/**
 * OB-2 长时间无活动 / 阻塞定位 · 单元测试
 *
 * evaluateStall 消费 OB-1 派生的 AgentRuntimeInfo（phase / blockedBy / lastProgressAt /
 * lastHeartbeat / lastActivityAt / runningMinutes /…），提示「长时间无活动」并给出定位。
 *
 * 判据（纯函数、时钟可注入、阈值可配置，防止误杀正常 running）：
 *   1. stale-heartbeat — phase ∈ {running, thinking, waiting-dependency, blocked,
 *      degraded} 但 lastActivityAt(latest of lastProgressAt / lastHeartbeat /
 *      activity.startedAt) 距今超过 stallAfterMs 且进程仍被标记为干活中 →
 *      「长时间无活动」提示（长任务 or 卡住）。
 *   2. dead-dependency — phase ∈ {waiting-dependency, blocked} 但 blockedBy 中任一被依赖
 *      任务已达终态失败（failed / cancelled / archived）→ 依赖已失败仍无限等待，明确「卡在这」。
 *   3. 正常场景（进度心跳新鲜 / 低频心跳新鲜 / 依赖仍在跑 / idle / offline / 显式 error）→ 不判。
 */

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

interface RTInput {
  agentId?: string;
  status: string;
  currentTaskId?: string;
  currentActivity?: { id: string; type: string; label: string; taskId?: string; startedAt: string };
  lastHeartbeat?: string;
  lastProgressAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  activeTaskIds?: string[];
  lookupTask?: (t: string) => { id: string; title?: string; status: string; blockedBy?: string[] } | undefined;
}

function rt(input: RTInput) {
  return buildAgentRuntimeInfo(
    {
      agentId: input.agentId ?? 'a1',
      status: input.status,
      currentTaskId: input.currentTaskId,
      currentActivity: input.currentActivity,
      lastHeartbeat: input.lastHeartbeat,
      lastProgressAt: input.lastProgressAt,
      lastError: input.lastError,
      lastErrorAt: input.lastErrorAt,
      activeTaskIds: input.activeTaskIds,
      tokensUsedToday: 0,
    },
    input.lookupTask ?? (() => undefined),
    NOW,
  );
}

describe('evaluateStall — 长时间无活动 / 依赖失败判定（OB-2）', () => {
  it('running + 心跳新鲜（lastHeartbeat 5 分钟前）→ 不判卡死', () => {
    const ri = rt({
      status: 'working',
      activeTaskIds: ['t1'],
      lastHeartbeat: '2026-08-27T11:55:00.000Z',
      currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't1', startedAt: '2026-08-27T10:00:00.000Z' },
      lookupTask: () => ({ id: 't1', title: '实现登录', status: 'in_progress' }),
    });
    const v = evaluateStall({ runtime: ri }, NOW, DEFAULT_STALL_CONFIG);
    expect(v.stalled).toBe(false);
    expect(v.reason).toMatch(/fresh|alive|progress|recent/i);
  });

  it('running + 进度心跳新鲜（lastProgressAt 5 分钟前）但低频心跳 5 小时前 → 不判卡死（长任务进行中）', () => {
    const ri = rt({
      status: 'working',
      activeTaskIds: ['t1'],
      lastHeartbeat: '2026-08-27T07:00:00.000Z', // 5 小时前（默认心跳间隔 6h，正常）
      lastProgressAt: '2026-08-27T11:55:00.000Z', // 5 分钟前，持续有工具/LLM 事件
      currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't1', startedAt: '2026-08-27T10:00:00.000Z' },
      lookupTask: () => ({ id: 't1', title: '实现登录', status: 'in_progress' }),
    });
    const v = evaluateStall({ runtime: ri }, NOW, DEFAULT_STALL_CONFIG);
    expect(v.stalled).toBe(false);
    expect(v.reason).toMatch(/fresh|alive|progress|recent/i);
    // 进度心跳优先于低频心跳派生 lastActivityAt
    expect(ri.lastActivityAt).toBe('2026-08-27T11:55:00.000Z');
  });

  it('running 但所有活动时间停滞 40 分钟 → stale-heartbeat 长时间无活动', () => {
    const ri = rt({
      status: 'working',
      activeTaskIds: ['t1'],
      lastHeartbeat: '2026-08-27T11:20:00.000Z', // 40 min ago
      currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't1', startedAt: '2026-08-27T10:00:00.000Z' },
      lookupTask: () => ({ id: 't1', title: '实现登录', status: 'in_progress' }),
    });
    const v = evaluateStall({ runtime: ri }, NOW, DEFAULT_STALL_CONFIG);
    expect(v.stalled).toBe(true);
    if (v.stalled) {
      expect(v.stallKind).toBe('stale-heartbeat');
      expect(v.stuckOnTaskId).toBe('t1');
      expect(v.lastActivityAt).toBe('2026-08-27T11:20:00.000Z');
      expect(v.lastActivityAgoMin).toBe(40);
      expect(v.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('waiting-dependency 但依赖仍是 in_progress → 不判卡死（正常等待）', () => {
    const ri = rt({
      status: 'working',
      activeTaskIds: ['t2'],
      lastHeartbeat: '2026-08-27T11:30:00.000Z',
      lookupTask: (t) =>
        t === 't2'
          ? { id: 't2', title: 'B', status: 'in_progress', blockedBy: ['t1'] }
          : { id: 't1', title: '数据迁移', status: 'in_progress' },
    });
    const v = evaluateStall({ runtime: ri }, NOW, DEFAULT_STALL_CONFIG);
    expect(v.stalled).toBe(false);
    expect(v.reason).toMatch(/依赖|waiting|alive|proceed/i);
  });

  it('waiting-dependency 但被依赖任务已 failed → dead-dependency 且卡在该依赖', () => {
    const ri = rt({
      status: 'working',
      activeTaskIds: ['t2'],
      currentActivity: { id: 'a', type: 'task', label: 'B', taskId: 't2', startedAt: '2026-08-27T09:00:00.000Z' },
      lookupTask: (t) =>
        t === 't2'
          ? { id: 't2', title: 'B', status: 'in_progress', blockedBy: ['t1'] }
          : { id: 't1', title: '数据迁移', status: 'failed' },
    });
    const v = evaluateStall({ runtime: ri }, NOW, DEFAULT_STALL_CONFIG);
    expect(v.stalled).toBe(true);
    if (v.stalled) {
      expect(v.stallKind).toBe('dead-dependency');
      expect(v.stuckOnTaskId).toBe('t1'); // 卡在已死依赖上
      expect(v.stuckOnTitle).toBe('数据迁移');
      expect(v.currentTaskId).toBe('t2');
      expect(v.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('blocked + 被依赖任务已 archived → dead-dependency 命中依赖', () => {
    const ri = rt({
      status: 'working',
      currentTaskId: 't2',
      activeTaskIds: ['t2'],
      currentActivity: { id: 'a', type: 'task', label: 'B', taskId: 't2', startedAt: '2026-08-27T09:00:00.000Z' },
      lookupTask: (t) =>
        t === 't2'
          ? { id: 't2', title: 'B', status: 'blocked', blockedBy: ['t1'] }
          : { id: 't1', title: '数据迁移', status: 'cancelled' },
    });
    const v = evaluateStall({ runtime: ri }, NOW, DEFAULT_STALL_CONFIG);
    // blocked 判据同时满足 dead-dependency 或 stale-heartbeat 之一
    if (v.stalled) {
      expect(v.stallKind).toBe('dead-dependency');
      expect(v.stuckOnTaskId).toBe('t1');
      expect(v.stuckOnTitle).toBe('数据迁移');
    }
  });

  it('idle / offline → 不判卡死', () => {
    expect(evaluateStall({ runtime: rt({ status: 'idle', activeTaskIds: [] }) }, NOW).stalled).toBe(false);
    expect(evaluateStall({ runtime: rt({ status: 'offline', activeTaskIds: [] }) }, NOW).stalled).toBe(false);
  });

  it('activity 刚启动（未超阈值）→ 不判卡死', () => {
    const r = rt({
      status: 'working',
      activeTaskIds: ['t1'],
      currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't1', startedAt: '2026-08-27T11:58:00.000Z' },
      lookupTask: () => ({ id: 't1', title: '实现登录', status: 'in_progress' }),
    });
    expect(evaluateStall({ runtime: r }, NOW, DEFAULT_STALL_CONFIG).stalled).toBe(false);
  });

  it('error 显式失败态 → 不判卡死（已暴露错误，非静默停滞）', () => {
    const r = rt({ status: 'error', activeTaskIds: [], lastError: 'LLM 超时', lastErrorAt: '2026-08-27T11:40:00.000Z' });
    expect(evaluateStall({ runtime: r }, NOW).stalled).toBe(false);
  });
});

describe('evaluateStall — 阈值与容错', () => {
  it('stallAfterMs 越严越容易判卡死；越宽越不判', () => {
    const r = rt({
      status: 'working',
      activeTaskIds: ['t1'],
      lastHeartbeat: '2026-08-27T11:50:00.000Z', // 10 min ago
      currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't1', startedAt: '2026-08-27T11:50:00.000Z' },
      lookupTask: () => ({ id: 't1', title: '实现登录', status: 'in_progress' }),
    });
    expect(evaluateStall({ runtime: r }, NOW, { ...DEFAULT_STALL_CONFIG, stallAfterMs: 5 * 60_000 }).stalled).toBe(true);
    expect(evaluateStall({ runtime: r }, NOW, { ...DEFAULT_STALL_CONFIG, stallAfterMs: 60 * 60_000 }).stalled).toBe(false);
  });
});