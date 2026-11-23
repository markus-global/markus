/**
 * C10-B Part G：外部信号源能力的**装配唯一执行点**（agent-manager）。
 *
 * 三条判据（缺一条就是「一半 agent 有工具、一半没有」的老事故）：
 *   1. 未接端口 ⇒ `external_source_*` 三个工具**一个都不注册**（fail-closed：
 *      不存在的能力不暴露，镜像 address-tools / facts 的纪律）；
 *   2. 接了端口 ⇒ **createAgent 与 restoreAgent 两条路径**都注册三个工具
 *      （重启后存量 agent 走 restoreAgent —— 只补一条路径就是全体失能）；
 *   3. `setAddressLookup` 真的转发到 agent 的 mailbox：mailbox 唯一解析器把
 *      `to=<markus 地址>` 的外部信号路由到 active 绑定；未转发时同一信号落
 *      `no_active_target` 退信。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { ExternalSourcePort } from '../src/tools/external-source-tools.js';

const EXTERNAL_SOURCE_TOOLS = ['external_source_register', 'external_source_list', 'external_source_toggle'];

const ADDR = 'hook.acme@markus.global';
const MARKUS_TO = { kind: 'markus' as const, address: ADDR, local: 'hook', orgSlug: 'acme' };
const EXTERNAL_FROM = { kind: 'external' as const, address: 'sender@ext.example' };

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;
let managers: AgentManager[];

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(async function* () {
      yield { type: 'done', content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getActiveModelName: vi.fn(() => 'claude-test'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
  } as unknown as LLMRouter;
}

function createManager(): AgentManager {
  const manager = new AgentManager({
    llmRouter: makeMockRouter(),
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
  managers.push(manager);
  return manager;
}

/** 只满足装配所需的端口替身；归属/持久化语义由 org-manager 服务的测试覆盖。 */
function fakePort(): ExternalSourcePort & { register: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> } {
  return {
    register: vi.fn(() => ({ status: 'registered', source: { id: 'src_fake' } })),
    list: vi.fn(() => [{ id: 'src_fake', kind: 'webhook', address: ADDR, enabled: true }]),
    toggle: vi.fn(() => ({ status: 'toggled', enabled: false })),
  } as never;
}

function restoreRow(id: string) {
  return {
    id,
    name: `Restored ${id}`,
    roleId: 'developer',
    roleName: 'Developer',
    orgId: 'org_ext',
    teamId: null,
    agentRole: 'worker' as const,
    skills: '[]',
    status: 'offline',
    llmConfig: JSON.stringify({ modelMode: 'custom', primary: 'anthropic' }),
    heartbeatIntervalMs: 900000,
    createdAt: new Date().toISOString(),
    tokensUsedToday: 0,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-extwiring-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-extwiring-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nWrites code.');
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) await manager.stopAllAgents?.().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('C10-B：外部源能力装配（fail-closed + 两条建 agent 路径）', () => {
  it('未接端口 ⇒ 建出来的 agent 一个 external_source_* 工具都没有（不注册空能力）', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_ext', tools: [] });

    for (const name of EXTERNAL_SOURCE_TOOLS) {
      expect(agent.getTools().has(name), `${name} 不该在未接端口时存在`).toBe(false);
    }
  });

  it('运行期补装端口 ⇒ 已存在的 agent 立刻拿到三个工具（补装也走同一装配点）', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_ext', tools: [] });

    manager.setExternalSourcePort(fakePort());

    for (const name of EXTERNAL_SOURCE_TOOLS) {
      expect(agent.getTools().has(name), `补装端口后 ${name} 必须立刻可用`).toBe(true);
    }
  });

  it('createAgent 路径：端口在场时三个工具当场注册，身份来自 ctx（不带进 args）', async () => {
    const manager = createManager();
    const port = fakePort();
    manager.setExternalSourcePort(port);

    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_ext', tools: [] });

    for (const name of EXTERNAL_SOURCE_TOOLS) {
      expect(agent.getTools().has(name), `${name} 必须在建立时注册`).toBe(true);
    }
    // 工具只是端口翻译：args 里的 agent_id 不参与（身份来自装配时的 ctx）。
    await agent.getTools().get('external_source_register')!.execute({
      kind: 'webhook', address: ADDR, agent_id: 'agt_impostor', org_id: 'org_impostor',
    });
    expect(port.register).toHaveBeenCalledWith({
      orgId: 'org_ext', agentId: agent.id, kind: 'webhook', address: ADDR, config: undefined,
    });
  });

  it('restoreAgent 路径（重启后存量 agent）：三个工具同样注册 —— 两条路径都走装配点', async () => {
    const manager = createManager();
    const port = fakePort();
    manager.setExternalSourcePort(port);

    const restored = await manager.restoreAgent(restoreRow('agt_restored_ext'));

    for (const name of EXTERNAL_SOURCE_TOOLS) {
      expect(restored.getTools().has(name), `restoreAgent 后 ${name} 必须存在（否则重启即全体失能）`).toBe(true);
    }
    await restored.getTools().get('external_source_list')!.execute({});
    expect(port.list).toHaveBeenCalledWith({ orgId: 'org_ext', agentId: 'agt_restored_ext' });
  });

  it('setAddressLookup 转发到 agent 的 mailbox：同一信号在接线后从退信变成投递', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_ext', tools: [] });
    const box = agent.getMailbox();

    const enqueue = (messageId: string) =>
      box.enqueue('external_signal', { summary: 's', content: 'c' }, {
        origin: { from: EXTERNAL_FROM, to: MARKUS_TO, messageId },
      });

    // 未接线：markus 地址没有 active 绑定 ⇒ 唯一解析器交 no_active_target 退信。
    const before = enqueue('wh-before');
    expect(before.status).toBe('catch_all');
    expect(before.dropReason).toBe('no_active_target');

    manager.setAddressLookup({
      findActive: (addr: string) => (addr === ADDR ? { agentId: agent.id, targetRef: `agent:${agent.id}` } : undefined),
    });

    // 接线后（同一个 mailbox 实例，不经第二条装配路径）⇒ 解析命中本 agent，投递成立。
    const after = enqueue('wh-after');
    expect(after.status).toBe('queued');
    expect(box.depth).toBe(1);
  });

  it('setAddressLookup 在端口之前/之后装配都成立（顺序无关：applyExternalSource 两条分支各自生效）', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_ext', tools: [] });

    manager.setAddressLookup({
      findActive: (addr: string) => (addr === ADDR ? { agentId: agent.id, targetRef: `agent:${agent.id}` } : undefined),
    });
    manager.setExternalSourcePort(fakePort());

    const item = agent.getMailbox().enqueue('external_signal', { summary: 's', content: 'c' }, {
      origin: { from: EXTERNAL_FROM, to: MARKUS_TO, messageId: 'wh-late' },
    });
    expect(item.status).toBe('queued');
    expect(agent.getTools().has('external_source_list')).toBe(true);
  });
});
