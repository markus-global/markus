import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * 回归验证（tsk_1920780cb2af9064f77e133f）
 *
 * 验证 T1（tsk_ce3c59bf，提示词口径收敛：产出物=面向人的交付，代码文件路径写进正文）后：
 *   1) 「多文件代码改动」以 1 份 markdown 交付文档提交时，产出物条目 = 1，不随改动文件数线性增长；
 *   2) 提交链路对 deliverables 数组是 1:1 透传（无隐性的逐文件展开 / 去重合并 / 复制）；
 *   3) 独立 Deliverable 实体的生成次数 == 提交条目数（无隐藏的第二登记路径）。
 */

const AGENT_A = 'agent-a';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    title: 'Task',
    description: 'Do something',
    assignedAgentId: AGENT_A,
    reviewerId: REVIEWER,
    ...overrides,
  };
}

function mockAgentManager() {
  const makeAgent = (id: string) => ({
    config: { name: id, orgId: ORG, agentRole: id === REVIEWER ? 'manager' : 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => ({ status: 'idle', activeTaskCount: 0 })),
    sendTaskExecution: vi.fn(async () => {}),
  });
  const map = new Map([
    [AGENT_A, makeAgent(AGENT_A)],
    [REVIEWER, makeAgent(REVIEWER)],
  ]);
  return {
    hasAgent: vi.fn((id: string) => map.has(id)),
    getAgent: vi.fn((id: string) => {
      const a = map.get(id);
      if (!a) throw new Error(`Agent not found: ${id}`);
      return a;
    }),
    listAgents: vi.fn(() => [{ id: AGENT_A, role: 'worker' }]),
  };
}

function buildService() {
  const ts = new TaskService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts.setAgentManager(mockAgentManager() as any);
  ts.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return ts;
}

describe('产出物口径回归：只登记人类关心的交付', () => {
  it('多文件代码改动 → 1 份 markdown 交付文档：产出物条目 = 1（不随文件数膨胀）', async () => {
    const ts = buildService();
    const create = vi.fn(async (d: Record<string, unknown>) => ({ id: `dlv_${create.mock.calls.length}`, ...d }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ts.setDeliverableService({ create } as any);

    const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
    ts.approveTask(task.id, 'user-1');

    // 模拟「一个小型多文件改动」：真实改了 8 个代码文件
    const changedCodeFiles = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'];
    // 按新口径提交：只登记 1 份 markdown 交付文档（正文列出上述文件路径）
    const humanFacingDoc = {
      type: 'file' as const,
      reference: '/Users/x/ws/tsk-demo-deliverable-report.md',
      summary: `交付文档：本次改动共 ${changedCodeFiles.length} 个代码文件（路径见正文）+ 验证结论`,
    };

    await ts.submitForReview(task.id, [humanFacingDoc]);

    const t = ts.getTask(task.id)!;
    expect(t.status).toBe('review');
    expect(t.deliverables).toHaveLength(1); // 条目数 = 人类交付数，而非改动文件数(8)
    expect(create).toHaveBeenCalledTimes(1); // 独立实体只建 1 个，无逐文件登记
    expect(t.deliverables![0].reference).toBe(humanFacingDoc.reference);
  });

  it('透传不变形：提交 N 条 → 记录恰好 N 条（无隐性展开/去重/复制）', async () => {
    const ts = buildService();
    const create = vi.fn(async (d: Record<string, unknown>) => ({ id: `dlv_${create.mock.calls.length}`, ...d }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ts.setDeliverableService({ create } as any);

    const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
    ts.approveTask(task.id, 'user-1');

    const N = 5;
    const dels = Array.from({ length: N }, (_, i) => ({
      type: 'file' as const,
      reference: `/out/doc-${i + 1}.md`,
      summary: `human-facing doc ${i + 1}`,
    }));

    await ts.submitForReview(task.id, dels);

    const t = ts.getTask(task.id)!;
    expect(t.deliverables).toHaveLength(N);
    expect(create).toHaveBeenCalledTimes(N);
    expect(t.deliverables!.map(d => d.reference)).toEqual(dels.map(d => d.reference));
  });

  it('空产出物：提交 0 条时不建独立实体、任务仍进入 review', async () => {
    const ts = buildService();
    const create = vi.fn(async (d: Record<string, unknown>) => ({ id: 'dlv_x', ...d }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ts.setDeliverableService({ create } as any);

    const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
    ts.approveTask(task.id, 'user-1');

    await ts.submitForReview(task.id, []);

    const t = ts.getTask(task.id)!;
    expect(t.status).toBe('review');
    expect(t.deliverables ?? []).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
});
