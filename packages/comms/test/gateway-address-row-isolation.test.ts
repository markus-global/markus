/**
 * 第六刀 C1 —— 地址绑定行**绝不参与入站路由**（golden 行为的负向锁）。
 *
 * 背景：`channel_bindings` 现在同时承载「路由绑定」与「地址绑定」。地址绑定的
 * `instance_id` / `native_id` 恒为 NULL，所以在结构上不是候选；但旧实现
 * `asScope()` 把**任何未知 scope 一律归为 `global`**，一条 `scope='address'` 的行
 * 就会变成组织级兜底路由——「没人绑定」的入站消息会全部错投给那个地址的拥有者。
 *
 * 这里的断言是行为断言：走真实的 `RepoBindingLookup` + `resolveInboundTarget`，
 * 并且**对照**一条合法 `global` 行，证明修法只排除未知 scope，不动既有路由。
 */
import { describe, it, expect } from 'vitest';
import { RepoBindingLookup } from '../src/gateway/repo-binding-lookup.js';
import { resolveInboundTarget } from '../src/gateway/inbound.js';

interface BindingRow {
  scope: string;
  instanceId: string | null;
  nativeId: string | null;
  kind: string | null;
  agentId: string;
}

function makeLookup(opts: {
  bindings: BindingRow[];
  secretary?: string;
  /** 实例行必须存在，否则 channel 级绑定按设计被跳过（与本次改动无关）。 */
  instances?: Array<{ id: string; label: string; config?: Record<string, unknown> | null }>;
}): RepoBindingLookup {
  return new RepoBindingLookup({
    bindingRepo: { listByOrg: () => opts.bindings },
    instanceRepo: { listByPlatform: () => opts.instances ?? [] },
    ...(opts.secretary ? { orgDefaultAgent: () => opts.secretary } : {}),
  });
}

const addressRow: BindingRow = {
  scope: 'address',
  instanceId: null,
  nativeId: null,
  kind: 'mail',
  agentId: 'agt_address_owner',
};

describe('地址绑定行与路由隔离', () => {
  it('只有一条 scope=address 行时 → 不解析（不会变成组织级兜底路由）', () => {
    const lookup = makeLookup({ bindings: [addressRow] });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_unbound' },
      lookup,
    );
    expect(target).toBeUndefined();
  });

  it('地址行与合法 global 行共存 → 仍走 global 行（对照：修法不误伤既有路由）', () => {
    const lookup = makeLookup({
      bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agt_secretary' }, addressRow],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_unbound' },
      lookup,
    );
    expect(target?.agentId).toBe('agt_secretary');
    expect(target?.matchedScope).toBe('global');
  });

  it('地址行不会出现在 lookup.bindings() 里（未知 scope 被跳过，不是被降级）', () => {
    const lookup = makeLookup({
      bindings: [addressRow, { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_sales', kind: 'group', agentId: 'agt_sales' }],
      instances: [{ id: 'bi_1', label: 'sales-bot' }],
    });
    expect(lookup.bindings('o', 'feishu')).toEqual([
      { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_sales', kind: 'group', agentId: 'agt_sales' },
    ]);
  });

  it('channel 路由仍然优先于 global（顺序未变）', () => {
    const lookup = makeLookup({
      bindings: [
        { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agt_secretary' },
        { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_sales', kind: 'group', agentId: 'agt_sales' },
        addressRow,
      ],
      instances: [{ id: 'bi_1', label: 'sales-bot' }],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_sales', instanceId: 'bi_1' },
      lookup,
    );
    expect(target?.agentId).toBe('agt_sales');
    expect(target?.matchedScope).toBe('channel');
  });
});
