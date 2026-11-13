/**
 * 第六刀 C1 —— 地址自助工具面（`bind_address` / `address_revoke` / `address_list`）。
 *
 * 断言的是**返回体**：Agent 看不到日志，只能靠返回值建模，所以「没绑上」必须是
 * 一个有名字的状态，而不是 `false` 或抛异常。
 */
import { describe, it, expect, vi } from 'vitest';
import { createAddressTools, parseTargetRef, type AddressToolContext } from '../src/tools/address-tools.js';
import type { AddressBindOutcome, AddressRevokeOutcome } from '@markus/shared';

const SELF = 'agt_self';
const OTHER = 'agt_other';
const ORG = 'acme';

function makeCtx(over: Partial<AddressToolContext> = {}): AddressToolContext {
  return {
    agentId: SELF,
    orgId: ORG,
    bind: vi.fn(
      (): AddressBindOutcome => ({ status: 'bound', address: 'cto.acme@markus.global', targetRef: `agent:${SELF}` }),
    ),
    revoke: vi.fn((): AddressRevokeOutcome => ({ status: 'revoked', address: 'cto.acme@markus.global' })),
    list: vi.fn(() => []),
    ...over,
  };
}

function toolOf(ctx: AddressToolContext, name: string) {
  const tool = createAddressTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe('地址工具面：注册与语义', () => {
  it('注册三个工具，且都声明了 JSON schema', () => {
    const names = createAddressTools(makeCtx()).map((t) => t.name);
    expect(names).toEqual(['bind_address', 'address_revoke', 'address_list']);
    for (const tool of createAddressTools(makeCtx())) {
      expect(tool.inputSchema['type']).toBe('object');
    }
  });

  it('bind_address 省略 target_ref ⇒ 以自己为目标、带 org 上下文', async () => {
    const ctx = makeCtx();
    const out = JSON.parse(await toolOf(ctx, 'bind_address').execute({ address: 'cto.acme@markus.global' }));
    expect(out.status).toBe('bound');
    expect(ctx.bind).toHaveBeenCalledWith({ orgId: ORG, agentId: SELF, address: 'cto.acme@markus.global' });
  });

  it('I5：bind_address 指向别人的 target_ref ⇒ forbidden（不改写成自己）', async () => {
    const ctx = makeCtx();
    const out = JSON.parse(
      await toolOf(ctx, 'bind_address').execute({
        address: 'cto.acme@markus.global',
        target_ref: `agent:${OTHER}`,
      }),
    );
    expect(out.status).toBe('forbidden');
    expect(out.hint).toMatch(/Only your own target/i);
    // 拒绝必须发生在写之前：端口一次都没被调用。
    expect(ctx.bind).not.toHaveBeenCalled();
  });

  it('I5：显式传自己（agent:<self> 或裸 id）都放行', async () => {
    const ctx = makeCtx();
    await toolOf(ctx, 'bind_address').execute({ address: 'cto.acme@markus.global', target_ref: `agent:${SELF}` });
    await toolOf(ctx, 'bind_address').execute({ address: 'cto.acme@markus.global', target_ref: SELF });
    expect(ctx.bind).toHaveBeenCalledTimes(2);
  });

  it('解析失败原样透传结构化退信（reason/detail/hint/catchAllId）', async () => {
    const bounced: AddressBindOutcome = {
      status: 'bounced',
      address: 'conduct@markus.global',
      reason: 'unresolved_address',
      detail: 'platform_reserved',
      hint: 'Organisations cannot claim it; bind <local>.<org>@markus.global instead.',
      catchAllId: null,
    };
    const ctx = makeCtx({ bind: vi.fn(() => bounced) });
    const out = JSON.parse(await toolOf(ctx, 'bind_address').execute({ address: 'conduct@markus.global' }));
    expect(out).toEqual(bounced);
  });

  it('缺参数 ⇒ bounced/malformed，且不触发写路径、不抛异常', async () => {
    const ctx = makeCtx();
    const out = JSON.parse(await toolOf(ctx, 'bind_address').execute({}));
    expect(out).toMatchObject({ status: 'bounced', detail: 'malformed' });
    expect(ctx.bind).not.toHaveBeenCalled();
  });

  it('address_revoke 委托端口；空参数同样给结构化退信', async () => {
    const ctx = makeCtx();
    expect(JSON.parse(await toolOf(ctx, 'address_revoke').execute({ address: 'cto.acme@markus.global' })).status).toBe(
      'revoked',
    );
    expect(ctx.revoke).toHaveBeenCalledWith({
      orgId: ORG,
      agentId: SELF,
      address: 'cto.acme@markus.global',
    });
    expect(JSON.parse(await toolOf(ctx, 'address_revoke').execute({})).status).toBe('bounced');
  });

  it('address_list 把 revokedAt 映射成 status，并原样带 target_ref', async () => {
    const ctx = makeCtx({
      list: vi.fn(() => [
        { address: 'cto.acme@markus.global', targetRef: `agent:${SELF}`, revokedAt: null, createdAt: 't1' },
        { address: 'old.acme@markus.global', targetRef: `agent:${SELF}`, revokedAt: 't2', createdAt: 't0' },
      ]),
    });
    const out = JSON.parse(await toolOf(ctx, 'address_list').execute({ include_org: true }));
    expect(out.status).toBe('ok');
    expect(out.count).toBe(2);
    expect(out.bindings).toEqual([
      { address: 'cto.acme@markus.global', targetRef: `agent:${SELF}`, status: 'active', revokedAt: null, createdAt: 't1' },
      { address: 'old.acme@markus.global', targetRef: `agent:${SELF}`, status: 'revoked', revokedAt: 't2', createdAt: 't0' },
    ]);
    expect(ctx.list).toHaveBeenCalledWith({ orgId: ORG, agentId: SELF, includeOrg: true });
  });
});

describe('parseTargetRef：target_ref 的唯一解释点', () => {
  it('接受 agent:<self> 与裸 id', () => {
    expect(parseTargetRef(`agent:${SELF}`, SELF)).toEqual({ ok: true });
    expect(parseTargetRef(SELF, SELF)).toEqual({ ok: true });
  });

  it('拒绝他人与其它写法（含大小写变体）', () => {
    for (const raw of [`agent:${OTHER}`, OTHER, `AGENT:${SELF}`, `agent:${SELF} `]) {
      const result = parseTargetRef(raw, SELF);
      expect(result.ok).toBe(false);
    }
  });
});
