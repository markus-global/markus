import { describe, it, expect, vi } from 'vitest';
import { AgentDirtyReconciler, type AgentLiveView } from '../src/agent-dirty-reconciler.js';

describe('AgentDirtyReconciler — 脏态周期兜底（OB-3）', () => {
  const NOW = Date.parse('2026-08-28T01:00:00.000Z');
  const STALE_AGENT: AgentLiveView = {
    agentId: 'a1',
    status: 'working',
    currentActivity: { id: 'act-x', type: 'task', label: '残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
    lastHeartbeat: new Date(NOW - 30 * 60_000).toISOString(),
  };
  const CLEAN_AGENT: AgentLiveView = { agentId: 'a2', status: 'idle', activeTaskIds: [] };

  function make(opts: {
    getTask?: (id: string) => any;
    recover?: (v: any) => void;
    onNeedsHuman?: (v: any) => void;
  } = {}) {
    const events: any[] = [];
    const reconciler = new AgentDirtyReconciler({
      getTask: opts.getTask ?? (() => undefined),
      appendExecution: (e) => events.push(e),
      recover: opts.recover,
      onNeedsHuman: opts.onNeedsHuman,
    });
    return { reconciler, events };
  }

  it('脏 agent（残留活动无任务心跳停）→ 触发 recover + 写可观测事件', async () => {
    const recover = vi.fn();
    const { reconciler, events } = make({ recover });
    const out = await reconciler.scan([STALE_AGENT, CLEAN_AGENT], NOW);
    expect(out.length).toBe(1);
    expect(out[0].agentId).toBe('a1');
    expect(out[0].recovery).toBe('reconcile-idle');
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', recovery: 'reconcile-idle' }));
    // 可观测事件已写（含谁/为何/建议）
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ agentId: 'a1', sourceType: 'activity' });
    expect(events[0].metadata.recovery).toBe('reconcile-idle');
  });

  it('同一脏态在未恢复前不重复触发（去重）', async () => {
    const recover = vi.fn();
    const { reconciler } = make({ recover });
    await reconciler.scan([STALE_AGENT], NOW);
    await reconciler.scan([STALE_AGENT], NOW);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('一次 recover 未恢复（仍脏）→ 重试窗口内去重，超窗后再次尝试', async () => {
    const recover = vi.fn(); // 模拟恢复失败：不改变 agent 状态
    const { reconciler } = make({ recover });
    await reconciler.scan([STALE_AGENT], NOW);
    // 1 分钟后仍脏 → 去重窗口内不重复
    await reconciler.scan([STALE_AGENT], NOW + 60_000);
    expect(recover).toHaveBeenCalledTimes(1);
    // 6 分钟后仍脏 → 超出重试窗口，再次兜底（修复此前“一次失败永不重试”的卡死）
    await reconciler.scan([STALE_AGENT], NOW + 6 * 60_000);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('恢复后再变脏 → 重新兜底', async () => {
    const recover = vi.fn();
    const { reconciler } = make({ recover });
    await reconciler.scan([STALE_AGENT], NOW);
    // 第一轮后 a1 恢复为 idle → 不再脏 → handled 释放
    await reconciler.scan([{ ...STALE_AGENT, status: 'idle', currentActivity: null }], NOW);
    // 又变脏
    await reconciler.scan([STALE_AGENT], NOW);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('human-review → 触发 onNeedsHuman 提示而非 recover，事件标记为 error', async () => {
    const recover = vi.fn();
    const onNeedsHuman = vi.fn();
    const { reconciler, events } = make({ recover, onNeedsHuman });
    const degraded: AgentLiveView = {
      agentId: 'a9',
      status: 'working',
      currentActivity: { id: 'act-z', type: 'task', label: '报错残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
      lastErrorAt: new Date(NOW - 30_000).toISOString(),
    };
    const out = await reconciler.scan([degraded], NOW);
    expect(out[0].recovery).toBe('human-review');
    expect(recover).not.toHaveBeenCalled();
    expect(onNeedsHuman).toHaveBeenCalledTimes(1);
    expect(events[0].type).toBe('error');
  });

  it('disabled（feature flag 关）→ 直接跳过，无副作用', async () => {
    const recover = vi.fn();
    const reconciler = new AgentDirtyReconciler({
      cfg: { enabled: false },
      getTask: () => undefined,
      appendExecution: () => {},
      recover,
    });
    const out = await reconciler.scan([STALE_AGENT], NOW);
    expect(out).toEqual([]);
    expect(recover).not.toHaveBeenCalled();
  });

  it('回归：stuck-working 心跳风暴 —— 心跳宽限期内不释放重试 key，连续 N 次后升级 human-review', async () => {
    const recover = vi.fn();
    const onNeedsHuman = vi.fn();
    const { reconciler } = make({ recover, onNeedsHuman });

    // 模拟被顶死的 working：无活动、无任务、心跳每轮触发后短暂新鲜 2 分钟又变旧（宽限窗口）。
    const stuckWorking = (heartbeatAgeMs: number): AgentLiveView => ({
      agentId: 'storm',
      status: 'working',
      currentActivity: null,
      activeTaskIds: [],
      lastHeartbeat: new Date(NOW - heartbeatAgeMs).toISOString(),
    });
    const HBEAT_FRESH_MS = 60_000; // < 2min 宽限 → busy 判定新鲜

    // t0：心跳已旧 → 判脏 → 触发恢复心跳（第 1 次）
    await reconciler.scan([stuckWorking(3 * 60_000)], NOW);
    expect(recover).toHaveBeenCalledTimes(1);

    // t0+30s：心跳刚被触发 → 新鲜 → 不脏，但 status 仍是 working → key 不得释放
    await reconciler.scan([stuckWorking(HBEAT_FRESH_MS)], NOW + 30_000);
    // t0+2.5min：心跳再次变旧 → 又判脏，但距上次仅 2.5min < RETRY_AFTER_MS(5min) → 不重复触发
    await reconciler.scan([stuckWorking(3 * 60_000)], NOW + 2.5 * 60_000);
    expect(recover).toHaveBeenCalledTimes(1);

    // t0+5min、+10min：超窗重试（第 2、3 次）
    await reconciler.scan([stuckWorking(3 * 60_000)], NOW + 5 * 60_000);
    await reconciler.scan([stuckWorking(3 * 60_000)], NOW + 10 * 60_000);
    // 第 4 次越窗时仍未见效 → 升级 human-review，不再自动触发心跳
    await reconciler.scan([stuckWorking(3 * 60_000)], NOW + 15 * 60_000);
    expect(onNeedsHuman).toHaveBeenCalledTimes(1);

    // 全程没有出现「每 2 分钟一次」的密集触发（对照修复前：每次宽限窗口过后都会立即重触发）
    expect(recover.mock.calls.filter(([v]: any) => v.recovery === 'trigger-heartbeat')).toHaveLength(3);

    // agent 真正恢复 idle 后 key 释放 → 未来再变脏可重新兜底
    await reconciler.scan([{ ...stuckWorking(3 * 60_000), status: 'idle' }], NOW + 20 * 60_000);
    await reconciler.scan([stuckWorking(3 * 60_000)], NOW + 21 * 60_000);
    expect(recover).toHaveBeenCalledTimes(4);
  });
});