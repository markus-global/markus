import { describe, it, expect } from 'vitest';
import {
  evaluateDirtyState,
  DEFAULT_DIRTY_CONFIG,
  type MinimalTaskForDirty,
} from '../src/agent-dirty.js';

describe('evaluateDirtyState — 无任务「处理中」脏态判定（OB-3）', () => {
  const NOW = Date.parse('2026-08-28T01:00:00.000Z');

  // 10 分钟前开始的残留活动 —— 超过 5 分钟 stale 阈值。
  const STALE_ACT = { id: 'act-x', type: 'task', label: '残留任务', taskId: 't-dead', startedAt: new Date(NOW - 10 * 60_000).toISOString() };
  // 30 秒前刚启动的活动 —— 在 stale 窗口内。
  const FRESH_ACT = { id: 'act-y', type: 'task', label: '刚启动', startedAt: new Date(NOW - 30_000).toISOString() };

  const noTask = (): MinimalTaskForDirty | undefined => undefined;

  it('脏态判定开关关闭 → 恒 not-dirty', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', currentActivity: STALE_ACT },
      noTask,
      NOW,
      { ...DEFAULT_DIRTY_CONFIG, enabled: false },
    );
    expect(v).toMatchObject({ dirty: false });
  });

  it('idle 无活动 → not-dirty（根本不是 processing）', () => {
    const v = evaluateDirtyState({ agentId: 'a1', status: 'idle', activeTaskIds: [] }, noTask, NOW);
    expect(v).toMatchObject({ dirty: false });
  });

  it('有存活任务（in_progress）→ 真在干活，不误判脏', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', currentActivity: STALE_ACT, activeTaskIds: ['t-live'] },
      (id) => (id === 't-live' ? { id: 't-live', status: 'in_progress', title: '实活' } : undefined),
      NOW,
    );
    expect(v).toMatchObject({ dirty: false });
  });

  it('有存活任务（blocked）→ 真阻塞在依赖，不算脏', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', activeTaskIds: ['t-blk'] },
      (id) => (id === 't-blk' ? { id: 't-blk', status: 'blocked', title: '卡依赖' } : undefined),
      NOW,
    );
    expect(v).toMatchObject({ dirty: false });
  });

  it('心跳新鲜 → 存活自巡检中，不误杀', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', currentActivity: STALE_ACT, lastHeartbeat: new Date(NOW - 30_000).toISOString() },
      noTask,
      NOW,
    );
    expect(v).toMatchObject({ dirty: false });
  });

  it('活动刚启动（stale 窗口内）→ 给时间，不判脏', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', currentActivity: FRESH_ACT },
      noTask,
      NOW,
    );
    expect(v).toMatchObject({ dirty: false });
  });

  // ── 命中脏态 ──
  it('残留活动 + 无存活任务 + 心跳停滞 + 已超时 → dirty & reconcile-idle', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', currentActivity: STALE_ACT, activeTaskIds: ['t-dead'], lastHeartbeat: new Date(NOW - 30 * 60_000).toISOString() },
      noTask, // lookup 返回 undefined → t-dead 视为已死，无存活任务
      NOW,
    );
    expect(v.dirty).toBe(true);
    if (v.dirty) {
      expect(v.criterion).toBe('stale-activity');
      expect(v.recovery).toBe('reconcile-idle');
      expect(v.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('working 无活动无心跳无任务 → dirty & trigger-heartbeat', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', activeTaskIds: [] },
      noTask,
      NOW,
    );
    expect(v.dirty).toBe(true);
    if (v.dirty) {
      expect(v.criterion).toBe('no-heartbeat');
      expect(v.recovery).toBe('trigger-heartbeat');
    }
  });

  it('有残留活动 + 近期报错（degraded 风险）→ dirty & human-review（含建议动作）', () => {
    const v = evaluateDirtyState(
      {
        agentId: 'a1',
        status: 'working',
        currentActivity: STALE_ACT,
        lastErrorAt: new Date(NOW - 30_000).toISOString(),
      },
      noTask,
      NOW,
    );
    expect(v.dirty).toBe(true);
    if (v.dirty) {
      expect(v.recovery).toBe('human-review');
      expect(v.suggestions).toContain('核对最近一次错误信息，确认模型/工具是否卡死');
    }
  });

  it('activeTask 解析为 blocked 但该 agent 无其它活动 → 依赖可疑提示人工', () => {
    const v = evaluateDirtyState(
      { agentId: 'a1', status: 'working', activeTaskIds: ['t-blk2'] },
      (id) => (id === 't-blk2' ? { id: 't-blk2', status: 'blocked', title: '卡依赖', blockedBy: ['t-x'] } : undefined),
      NOW,
    );
    // blocked OR live 命中 → 判 not-dirty（真阻塞）；此用例验证 blocked 不算脏。
    expect(v).toMatchObject({ dirty: false });
  });

  it('offline / error 显式失败态 → 不算遗留脏态', () => {
    expect(evaluateDirtyState({ agentId: 'a1', status: 'offline' }, noTask, NOW)).toMatchObject({ dirty: false });
    const err = evaluateDirtyState({ agentId: 'a1', status: 'error' }, noTask, NOW);
    expect(err).toMatchObject({ dirty: false });
  });
});