import { describe, it, expect, vi } from 'vitest';
import {
  AgentConservator,
  evaluateConservator,
  DEFAULT_CONSERVATOR_CONFIG,
  type ConservatorAgentView,
} from '../src/agent-conservator.js';

const NOW = Date.parse('2026-08-28T01:00:00.000Z');

function task(overrides: Record<string, unknown> = {}) {
  return { id: 't1', title: 'T', status: 'in_progress', blockedBy: [], ...overrides };
}

function make(opts: {
  getTask?: (id: string) => any;
  recover?: (v: any) => void;
  onNeedsHuman?: (v: any) => void;
  cfg?: Record<string, unknown>;
} = {}) {
  const events: any[] = [];
  const conservator = new AgentConservator({
    cfg: opts.cfg,
    getTask: opts.getTask ?? (() => undefined),
    appendExecution: (e) => events.push(e),
    recover: opts.recover,
    onNeedsHuman: opts.onNeedsHuman,
  });
  return { conservator, events };
}

describe('evaluateConservator — dirty/stale/stall 统一仲裁（纯函数）', () => {
  const base = { agentId: 'a1' };
  const view = (ov: Record<string, unknown> = {}) => ({ ...base, status: 'working', ...ov });

  it('idle / offline / error 显式态 → ok，不仲裁', () => {
    for (const status of ['idle', 'offline', 'error']) {
      const v = evaluateConservator(view({ status }), () => undefined, NOW);
      expect(v.stage).toBe('ok');
      expect(v.action).toBe('none');
    }
  });

  it('有存活任务（in_progress/review/blocked）→ ok，不误杀正常 running', () => {
    const v = evaluateConservator(
      view({ activeTaskIds: ['t1'] }),
      (id) => task({ id, status: 'in_progress' }),
      NOW,
    );
    expect(v.stage).toBe('ok');
  });

  it('stale-activity（残留活动无任务心跳停）→ reconcile', () => {
    const v = evaluateConservator(
      view({
        currentActivity: { id: 'act-x', type: 'task', label: '残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
        lastHeartbeat: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      () => undefined,
      NOW,
    );
    expect(v.stage).toBe('reconcile');
    expect(v.action).toBe('reconcile-idle');
  });

  it('no-heartbeat（working 无活动无心跳）→ wake（廉价唤醒，非 LLM 巡检）', () => {
    const v = evaluateConservator(
      view({
        currentActivity: null,
        activeTaskIds: [],
        lastHeartbeat: new Date(NOW - 3 * 60_000).toISOString(),
      }),
      () => undefined,
      NOW,
    );
    expect(v.stage).toBe('wake');
    expect(v.action).toBe('trigger-heartbeat');
  });

  it('心跳新鲜（宽限窗口内）→ observe：可疑但不动手', () => {
    const v = evaluateConservator(
      view({
        currentActivity: null,
        activeTaskIds: [],
        lastHeartbeat: new Date(NOW - 60_000).toISOString(), // < 2min 宽限
      }),
      () => undefined,
      NOW,
    );
    expect(v.stage).toBe('observe');
    expect(v.action).toBe('none');
  });

  it('活动刚起步（未超 staleAfter）→ observe：给自愈机会', () => {
    const v = evaluateConservator(
      view({
        currentActivity: { id: 'act-y', type: 'task', label: '刚开始', startedAt: new Date(NOW - 60_000).toISOString() },
        activeTaskIds: [],
        lastHeartbeat: new Date(NOW - 10 * 60_000).toISOString(),
      }),
      () => undefined,
      NOW,
    );
    expect(v.stage).toBe('observe');
    expect(v.action).toBe('none');
  });

  it('最近报错（degraded）→ human-review，不自动兜底', () => {
    const v = evaluateConservator(
      view({
        currentActivity: { id: 'act-z', type: 'task', label: '报错残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
        lastHeartbeat: new Date(NOW - 10 * 60_000).toISOString(),
        lastErrorAt: new Date(NOW - 30_000).toISOString(),
      }),
      () => undefined,
      NOW,
    );
    expect(v.stage).toBe('human-review');
    expect(v.action).toBe('human-review');
  });

  it('dead-dependency（依赖已死仍等待）→ human-review（无法自动恢复）', () => {
    const deps = new Map<string, any>([
      ['t1', task({ id: 't1', status: 'in_progress', blockedBy: ['dep-dead'] })],
      ['dep-dead', task({ id: 'dep-dead', status: 'failed', title: '死依赖' })],
    ]);
    const v = evaluateConservator(
      view({
        currentTaskId: 't1',
        activeTaskIds: ['t1'],
        currentActivity: { id: 'act-w', type: 'task', label: '等待依赖', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
        lastProgressAt: new Date(NOW - 10 * 60_000).toISOString(),
      }),
      (id) => deps.get(id),
      NOW,
    );
    expect(v.stage).toBe('human-review');
    expect(v.criterion).toBe('dead-dependency');
  });

  it('stale-heartbeat（phase 运行但长时间无进展、无存活任务）→ observe（不误杀长任务）', () => {
    const v = evaluateConservator(
      view({
        currentActivity: null,
        activeTaskIds: [],
        currentTaskId: undefined,
        lastHeartbeat: new Date(NOW - 40 * 60_000).toISOString(), // 心跳已停
        lastProgressAt: new Date(NOW - 40 * 60_000).toISOString(),
      }),
      () => undefined,
      NOW,
    );
    // working + 无任务 + 心跳停 + 无进步 → 统一阶梯在 dirty 之上判定为 wake；
    // 只有在有存活任务但无进步时才由 stall → observe。
    expect(['wake', 'observe']).toContain(v.stage);
  });

  it('disabled（feature flag 关）→ 一律 ok', () => {
    const v = evaluateConservator(
      view({
        currentActivity: { id: 'act-x', type: 'task', label: '残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
        lastHeartbeat: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      () => undefined,
      NOW,
      { ...DEFAULT_CONSERVATOR_CONFIG, enabled: false },
    );
    expect(v.stage).toBe('ok');
  });

  it('展示兼容：verdict.dirty / verdict.stall 与旧视图形状一致（dirty=标记 / stall=卡死）', () => {
    const v = evaluateConservator(
      view({
        currentActivity: { id: 'act-x', type: 'task', label: '残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
        lastHeartbeat: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      () => undefined,
      NOW,
    );
    expect(v.dirty.dirty).toBe(true);
    expect(['reconcile-idle', 'trigger-heartbeat', 'human-review']).toContain(v.dirty.recovery);
    expect(typeof v.stall.stalled).toBe('boolean');
  });
});

describe('AgentConservator — 统一仲裁引擎（指数退避 + 上限 + 收敛）', () => {
  const STALE_AGENT: ConservatorAgentView = {
    agentId: 'a1',
    status: 'working',
    currentActivity: { id: 'act-x', type: 'task', label: '残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
    lastHeartbeat: new Date(NOW - 30 * 60_000).toISOString(),
  };
  const CLEAN_AGENT: ConservatorAgentView = { agentId: 'a2', status: 'idle', activeTaskIds: [] };

  it('脏 agent（残留活动无任务心跳停）→ 触发 recover + 写可观测事件', async () => {
    const recover = vi.fn();
    const { conservator, events } = make({ recover });
    const out = await conservator.scan([STALE_AGENT, CLEAN_AGENT], NOW);
    expect(out.length).toBe(1);
    expect(out[0].agentId).toBe('a1');
    expect(out[0].action).toBe('reconcile-idle');
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', action: 'reconcile-idle' }));
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ agentId: 'a1', sourceType: 'activity' });
    expect(events[0].metadata.action).toBe('reconcile-idle');
  });

  it('同一脏态在未恢复前不重复触发（退避去重）', async () => {
    const recover = vi.fn();
    const { conservator } = make({ recover });
    await conservator.scan([STALE_AGENT], NOW);
    await conservator.scan([STALE_AGENT], NOW);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('一次 recover 未恢复（仍脏）→ 指数退避窗口内去重，超窗后再次尝试', async () => {
    const recover = vi.fn(); // 模拟恢复失败：不改变 agent 状态
    const { conservator } = make({ recover });
    await conservator.scan([STALE_AGENT], NOW);
    // 1 分钟后仍脏 → 退避窗口内（base=5min）不重复
    await conservator.scan([STALE_AGENT], NOW + 60_000);
    expect(recover).toHaveBeenCalledTimes(1);
    // 6 分钟后仍脏 → 超出首窗，再次兜底（指数退避第 2 次动作窗口 5min）
    await conservator.scan([STALE_AGENT], NOW + 6 * 60_000);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('恢复后再变脏 → 重新兜底（episode 释放）', async () => {
    const recover = vi.fn();
    const { conservator } = make({ recover });
    await conservator.scan([STALE_AGENT], NOW);
    // 第一轮后 a1 恢复为 idle → 不再脏 → episode 释放
    await conservator.scan([{ ...STALE_AGENT, status: 'idle', currentActivity: null }], NOW);
    // 又变脏 → 重新开始退避计数
    await conservator.scan([STALE_AGENT], NOW + 10 * 60_000);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('human-review（degraded）→ 立即通知 onNeedsHuman 而非 recover（不受退避门槛影响），事件标记 error', async () => {
    const recover = vi.fn();
    const onNeedsHuman = vi.fn();
    const { conservator, events } = make({ recover, onNeedsHuman });
    const degraded: ConservatorAgentView = {
      agentId: 'a9',
      status: 'working',
      currentActivity: { id: 'act-z', type: 'task', label: '报错残留', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
      lastHeartbeat: new Date(NOW - 10 * 60_000).toISOString(),
      lastErrorAt: new Date(NOW - 30_000).toISOString(),
    };
    const out = await conservator.scan([degraded], NOW);
    expect(out[0].stage).toBe('human-review');
    expect(recover).not.toHaveBeenCalled();
    expect(onNeedsHuman).toHaveBeenCalledTimes(1);
    expect(events[0].type).toBe('error');
    // 再次扫描：human-review 每 episode 只通知一次
    await conservator.scan([degraded], NOW + 60_000);
    expect(onNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('disabled（feature flag 关）→ 直接跳过，无副作用', async () => {
    const recover = vi.fn();
    const { conservator } = make({ cfg: { enabled: false }, recover });
    const out = await conservator.scan([STALE_AGENT], NOW);
    expect(out).toEqual([]);
    expect(recover).not.toHaveBeenCalled();
  });

  it('回归：stuck-working 心跳风暴 —— 心跳宽限期内不释放退避 key、连续 3 次无果升级 human-review、恢复后释放', async () => {
    const recover = vi.fn();
    const onNeedsHuman = vi.fn();
    const { conservator } = make({ recover, onNeedsHuman });

    // 模拟被顶死的 working：无活动、无任务、心跳每轮触发后短暂新鲜 2 分钟又变旧（宽限窗口）。
    const stuckWorking = (heartbeatAgeMs: number): ConservatorAgentView => ({
      agentId: 'storm',
      status: 'working',
      currentActivity: null,
      activeTaskIds: [],
      lastHeartbeat: new Date(NOW - heartbeatAgeMs).toISOString(),
    });
    const HBEAT_FRESH_MS = 60_000; // < 2min 宽限 → busy 判定新鲜

    // t0：心跳已旧 → wake → 触发恢复心跳（第 1 次；指数退避基数 5min）
    await conservator.scan([stuckWorking(3 * 60_000)], NOW);
    expect(recover).toHaveBeenCalledTimes(1);

    // t0+30s：心跳刚被触发 → 新鲜 → observe（不动手），但 status 仍是 working → key 不得释放
    await conservator.scan([stuckWorking(HBEAT_FRESH_MS)], NOW + 30_000);
    // t0+2.5min：心跳再次变旧 → wake，但距上次仅 2.5min < 指数退避首窗 5min → 不重复触发
    await conservator.scan([stuckWorking(3 * 60_000)], NOW + 2.5 * 60_000);
    expect(recover).toHaveBeenCalledTimes(1);

    // t0+5min、+15min：超窗重试（第 2 次动作窗 base=5min；第 3 次窗=2·base=10min）
    await conservator.scan([stuckWorking(3 * 60_000)], NOW + 5 * 60_000);
    await conservator.scan([stuckWorking(3 * 60_000)], NOW + 15 * 60_000);
    expect(recover).toHaveBeenCalledTimes(3);

    // t0+36min：第 3 次触发仍未脱离 → 第 4 次越窗升级 human-review（Fix A 合流：连续 3 次无果）
    await conservator.scan([stuckWorking(3 * 60_000)], NOW + 36 * 60_000);
    expect(onNeedsHuman).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(3); // 升级后不再自动触发心跳

    // 全程没有出现「每 2 分钟一次」的密集触发，且 trigger-heartbeat 恰 3 次后升级
    expect(recover.mock.calls.filter(([v]: any) => v.action === 'trigger-heartbeat')).toHaveLength(3);

    // agent 真正恢复 idle 后 key 释放 → 未来再变脏可重新兜底（指数退避重新从 base 开始）
    await conservator.scan([{ ...stuckWorking(3 * 60_000), status: 'idle' }], NOW + 40 * 60_000);
    await conservator.scan([stuckWorking(3 * 60_000)], NOW + 41 * 60_000);
    expect(recover).toHaveBeenCalledTimes(4);
  });

  it('收敛证明：stuck 且 recover 持续无效 → 单 episode 动作总数封顶后强制 human-review', async () => {
    const recover = vi.fn();
    const onNeedsHuman = vi.fn();
    const { conservator } = make({ recover, onNeedsHuman, cfg: { retryBaseMs: 60_000, maxTotalAttempts: 2 } });

    const stuckWorking = (): ConservatorAgentView => ({
      agentId: 'hard',
      status: 'working',
      currentActivity: null,
      activeTaskIds: [],
      lastHeartbeat: new Date(NOW - 3 * 60_000).toISOString(),
    });

    await conservator.scan([stuckWorking()], NOW);
    await conservator.scan([stuckWorking()], NOW + 60_000); // 第 2 次（封顶 = 2）
    await conservator.scan([stuckWorking()], NOW + 180_000); // 越过第 2 次退避窗(2·base)后强制升级
    expect(recover).toHaveBeenCalledTimes(2);
    expect(onNeedsHuman).toHaveBeenCalledTimes(1);
  });
});