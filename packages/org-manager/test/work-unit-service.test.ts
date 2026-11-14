/**
 * 第七刀 C7-A —— `WorkUnitService` 的业务纪律（纯内存端口，不起库）。
 *
 * 这里锁三件「实现一改坏就会变红」的事：
 *   1. 写失败**不打断业务**，但必须留下**结构化事件**（禁止用日志文本断言）；
 *   2. `work_status()` 的答案来自对象查询 —— 父子关系、认领者、预算都来自行，
 *      不读 payload；
 *   3. 非法迁移抛结构化错误，而不是被 try/catch 吞成「业务照常」。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WorkUnitService,
  type WorkUnitPort,
  type WorkUnitEvent,
} from '../src/work-unit-service.js';
import type { WorkUnitRecord, WorkUnitStatus } from '@markus/shared';

/** 内存端口：只实现 service 真正依赖的形状。 */
function memoryPort(seed?: WorkUnitRecord[]): WorkUnitPort & { rows: Map<string, WorkUnitRecord> } {
  const rows = new Map<string, WorkUnitRecord>();
  for (const r of seed ?? []) rows.set(r.ref, r);
  let seq = 0;
  return {
    rows,
    ensure(input) {
      const existing = rows.get(input.ref);
      if (existing) return { row: existing, created: false };
      const row: WorkUnitRecord = {
        id: `wu_${++seq}`,
        parentId: input.parentId ?? null,
        ref: input.ref,
        agentId: input.agentId,
        addressRef: input.addressRef ?? null,
        taskId: input.taskId ?? null,
        model: input.model ?? null,
        status: input.status ?? 'running',
        budget: input.budget ?? null,
        used: 0,
        claimedBy: input.claimedBy ?? null,
        leaseUntil: input.leaseUntil ?? null,
        stopReason: null,
        resultRef: null,
        contextRef: input.contextRef ?? null,
        archivedAt: null,
      };
      rows.set(row.ref, row);
      return { row, created: true };
    },
    transition(ref, to) {
      const row = rows.get(ref);
      if (!row) throw new Error('not found');
      const next = { ...row, status: to };
      rows.set(ref, next);
      return next;
    },
    getByRef: (ref) => rows.get(ref),
    listByAgent: (agentId) => [...rows.values()].filter((r) => r.agentId === agentId),
    listChildren: (parentId) => [...rows.values()].filter((r) => r.parentId === parentId),
    linkMailboxItem: () => true,
  };
}

const wu = (over: Partial<WorkUnitRecord> & { ref: string; agentId: string }): WorkUnitRecord => ({
  id: `wu_${over.ref}`,
  parentId: null,
  addressRef: null,
  taskId: null,
  model: null,
  status: 'running',
  budget: null,
  used: 0,
  claimedBy: null,
  leaseUntil: null,
  stopReason: null,
  resultRef: null,
  contextRef: null,
  archivedAt: null,
  ...over,
});

describe('WorkUnitService.ensure —— 写失败不阻断业务，但必须可计数', () => {
  it('写失败 ⇒ 返回 null + 一条结构化事件 + failures 计数（不是静默漏记）', () => {
    const events: WorkUnitEvent[] = [];
    const port: WorkUnitPort = {
      ...memoryPort(),
      ensure() {
        throw new Error('disk full');
      },
    };
    const svc = new WorkUnitService({ repo: port, onEvent: (e) => events.push(e) });

    expect(svc.ensure({ ref: 'session:cs_1:r1', agentId: 'agt_a' })).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('work_unit.ensure_failed');
    expect(events[0]!.ref).toBe('session:cs_1:r1');
    expect(svc.getStats().failures).toBe(1);
    expect(svc.getStats().created).toBe(0);
  });

  it('建成功 ⇒ created 计数 + created 事件（失败与成功都能计数）', () => {
    const events: WorkUnitEvent[] = [];
    const svc = new WorkUnitService({ repo: memoryPort(), onEvent: (e) => events.push(e) });
    const row = svc.ensure({ ref: 'session:cs_2:r1', agentId: 'agt_a' });
    expect(row).not.toBeNull();
    expect(svc.getStats().created).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['work_unit.created']);
  });

  it('事件消费者自己抛错不会反过来打断业务', () => {
    const svc = new WorkUnitService({
      repo: memoryPort(),
      onEvent: () => { throw new Error('consumer boom'); },
    });
    expect(svc.ensure({ ref: 'session:cs_3:r1', agentId: 'agt_a' })).not.toBeNull();
  });

  it('缺 ref / agentId 直接记失败，不打数据库', () => {
    const ensure = vi.fn();
    const svc = new WorkUnitService({ repo: { ...memoryPort(), ensure } });
    expect(svc.ensure({ ref: '', agentId: 'agt_a' })).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    expect(svc.getStats().failures).toBe(1);
  });
});

describe('WorkUnitService.transition —— 矩阵是唯一判定点', () => {
  it('非法迁移抛出 code=invalid_work_unit_transition（不被吞）', () => {
    const port = memoryPort([wu({ ref: 'r1', agentId: 'agt_a', status: 'archived' })]);
    const svc = new WorkUnitService({ repo: port });
    expect(() => svc.transition('r1', 'running')).toThrowError(/not in WU_TRANSITIONS/);
  });

  it('tryTransition 对非法迁移照样抛（程序错误必须响）', () => {
    const port = memoryPort([wu({ ref: 'r1', agentId: 'agt_a', status: 'archived' })]);
    const svc = new WorkUnitService({ repo: port });
    expect(() => svc.tryTransition('r1', 'running')).toThrow();
  });

  it('tryTransition 对非矩阵失败（如库错误）吞掉 + 记事件', () => {
    const events: WorkUnitEvent[] = [];
    const port: WorkUnitPort = {
      ...memoryPort([wu({ ref: 'r2', agentId: 'agt_a' })]),
      transition() { throw new Error('database is locked'); },
    };
    const svc = new WorkUnitService({ repo: port, onEvent: (e) => events.push(e) });
    expect(svc.tryTransition('r2', 'idle')).toBeNull();
    expect(events[0]!.type).toBe('work_unit.transition_failed');
    expect(svc.getStats().failures).toBe(1);
  });
});

describe('WorkUnitService.workStatus —— 答案来自对象，不读 payload', () => {
  it('2 个在跑 WU + 1 个子 WU：字段齐全、父子关系正确', () => {
    const parent = wu({ ref: 'session:cs_p:r1', agentId: 'agt_a', status: 'running', budget: 30, used: 7, claimedBy: 'worker-2', leaseUntil: '2026-11-13T10:00:00.000Z' });
    const second = wu({ ref: 'session:cs_p:r2', agentId: 'agt_a', status: 'idle', budget: 20, used: 20 });
    const child = wu({
      ref: 'a2a:dm:a:b:dlv_1',
      agentId: 'agt_a',
      status: 'running',
      parentId: parent.id,
    });
    const svc = new WorkUnitService({ repo: memoryPort([parent, second, child]) });

    const report = svc.workStatus('agt_a');
    expect(report.agentId).toBe('agt_a');
    expect(report.count).toBe(3);

    const byRef = new Map(report.units.map((u) => [u.ref, u]));
    expect(byRef.get('session:cs_p:r1')).toEqual({
      ref: 'session:cs_p:r1',
      status: 'running',
      parentId: null,
      claimedBy: 'worker-2',
      leaseUntil: '2026-11-13T10:00:00.000Z',
      budget: 30,
      used: 7,
    });
    expect(byRef.get('session:cs_p:r2')!.status).toBe('idle');
    expect(byRef.get('a2a:dm:a:b:dlv_1')!.parentId).toBe(parent.id);

    expect(svc.children(parent.id).map((c) => c.ref)).toEqual(['a2a:dm:a:b:dlv_1']);
  });

  it('不返回别的 agent 的 WU（"我现在有哪些 WU 在跑"必须只答自己的）', () => {
    const svc = new WorkUnitService({
      repo: memoryPort([
        wu({ ref: 'r_a', agentId: 'agt_a' }),
        wu({ ref: 'r_b', agentId: 'agt_b' }),
      ]),
    });
    expect(svc.workStatus('agt_b').units.map((u) => u.ref)).toEqual(['r_b']);
  });
});

describe('WorkUnitService.linkMailboxItem —— 先实体后引用', () => {
  it('无 itemId ⇒ 直接跳过（不猜「最近一条」）', () => {
    const link = vi.fn();
    const svc = new WorkUnitService({ repo: { ...memoryPort(), linkMailboxItem: link } });
    expect(svc.linkMailboxItem(undefined, 'r1')).toBe(false);
    expect(link).not.toHaveBeenCalled();
  });

  it('行不存在（0 行被改）⇒ 结构化 link_failed 事件', () => {
    const events: WorkUnitEvent[] = [];
    const svc = new WorkUnitService({
      repo: { ...memoryPort(), linkMailboxItem: () => false },
      onEvent: (e) => events.push(e),
    });
    expect(svc.linkMailboxItem('mbx_1', 'r1')).toBe(false);
    expect(events[0]!.type).toBe('work_unit.link_failed');
    expect(events[0]!.itemId).toBe('mbx_1');
  });

  it('写库抛错 ⇒ 吞掉 + 记事件（观测设施不得成为业务故障点）', () => {
    const events: WorkUnitEvent[] = [];
    const svc = new WorkUnitService({
      repo: { ...memoryPort(), linkMailboxItem: () => { throw new Error('locked'); } },
      onEvent: (e) => events.push(e),
    });
    expect(svc.linkMailboxItem('mbx_2', 'r1')).toBe(false);
    expect(events.some((e) => e.type === 'work_unit.link_failed')).toBe(true);
  });
});

describe('状态集合完整性（防止矩阵被改成「只有 running」）', () => {
  const ALL: WorkUnitStatus[] = ['running', 'idle', 'paused_budget', 'terminated', 'archived'];
  it('五个状态都能落库并被读回', () => {
    for (const status of ALL) {
      const svc = new WorkUnitService({ repo: memoryPort([wu({ ref: `r_${status}`, agentId: 'agt_a', status })]) });
      expect(svc.workStatus('agt_a').units[0]!.status).toBe(status);
    }
  });
});