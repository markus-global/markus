/**
 * 责任域工具回归。
 *
 * 最要紧的一条：**升档不能撒谎**。`autonomy=auto` 在没有审批通道时必须返回
 * `pending_approval` 且**不写库**；返回 `bound` 就等于告诉 agent 权限已到手，
 * 它会立刻按新权限动手——这是最难在生产里回溯的事故形态。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildResourceTools } from '../src/tools/resource-tools.js';
import type { ResourceToolDeps } from '../src/tools/resource-tools.js';
import type { Autonomy, ResourceBinding, ResourceScope } from '@markus/shared';

class FakeBindings {
  rows: ResourceBinding[] = [];
  /** 订阅由仓储建（与 `SqliteResourceBindingRepo.ensureSubscription` 同语义） */
  subscribeCalls = 0;
  private n = 0;

  bind(b: {
    holder: { kind: 'agent' | 'team'; id: string };
    resource: string;
    scope: ResourceScope;
    autonomy?: Autonomy;
    grantedBy: string;
  }): { ok: true; binding: ResourceBinding; subscribed: boolean } | { ok: false; reason: string } {
    const existing = this.findByHolder(b.holder.kind, b.holder.id, b.resource);
    const subscribed = b.holder.kind === 'agent';
    if (subscribed) this.subscribeCalls += 1;
    if (existing) {
      existing.scope = b.scope;
      existing.autonomy = b.autonomy ?? existing.autonomy;
      return { ok: true, binding: existing, subscribed };
    }
    if (b.scope === 'admin') {
      const taken = this.listByResource(b.resource).find(x => x.scope === 'admin');
      if (taken) {
        return {
          ok: false,
          reason: `资源 ${b.resource} 已由 ${taken.holder.kind}:${taken.holder.id} 以 admin 档负责。要接管，先让对方释放，或由人执行 transfer。`,
        };
      }
    }
    const [gKind, ...gRest] = b.grantedBy.split(':');
    const binding: ResourceBinding = {
      id: `rbd_${++this.n}`,
      holder: b.holder,
      resource: b.resource,
      scope: b.scope,
      autonomy: b.autonomy ?? 'observe',
      since: 1000,
      // 与真实仓库一致：`human:<id>` / `agent:<id>` 要保留 kind，
      // 否则「谁给的权限」这条审计信息会被静默抹成 agent。
      grantedBy: { kind: gKind === 'agent' ? 'agent' : 'human', id: gRest.join(':') },
    };
    this.rows.push(binding);
    return { ok: true, binding, subscribed };
  }
  findByHolder(kind: 'agent' | 'team', id: string, resource: string) {
    return this.rows.find(r => r.holder.kind === kind && r.holder.id === id && r.resource === resource) ?? null;
  }
  listByHolder(kind: 'agent' | 'team', id: string) {
    return this.rows.filter(r => r.holder.kind === kind && r.holder.id === id);
  }
  listByResource(resource: string) {
    return this.rows.filter(r => r.resource === resource);
  }
  unbind(id: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter(r => r.id !== id);
    return this.rows.length < before;
  }
}

let bindings: FakeBindings;
let deps: ResourceToolDeps;
let tools: ReturnType<typeof buildResourceTools>;

const tool = (name: string) => tools.find(t => t.name === name)!;
const run = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await tool(name).execute(args));

beforeEach(() => {
  bindings = new FakeBindings();
  deps = {
    agentId: 'agt_me',
    agentName: '内容高手',
    teamId: 'team_content',
    bindings,
  };
  tools = buildResourceTools(deps);
});

describe('工具面完整性', () => {
  it('四个工具都在，且都有 inputSchema', () => {
    expect(tools.map(t => t.name).sort()).toEqual([
      'resource_bind',
      'resource_owners',
      'resource_release',
      'resource_status',
    ]);
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
  });
});

describe('resource_bind', () => {
  it('非法 scope → error，不落库', async () => {
    const r = await run('resource_bind', { resource: 'xhs:brand_01', scope: 'commit' });
    expect(r.status).toBe('error');
    expect(bindings.rows).toHaveLength(0);
  });

  it('observe 档：绑定成功并自动订阅', async () => {
    const r = await run('resource_bind', { resource: 'xhs:brand_01', scope: 'publish' });
    expect(r.status).toBe('bound');
    expect(r.autonomy).toBe('observe');
    expect(r.subscribed).toBe(true);
    // 订阅的创建只发生一次，且发生在仓储的 bind() 里 —— 工具不再自己订阅。
    // （曾经两处都写：仓储写一份、工具写一份，team 绑定上两者语义还相反。）
    expect(bindings.subscribeCalls).toBe(1);
  });

  it('team 绑定：如实回 subscribed=false（不替团队编一个 agent）', async () => {
    const r = await run('resource_bind', { resource: 'xhs:brand_01', scope: 'read', for_team: true });
    expect(r.status).toBe('bound');
    expect(r.subscribed).toBe(false);
    expect(String(r.next)).toContain('团队绑定不产生 agent 订阅');
    expect(bindings.subscribeCalls).toBe(0);
  });

  it('autonomy=auto 且无审批通道 → pending_approval，且**不写库**（不许撒谎）', async () => {
    const r = await run('resource_bind', { resource: 'xhs:brand_01', scope: 'publish', autonomy: 'auto' });
    expect(r.status).toBe('pending_approval');
    expect(r.effective).toBe(false);
    expect(bindings.rows).toHaveLength(0);
    expect(bindings.subscribeCalls).toBe(0);
  });

  it('审批被拒 → rejected，且不写库', async () => {
    deps.requestApproval = async () => false;
    tools = buildResourceTools(deps);
    const r = await run('resource_bind', { resource: 'xhs:brand_01', scope: 'publish', autonomy: 'auto' });
    expect(r.status).toBe('rejected');
    expect(bindings.rows).toHaveLength(0);
  });

  it('审批通过 → 才真正落库为 auto', async () => {
    deps.requestApproval = async () => true;
    tools = buildResourceTools(deps);
    const r = await run('resource_bind', { resource: 'xhs:brand_01', scope: 'publish', autonomy: 'auto' });
    expect(r.status).toBe('bound');
    expect(bindings.rows[0]?.autonomy).toBe('auto');
  });

  it('admin 冲突 → conflict 且提示里点名占用者', async () => {
    bindings.bind({ holder: { kind: 'agent', id: 'agt_other' }, resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:o' });
    const r = await run('resource_bind', { resource: 'gh:o/r', scope: 'admin' });
    expect(r.status).toBe('conflict');
    expect(r.reason).toContain('agt_other');
  });

  it('for_team 绑定记在团队名下', async () => {
    await run('resource_bind', { resource: 'rss:a', scope: 'read', for_team: true });
    expect(bindings.rows[0]?.holder).toEqual({ kind: 'team', id: 'team_content' });
  });
});

describe('resource_release', () => {
  it('解自己的绑定成功', async () => {
    await run('resource_bind', { resource: 'xhs:brand_01', scope: 'draft' });
    const r = await run('resource_release', { resource: 'xhs:brand_01' });
    expect(r.status).toBe('released');
    expect(bindings.rows).toHaveLength(0);
  });

  it('解别人的绑定 → error 并列出真正负责人（不越权）', async () => {
    bindings.bind({ holder: { kind: 'agent', id: 'agt_other' }, resource: 'gh:o/r', scope: 'publish', grantedBy: 'human:o' });
    const r = await run('resource_release', { resource: 'gh:o/r' });
    expect(r.status).toBe('error');
    expect(r.error).toContain('agt_other');
    expect(bindings.rows).toHaveLength(1);
  });

  it('本来就没绑 → error 且不误删别的资源', async () => {
    const r = await run('resource_release', { resource: 'xhs:nothing' });
    expect(r.status).toBe('error');
  });
});

describe('resource_owners', () => {
  it('只读列出负责人与档位，并标出 admin 是否已被占', async () => {
    bindings.bind({ holder: { kind: 'agent', id: 'agt_a' }, resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:o' });
    bindings.bind({ holder: { kind: 'agent', id: 'agt_b' }, resource: 'gh:o/r', scope: 'read', grantedBy: 'human:o' });
    const r = await run('resource_owners', { resource: 'gh:o/r' });
    expect(r.owners).toHaveLength(2);
    expect(r.exclusiveScopeTaken).toBe(true);
    expect(r.owners[0].grantedBy).toBe('human:o');
  });
});

describe('resource_status', () => {
  it('没绑定 → 明确说「不负责任何资源」，不编造', async () => {
    const r = await run('resource_status');
    expect(r.count).toBe(0);
    expect(r.message).toContain('不负责任何');
  });

  it('有绑定 → 列出 scope/autonomy；无活动数据时标 recentUnknown 而不是空数组', async () => {
    await run('resource_bind', { resource: 'xhs:brand_01', scope: 'publish' });
    const r = await run('resource_status');
    expect(r.count).toBe(1);
    expect(r.bindings[0].resource).toBe('xhs:brand_01');
    expect(r.bindings[0].recentUnknown).toBe(true);
    expect(r.bindings[0].recent).toBeNull();
  });

  it('注入 recentActivity 后会带出最近事件', async () => {
    deps.recentActivity = () => ['3 条新评论待回'];
    tools = buildResourceTools(deps);
    await run('resource_bind', { resource: 'xhs:brand_01', scope: 'publish' });
    const r = await run('resource_status');
    expect(r.bindings[0].recent).toEqual(['3 条新评论待回']);
    expect(r.bindings[0].recentUnknown).toBe(false);
  });
});
