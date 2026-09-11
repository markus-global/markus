/**
 * 会话连续性「真链路」冒烟门禁（进 CI 必过）。
 *
 * 与 `conversation-session-invariants.test.ts` 的分工：
 *  - 不变量套件逐条钉**语义**（跨 worker、懒加载、告警、不串线）；
 *  - 本文件只做一件事：把**真实链路**（`sendMessageStream` → mailbox → worker →
 *    restore/绑定 → LLM）连续跑两轮，确认第二轮仍然看得到第一轮。
 *
 * 为什么单列一道门禁：这条链路的失败模式是「跨线程状态作用域」（HTTP 线程写、
 * worker 读），单元测试天然覆盖不到；而它一旦回归，用户看到的就是「agent 失忆、
 * 得先调 session 工具才能干活」。所以它必须是必过项，而不是靠人工发现。
 *
 * 同时覆盖「重启后」：新 AgentManager + 新 MemoryStore 指向同一 dataDir。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import { COMPLETION_MARKER, getTextContent, type LLMRequest } from '@markus/shared';
import type { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;
let savedEnv: Record<string, string | undefined>;

/** 记录每轮真正送进 LLM 的 prompt 与该轮使用的内存会话 id。 */
interface RecordedCall {
  sessionId?: string;
  text: string;
}

function makeRecordingRouter() {
  const calls: RecordedCall[] = [];
  const record = (request: LLMRequest, options?: { sessionId?: string }) => {
    const messages = request.messages.map(m => ({ role: String(m.role), text: getTextContent(m.content) }));
    calls.push({ sessionId: options?.sessionId, text: messages.map(m => m.text).join('\n') });
  };

  const router = {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async (request: LLMRequest, _p?: string, options?: { sessionId?: string }) => {
      record(request, options);
      return { content: `reply ${COMPLETION_MARKER}`, finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    chatStream: vi.fn(async (
      request: LLMRequest,
      onEvent?: (event: { type: string; content?: string }) => void,
      _provider?: string,
      _signal?: AbortSignal,
      options?: { sessionId?: string },
    ) => {
      record(request, options);
      onEvent?.({ type: 'text_delta', content: `reply ${COMPLETION_MARKER}` });
      return { content: `reply ${COMPLETION_MARKER}`, finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getActiveModelName: vi.fn(() => 'claude-smoke'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
    ensureMarkusCatalogLoaded: vi.fn(async () => {}),
  } as unknown as LLMRouter;

  return { router, calls };
}

function createManager(llmRouter: LLMRouter) {
  return new AgentManager({ llmRouter, roleLoader, dataDir, eventBus: new EventBus() });
}

/** 只读访问 agent 内部（测试专用）：内存会话列表 + 历史读取。 */
function internalsOf(agent: Agent) {
  return agent as unknown as {
    memory: { listSessions(): Array<{ id: string }> };
    requestHistory(sessionId: string): Array<{ content: string }>;
  };
}

const NOOP_EVENT = () => {};

/** 与 api-server 实际下发的形状保持一致：显式 DB session id + sessionRestore。 */
function turn(agent: Agent, text: string, sessionId: string, sessionRestore: unknown) {
  return agent.sendMessageStream(
    text,
    NOOP_EVENT,
    'user_smoke',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { sessionRestore: sessionRestore as never, sessionId },
  );
}

beforeEach(() => {
  // 隔离环境：本机若有 OPENAI_API_KEY，语义检索会真打 embedding 接口并挂 ~10s，
  // 把冒烟门禁拖到超时（CI 噪声会掩盖真实失败）。
  savedEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY };
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_API_KEY;

  dataDir = mkdtempSync(join(tmpdir(), 'markus-smoke-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-smoke-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nSession continuity smoke role.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- idle');
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('会话连续性冒烟（真实链路：mailbox → worker → restore/绑定）', () => {
  it('同一会话连续两轮：第二轮必须看到第一轮的历史，且不新建内存会话', { timeout: 30000 }, async () => {
    const { router, calls } = makeRecordingRouter();
    const manager = createManager(router);
    const agent = await manager.createAgent({ name: 'Smoke A', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);

    const CS = 'cs_smoke_continue';
    try {
      // ── 第一轮：新会话（api-server 对「新对话」下发 sessionRestore: null + 新 DB id）
      await turn(agent, '第一轮 SMOKE_TURN1', CS, null);
      const mem1 = agent.getMemorySessionIdForDbSession(CS);
      expect(mem1, '新会话首轮也必须落 DB→memory 绑定').toBeTruthy();

      // ── 第二轮：同会话（api-server 下发 DB 历史 + 绑定后的内存会话 id）
      await turn(agent, '第二轮 SMOKE_TURN2', CS, {
        dbSessionId: CS,
        messages: [
          { role: 'user', content: '第一轮 SMOKE_TURN1' },
          { role: 'assistant', content: 'reply' },
        ],
        preferredMemorySessionId: mem1,
      });

      // 第二轮真正送进 LLM 的 prompt 必须包含第一轮的内容。
      const turn2 = calls.filter(c => c.text.includes('SMOKE_TURN2'));
      expect(turn2.length, '第二轮必须真的发起了 LLM 调用').toBeGreaterThan(0);
      expect(turn2[turn2.length - 1]!.text, '第二轮必须看到第一轮的历史').toContain('SMOKE_TURN1');

      // 会话身份没漂：整条链路仍然绑在同一个内存会话上。
      expect(agent.getMemorySessionIdForDbSession(CS), '不得为第二轮新建内存会话').toBe(mem1);
      expect(turn2[turn2.length - 1]!.sessionId, 'LLM 调用必须带绑定的内存会话 id').toBe(mem1);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  it('DB id 不得被当作内存会话 key（无 split-brain）', { timeout: 30000 }, async () => {
    const { router } = makeRecordingRouter();
    const manager = createManager(router);
    const agent = await manager.createAgent({ name: 'Smoke B', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);

    const CS = 'cs_smoke_splitbrain';
    try {
      await turn(agent, '第一轮 SPLIT_TURN1', CS, null);
      await turn(agent, '第二轮 SPLIT_TURN2', CS, {
        dbSessionId: CS,
        messages: [{ role: 'user', content: '第一轮 SPLIT_TURN1' }],
        preferredMemorySessionId: agent.getMemorySessionIdForDbSession(CS),
      });

      const ids = internalsOf(agent).memory.listSessions().map(s => s.id);
      expect(ids.some(id => id.startsWith('cs_')), `不得存在以 cs_* 为 id 的内存会话：${ids.join(',')}`).toBe(false);
      const mem = agent.getMemorySessionIdForDbSession(CS);
      expect(mem?.startsWith('sess_'), '绑定必须指向 sess_* 内存会话').toBe(true);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  it('重启后（新 manager + 同 dataDir）仍能看到历史，而不是从瘦 DB 重建', { timeout: 30000 }, async () => {
    const first = makeRecordingRouter();
    const manager1 = createManager(first.router);
    const agent1 = await manager1.createAgent({ name: 'Smoke Restart', roleName: 'developer', tools: [] });
    await manager1.startAgent(agent1.id);

    const CS = 'cs_smoke_restart';
    let mem1: string | null = null;
    try {
      await turn(agent1, '重启前 RESTART_TURN1', CS, null);
      mem1 = agent1.getMemorySessionIdForDbSession(CS);
      expect(mem1).toBeTruthy();
    } finally {
      await manager1.stopAgent(agent1.id);
    }

    // ── 模拟重启：全新 manager（新 MemoryStore，同一 dataDir）+ 新 agent 实例
    const second = makeRecordingRouter();
    const manager2 = createManager(second.router);
    const agent2 = await manager2.createAgent({ name: 'Smoke Restart', roleName: 'developer', tools: [] });
    await manager2.startAgent(agent2.id);
    try {
      await turn(agent2, '重启后 RESTART_TURN2', CS, {
        dbSessionId: CS,
        messages: [
          { role: 'user', content: '重启前 RESTART_TURN1' },
          { role: 'assistant', content: 'reply' },
        ],
        preferredMemorySessionId: mem1,
      });

      const calls = second.calls.filter(c => c.text.includes('RESTART_TURN2'));
      expect(calls.length, '重启后的轮次必须真的发起 LLM 调用').toBeGreaterThan(0);
      expect(calls[calls.length - 1]!.text, '重启后必须仍能看到历史').toContain('RESTART_TURN1');
    } finally {
      await manager2.stopAgent(agent2.id);
    }
  });
});
