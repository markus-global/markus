/**
 * C10-B —— external_source 工具面（镜像 address-tools 模式，契约 D11）。
 *
 * 判据：
 *   · 三个工具 register/list/toggle，结构化 JSON 回声（bounced/forbidden 带 hint）；
 *   · 身份永远来自 ctx（agent 不能在 args 里冒充别的 agentId/orgId）；
 *   · 所有权裁决在端口（唯一写者 org-manager service），工具只做表面语义 + 透传；
 *   · kind 闭集 {webhook, rss}，非法输入本地 bounced（不浪费端口调用）。
 *
 * base（37c817aa）上必须红：模块不存在。
 */
import { describe, it, expect } from 'vitest';
import { createExternalSourceTools, type ExternalSourceToolContext } from '../src/tools/external-source-tools.js';

function fakeCtx(over: Partial<ExternalSourceToolContext> = {}) {
  const calls: Array<{ op: string; input: unknown }> = [];
  const ctx: ExternalSourceToolContext = {
    agentId: 'agt_self',
    orgId: 'acme',
    register: (input) => { calls.push({ op: 'register', input }); return { status: 'registered', source: { id: 'src_1' } }; },
    list: (input) => { calls.push({ op: 'list', input }); return [{ id: 'src_1', kind: 'webhook', address: 'hook.acme@markus.global', enabled: true }]; },
    toggle: (input) => { calls.push({ op: 'toggle', input }); return { status: 'toggled', enabled: input.enabled }; },
    ...over,
  };
  return { ctx, calls };
}

const tool = (ctx: ExternalSourceToolContext, name: string) => {
  const t = createExternalSourceTools(ctx).find(x => x.name === name);
  expect(t, `工具 ${name} 必须存在`).toBeDefined();
  return t!;
};

describe('C10-B：external_source 工具面', () => {
  it('恰好三个工具：register / list / toggle', () => {
    const { ctx } = fakeCtx();
    expect(createExternalSourceTools(ctx).map(t => t.name).sort()).toEqual([
      'external_source_list', 'external_source_register', 'external_source_toggle',
    ]);
  });

  it('register：身份来自 ctx（args 里的 agent_id/org_id 被忽略，不能冒充）', async () => {
    const { ctx, calls } = fakeCtx();
    const out = JSON.parse(await tool(ctx, 'external_source_register').execute({
      kind: 'webhook', address: 'hook.acme@markus.global', agent_id: 'agt_victim', org_id: 'globex',
    }));
    expect(out.status).toBe('registered');
    expect(calls[0]!.input).toMatchObject({ orgId: 'acme', agentId: 'agt_self', kind: 'webhook', address: 'hook.acme@markus.global' });
  });

  it('register：非法 kind / 缺 address → 本地 bounced + hint（不调端口）', async () => {
    const { ctx, calls } = fakeCtx();
    const t = tool(ctx, 'external_source_register');
    const badKind = JSON.parse(await t.execute({ kind: 'email', address: 'hook.acme@markus.global' }));
    expect(badKind.status).toBe('bounced');
    expect(typeof badKind.hint).toBe('string');
    const noAddr = JSON.parse(await t.execute({ kind: 'rss' }));
    expect(noAddr.status).toBe('bounced');
    expect(calls).toHaveLength(0);
  });

  it('list：只列自己的源（ctx 身份透传）', async () => {
    const { ctx, calls } = fakeCtx();
    const out = JSON.parse(await tool(ctx, 'external_source_list').execute({}));
    expect(Array.isArray(out.sources ?? out)).toBe(true);
    expect(calls[0]!.input).toMatchObject({ orgId: 'acme', agentId: 'agt_self' });
  });

  it('toggle：所有权裁决在端口 —— forbidden 原样透传（工具不替端口猜）', async () => {
    const { ctx } = fakeCtx({ toggle: () => ({ status: 'forbidden', hint: 'not your source' }) });
    const out = JSON.parse(await tool(ctx, 'external_source_toggle').execute({ source_id: 'src_other', enabled: false }));
    expect(out.status).toBe('forbidden');
    expect(out.hint).toBe('not your source');
  });

  it('toggle：合法调用透传 sourceId + enabled（kill switch 可操作面）', async () => {
    const { ctx, calls } = fakeCtx();
    const out = JSON.parse(await tool(ctx, 'external_source_toggle').execute({ source_id: 'src_1', enabled: false }));
    expect(out.status).toBe('toggled');
    expect(calls[0]!.input).toMatchObject({ orgId: 'acme', agentId: 'agt_self', sourceId: 'src_1', enabled: false });
  });

  it('toggle：缺 source_id / enabled 非布尔 → bounced + hint', async () => {
    const { ctx, calls } = fakeCtx();
    const t = tool(ctx, 'external_source_toggle');
    expect(JSON.parse(await t.execute({ enabled: false })).status).toBe('bounced');
    expect(JSON.parse(await t.execute({ source_id: 'src_1', enabled: 'no' })).status).toBe('bounced');
    expect(calls).toHaveLength(0);
  });
});
