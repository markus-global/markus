/**
 * 会话不变量回归测试（A 层：无密钥 / 无网络，可随 CI 常跑）。
 *
 * 本文件钉死一条真实线上 bug 的语义 ——「同一个会话里第二条消息，agent 看不到
 * 前面历史（requestHistory() 返回空）→ 得先调 session 工具才能干活」。
 *
 * 根因（本文件逐条加护栏）：
 *   R1  `currentSessionId` 是 per-worker 的（`agent.ts` getter/setter →
 *       `this.workspace()` = ALS ?? rootWorkspace）。流式 turn 只认这个指针；
 *       当后续消息由另一个 worker 处理时，指针是空的/别的会话 → 新建空会话 →
 *       历史为空。修复：`handleMessageStream(..., explicitDbSessionId)` 按
 *       「按 DB id 绑定的内存会话 > 工作区指针 > 新建」解析；`sendMessageStream`
 *       的 mailbox item `extra`/`metadata` 携带请求的 DB session id；
 *       `processMailboxItemCore` 在真正处理该 item 的工作区里写 DB→memory 绑定。
 *   R2  DB session id（`cs_*`）与内存 session id（`sess_*`）是两个 id 空间，
 *       靠 `dbSessionMap` 绑定。DB id **绝不能**直接当内存会话 key（否则同一段
 *       对话被拆到两个 store = split-brain）。
 *   R3  `MemoryStore.getRecentMessages` 曾对「未驻留会话」静默返回 [] 且不查盘，
 *       把「id 错了 / 会话被逐出」伪装成「没有历史」。修复后：未驻留先按 id 从
 *       磁盘懒加载；未知 id 或未传 id 一律告警而非静默空。
 *
 * 断言全部用**精确证据**（送进模型的真实 prompt、绑定表、磁盘文件），不靠耗时
 * 统计、不靠人肉复现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import { MemoryStore } from '../src/memory/store.js';
import { sessionWorkspaceStore, createSessionWorkspace } from '../src/session-workspace.js';
import { COMPLETION_MARKER, getTextContent, Logger, type LLMRequest } from '@markus/shared';
import type { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;
let savedEnv: Record<string, string | undefined>;

/** per-turn volatile 快照钉在 history 尾部 —— 「真实」user 消息要把它排除掉。 */
const VOLATILE_TAIL_PREFIX = '[SYSTEM] [Live context]';

// ─── 可观测的假 LLM ─────────────────────────────────────────────────────────

interface LlmCall {
  /** 本次调用服务的会话（由「当前提问」里的 TOKEN_* 判定；LLM 侧看不到 meta）。 */
  label: string;
  /** agent 传给 LLM 的内存 session id（请求上下文里带的那个）。 */
  sessionId: string | undefined;
  /** 送进模型的完整 prompt 文本。 */
  text: string;
  messages: Array<{ role: string; text: string }>;
}

interface Probe {
  router: LLMRouter;
  streamCalls: LlmCall[];
  chatCalls: LlmCall[];
}

const TOKEN_RE = /TOKEN_[A-Z0-9_]+/;

/** 「真实」user 消息 = 排除钉在尾部的 volatile 感知快照。 */
function realUserMessages(call: LlmCall): Array<{ role: string; text: string }> {
  return call.messages.filter(m => m.role === 'user' && !m.text.startsWith(VOLATILE_TAIL_PREFIX));
}

function makeRecordingRouter(): Probe {
  const streamCalls: LlmCall[] = [];
  const chatCalls: LlmCall[] = [];

  const record = (into: LlmCall[], request: LLMRequest, options?: { sessionId?: string }): LlmCall => {
    const messages = request.messages.map(m => ({ role: String(m.role), text: getTextContent(m.content) }));
    const text = messages.map(m => m.text).join('\n');
    const realUser = messages.filter(m => m.role === 'user' && !m.text.startsWith(VOLATILE_TAIL_PREFIX));
    const current = realUser[realUser.length - 1]?.text ?? '';
    const label = TOKEN_RE.exec(current)?.[0] ?? TOKEN_RE.exec(text)?.[0] ?? 'NONE';
    const call: LlmCall = { label, sessionId: options?.sessionId, text, messages };
    into.push(call);
    return call;
  };

  const chatStream = vi.fn(async (
    request: LLMRequest,
    onEvent?: (e: { type: string; text?: string }) => void,
    _provider?: string,
    _signal?: AbortSignal,
    options?: { sessionId?: string },
  ) => {
    record(streamCalls, request, options);
    onEvent?.({ type: 'text_delta', text: `reply ${COMPLETION_MARKER}` });
    return {
      content: `reply ${COMPLETION_MARKER}`,
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });

  const chat = vi.fn(async (
    request: LLMRequest,
    _provider?: string,
    options?: { sessionId?: string },
  ) => {
    record(chatCalls, request, options);
    return {
      content: `reply ${COMPLETION_MARKER}`,
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });

  const router = {
    defaultProviderName: 'anthropic',
    chat,
    chatStream,
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

  return { router, streamCalls, chatCalls };
}

// ─── 测试基座 ───────────────────────────────────────────────────────────────

function createManager(llmRouter: LLMRouter) {
  return new AgentManager({
    llmRouter,
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
}

/** 触碰 Agent 的非公开字段（测试专用，只读/取证，绝不改产品行为）。 */
interface AgentInternals {
  dbSessionMap: Map<string, string>;
  memory: {
    listSessions(agentId?: string): Array<{ id: string }>;
    getSession(id: string): { id: string; messages: Array<{ role: string; content: string }> } | undefined;
    getRecentMessages(id: string, limit: number): Array<{ role: string; content: string }>;
  };
  requestHistory(sessionId: string): Array<{ role: string; content: string }>;
}

const internalsOf = (agent: unknown): AgentInternals => agent as unknown as AgentInternals;

/** agent 的会话落盘目录（MemoryStore.dataDir = agent dataDir = manager.dataDir=<agentId>）。 */
const sessionsDirOf = (agent: Agent) => join(dataDir, agent.id, 'sessions');

/**
 * 模拟「一个 worker 处理该 item 的完整链路」：在指定 worker 的 workspace 里
 * （复刻 processMailboxItemCore 的语义）先按需 restore 建立 DB→memory 绑定，
 * 再以显式 DB session id 跑一次流式 turn。
 */
async function runWorkerTurn(
  agent: Agent,
  workerId: number,
  dbSessionId: string,
  message: string,
  opts?: { restore?: boolean },
): Promise<string> {
  return sessionWorkspaceStore.run(createSessionWorkspace(workerId), async () => {
    if (opts?.restore) {
      // 进程外（HTTP 线程）无法可靠建立绑定时，由处理该 item 的 workspace 建立。
      agent.restoreSessionFromHistory(dbSessionId, [], { preferredMemorySessionId: null });
    }
    return agent.handleMessageStream(
      message,
      () => {},
      'user_op',
      { name: 'Op', role: 'user' },
      undefined,
      undefined,
      undefined,
      undefined,
      dbSessionId,
    );
  });
}

/** 首条消息走真实 sendMessageStream 路径（mailbox → processMailboxItemCore）。 */
function sendFirstStreamTurn(
  agent: Agent,
  dbSessionId: string,
  message: string,
): Promise<string> {
  return agent.sendMessageStream(
    message,
    () => {},
    'user_op',
    { name: 'Op', role: 'user' },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      sessionId: dbSessionId,
      // 真实 HTTP 流式路径在有 DB session id 时总会带上 sessionRestore（空历史=新会话）。
      sessionRestore: { dbSessionId, messages: [], preferredMemorySessionId: null },
    },
  );
}

beforeEach(() => {
  // 零密钥 / 零网络：本机若预置了 OPENAI_API_KEY，AgentManager 会启用语义检索并
  // 每轮向 api.openai.com 发起 embedding 请求（此处会挂 ~10s）。测试不需要它，
  // 显式去掉，保证「无密钥零网络」这一前提成立，也避免测试被网络超时拖慢。
  savedEnv = {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    EMBEDDING_API_KEY: process.env['EMBEDDING_API_KEY'],
  };
  delete process.env['OPENAI_API_KEY'];
  delete process.env['EMBEDDING_API_KEY'];

  dataDir = mkdtempSync(join(tmpdir(), 'markus-session-invariants-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-session-invariants-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nSession invariants role.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- idle');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

// ===========================================================================
// 用例 1 —— 核心：同会话第二条消息（被另一个 worker 处理）必须看到第一条历史
// ===========================================================================
describe('会话不变量：DB session id 贯通（按 DB id 解析内存会话）', () => {
  it('同会话第二条消息（由另一个 worker 处理）必须看到第一条的历史，且不新建会话', { timeout: 30000 }, async () => {
    const probe = makeRecordingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Session Invariants A', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);
    const internals = internalsOf(agent);
    const DB_ID = 'cs_invariants_hist';

    try {
      // ── 消息 1：真实流式路径（mailbox → processMailboxItemCore → handleMessageStream）──
      const reply1 = await sendFirstStreamTurn(agent, DB_ID, 'TOKEN_HIST_FIRST 第一条消息');
      expect(reply1).toBeTruthy();

      // 消息 1 实际用的内存会话 id，及其 DB→memory 绑定。
      const memSession1 = agent.getMemorySessionIdForDbSession(DB_ID);
      expect(memSession1, '首条消息后必须存在 cs_* → sess_* 绑定').toBeTruthy();
      expect(memSession1!.startsWith('sess_'), '内存会话 id 必须是 sess_* 空间').toBe(true);
      expect(internals.dbSessionMap.get(DB_ID)).toBe(memSession1);

      // 消息 1 确实进了模型，且绑定指向的内存会话确实有历史。
      const call1 = probe.streamCalls.find(c => c.text.includes('TOKEN_HIST_FIRST'));
      expect(call1, '消息 1 必须进过 LLM').toBeDefined();
      expect(call1!.sessionId).toBe(memSession1);
      expect(internals.requestHistory(memSession1!).length, '首轮后 requestHistory 必须非空').toBeGreaterThan(0);

      // ── 消息 2：换一个 worker 处理同一个 DB session id ──
      const before2 = probe.streamCalls.length;
      const reply2 = await runWorkerTurn(agent, 2, DB_ID, 'TOKEN_HIST_SECOND 第二条消息');
      expect(reply2).toBeTruthy();

      const call2 = probe.streamCalls.slice(before2).find(c => c.text.includes('TOKEN_HIST_SECOND'));
      expect(call2, '消息 2 必须进过 LLM').toBeDefined();

      // 核心不变量：消息 2 的 prompt 里能看到消息 1 的内容（历史贯通）。
      const realUsers2 = realUserMessages(call2!);
      const histFromFirst = realUsers2.filter(m => m.text.includes('TOKEN_HIST_FIRST'));
      expect(
        histFromFirst.length,
        '消息 2 的提示词必须包含消息 1 的历史 —— 这正是不回潮的护栏',
      ).toBeGreaterThan(0);
      expect(realUsers2[realUsers2.length - 1]!.text, '最后一条真实 user 消息应是消息 2 本身').toContain('TOKEN_HIST_SECOND');

      // 没有因为「无绑定」而新建会话：绑定仍指向同一内存会话。
      expect(agent.getMemorySessionIdForDbSession(DB_ID)).toBe(memSession1);
      // 且第二条消息也带上了正确的内存 session id。
      expect(call2!.sessionId).toBe(memSession1);
      // requestHistory 非空且含 msg1。
      expect(
        internals.requestHistory(memSession1!).some(m => m.content.includes('TOKEN_HIST_FIRST')),
        'requestHistory 必须包含第一条消息',
      ).toBe(true);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  // =========================================================================
  // 用例 2 —— DB id 绝不能被当作内存会话 key（无 split-brain）
  // =========================================================================
  it('DB id 不得被当作内存会话 key：跑完两轮后没有以 cs_* 为 id 的 memory session', { timeout: 30000 }, async () => {
    const probe = makeRecordingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Session Invariants B', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);
    const internals = internalsOf(agent);
    const DB_ID = 'cs_invariants_no_split';

    try {
      await sendFirstStreamTurn(agent, DB_ID, 'TOKEN_NOSPLIT_FIRST 第一条');
      await runWorkerTurn(agent, 2, DB_ID, 'TOKEN_NOSPLIT_SECOND 第二条');

      // 内存侧：不存在以 DB id 为 key 的会话。
      expect(internals.memory.getSession(DB_ID), 'DB id 不得成为内存会话').toBeUndefined();
      for (const s of internals.memory.listSessions()) {
        expect(s.id.startsWith('cs_'), `内存会话 id 不得来自 DB 空间: ${s.id}`).toBe(false);
      }
      // 绑定必须是 sess_*，且与内存里真实存在的会话一致（不是悬空指针）。
      const bound = agent.getMemorySessionIdForDbSession(DB_ID);
      expect(bound).toBeTruthy();
      expect(bound!.startsWith('sess_')).toBe(true);
      expect(internals.memory.getSession(bound!)).toBeDefined();

      // 磁盘侧：等待去抖落盘后扫描 —— agent 落盘目录里不得出现任何 cs_*.json
      // （split-brain 的落盘证据），且绑定指向的内存会话确实已落盘。
      await new Promise(r => setTimeout(r, 1200));
      const dir = sessionsDirOf(agent);
      expect(existsSync(dir)).toBe(true);
      const files = readdirSync(dir);
      expect(files.length, '至少应有会话落盘，否则「无 cs_*.json」是空断言').toBeGreaterThan(0);
      expect(files.filter(f => f.startsWith('cs_')), '落盘目录不得出现 cs_*.json 会话文件').toEqual([]);
      expect(files).toContain(`${bound}.json`);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  // =========================================================================
  // 用例 6 —— 反向护栏：绑定被破坏时必须「显式告警 + 行为退化」，不得静默空历史
  // =========================================================================
  // =========================================================================
  // 用例 6 —— 反向护栏：绑定被破坏时必须「显式告警 + 行为退化」，不得静默空历史
  // =========================================================================
  it('无绑定时必须告警且不再静默续用旧历史（护栏：不得静默空历史）', { timeout: 30000 }, async () => {
    const probe = makeRecordingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Session Invariants Guard', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);
    const internals = internalsOf(agent);
    const DB_ID = 'cs_invariants_guard';

    try {
      await sendFirstStreamTurn(agent, DB_ID, 'TOKEN_GUARD_FIRST 第一条');
      expect(agent.getMemorySessionIdForDbSession(DB_ID)).toBeTruthy();

      // 人为破坏绑定，模拟「worker 拿到请求 DB id 但绑定丢失」。
      internals.dbSessionMap.delete(DB_ID);
      const sessionsBefore = internals.memory.listSessions().length;

      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      warn.mockClear();

      const before = probe.streamCalls.length;
      const reply = await runWorkerTurn(agent, 3, DB_ID, 'TOKEN_GUARD_SECOND 第二条');
      expect(reply).toBeTruthy();

      // 1) 必须告警（可观测），而不是静默返回空历史。
      const boundWarn = warn.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('no memory session bound to its DB session'),
      );
      expect(boundWarn, '有 DB id 但无绑定时必须 log.warn').toBeDefined();
      expect(boundWarn![1]).toMatchObject({ dbSessionId: DB_ID });

      // 2) 行为证据：无绑定 → 无法解析到原会话 → 走新建会话（而非静默假装有历史）。
      expect(internals.memory.listSessions().length).toBeGreaterThan(sessionsBefore);
      const call2 = probe.streamCalls.slice(before).find(c => c.text.includes('TOKEN_GUARD_SECOND'));
      expect(call2).toBeDefined();
      expect(
        realUserMessages(call2!).some(m => m.text.includes('TOKEN_GUARD_FIRST')),
        '绑定缺失时确实无法续用旧历史 —— 正是这条护栏让「静默空历史」不复存在',
      ).toBe(false);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });
});

// ===========================================================================
// 用例 3 —— MemoryStore：未驻留会话必须能按 id 从磁盘懒加载
// ===========================================================================
describe('会话不变量：MemoryStore 历史读取的可观测性', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'markus-mem-lazy-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('未驻留（被 LRU 逐出）的会话必须按 id 从磁盘懒加载，而不是返回空历史', () => {
    const store = new MemoryStore(tmp);
    const target = store.createSession('agent-lazy');
    store.appendMessage(target.id, { role: 'user', content: 'LAZY_ON_DISK_TOKEN 落盘历史' });

    // 制造 LRU 逐出：上限 20，再建 20 个会话即可把 target 挤出内存。
    for (let i = 0; i < 20; i++) store.createSession('agent-lazy');

    // 前提校验（否则本用例根本没测到「未驻留」这条路径）：
    expect(existsSync(join(tmp, 'sessions', `${target.id}.json`)), 'target 必须已落盘').toBe(true);
    expect(store.listSessions().some(s => s.id === target.id), 'target 必须已被逐出内存').toBe(false);

    // 修复前：sessions.get(target) 未命中 → 直接返回 []。
    const recent = store.getRecentMessages(target.id, 10);
    expect(recent.map(m => m.content)).toContain('LAZY_ON_DISK_TOKEN 落盘历史');
  });

  it('未知 id / 空 id 必须告警，而不是静默返回空历史', () => {
    const store = new MemoryStore(tmp);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    warn.mockClear();

    // 空 id
    expect(store.getRecentMessages(undefined as unknown as string, 10)).toEqual([]);
    const emptyCall = warn.mock.calls.find(([m]) => typeof m === 'string' && m.includes('without a session id'));
    expect(emptyCall, '空 session id 必须告警').toBeDefined();

    // 未知 id
    expect(store.getRecentMessages('sess_does_not_exist', 10)).toEqual([]);
    const unknownCall = warn.mock.calls.find(([m]) => typeof m === 'string' && m.includes('unknown session id'));
    expect(unknownCall, '未知 session id 必须告警').toBeDefined();
    expect(unknownCall![1]).toMatchObject({ sessionId: 'sess_does_not_exist' });
  });
});

// ===========================================================================
// 用例 5 —— 并发不串线：两个会话各自两连发，历史只含自己的内容
// ===========================================================================
describe('会话不变量：多会话并发不串线', () => {
  it('两个会话各自两连发：每个会话的历史只含自己的内容，绑定互不相同', { timeout: 30000 }, async () => {
    const probe = makeRecordingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Session Invariants C', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);
    const internals = internalsOf(agent);
    const csA = 'cs_invariants_A';
    const csB = 'cs_invariants_B';

    try {
      // 交错执行 4 个 turn，每个都在独立的 worker workspace 里。
      await runWorkerTurn(agent, 11, csA, 'TOKEN_ISO_A1 A 的第一条', { restore: true });
      await runWorkerTurn(agent, 12, csB, 'TOKEN_ISO_B1 B 的第一条', { restore: true });
      await runWorkerTurn(agent, 21, csA, 'TOKEN_ISO_A2 A 的第二条');
      await runWorkerTurn(agent, 22, csB, 'TOKEN_ISO_B2 B 的第二条');

      const memA = agent.getMemorySessionIdForDbSession(csA);
      const memB = agent.getMemorySessionIdForDbSession(csB);
      expect(memA).toBeTruthy();
      expect(memB).toBeTruthy();
      expect(memA).not.toBe(memB);

      const callA2 = probe.streamCalls.find(c => c.text.includes('TOKEN_ISO_A2'));
      const callB2 = probe.streamCalls.find(c => c.text.includes('TOKEN_ISO_B2'));
      expect(callA2).toBeDefined();
      expect(callB2).toBeDefined();

      const aText = realUserMessages(callA2!).map(m => m.text).join('\n');
      const bText = realUserMessages(callB2!).map(m => m.text).join('\n');

      // 每个会话只看到自己的历史，绝不混入对方。
      expect(aText, 'A 的第二条必须看到 A 的第一条').toContain('TOKEN_ISO_A1');
      expect(aText, 'A 的历史不得混入 B 的内容').not.toContain('TOKEN_ISO_B1');
      expect(bText, 'B 的第二条必须看到 B 的第一条').toContain('TOKEN_ISO_B1');
      expect(bText, 'B 的历史不得混入 A 的内容').not.toContain('TOKEN_ISO_A1');

      // 两轮之后各自绑定仍稳定（没有因为「无绑定」而各自新建会话）。
      expect(agent.getMemorySessionIdForDbSession(csA)).toBe(memA);
      expect(agent.getMemorySessionIdForDbSession(csB)).toBe(memB);
      expect(callA2!.sessionId).toBe(memA);
      expect(callB2!.sessionId).toBe(memB);
      expect(internals.requestHistory(memA!).some(m => m.content.includes('TOKEN_ISO_A1'))).toBe(true);
      expect(internals.requestHistory(memB!).some(m => m.content.includes('TOKEN_ISO_B1'))).toBe(true);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });
});
