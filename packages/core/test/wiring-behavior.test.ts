/**
 * 接线**行为**测试（wiring behaviour）—— 把 P1-9 / P1-10 的契约从
 * 「源码里那行调用还在」升级为「那行调用真的生效」。
 * ---------------------------------------------------------------------------
 * 为什么需要它（与 `wiring-contracts.test.ts` 的分工）：
 *
 *   `wiring-contracts.test.ts` 是对**源码文本**做 `toContain` / `toMatch` 的嗅探。
 *   它能挡住「接线调用被误删」，但**看不见「调用了却不生效」**——而 P1-9 的根因恰恰
 *   就是后者：`agent.ts` 里 `new ContextEngine({ tokenCounter: this.tokenCounter })`
 *   的那行调用一直在，只是它注入的是**进程级单例**（`getDefaultTokenCounter()`），
 *   而单例的 `activeModel` 恒为 `''` → `resolveEncoder()` 恒 null → 打包/预算计数整体
 *   静默回退启发式。文本断言对这类根因零保护。
 *
 * 本文件只做**行为级**断言（不写任何源码文本嗅探，那是既有文件的职责）：
 *   1. 用**真实对象**（真实 `Agent` / `ContextEngine` / `SmartTokenCounter`），
 *      只 mock 网络边界（`fetch`）与 LLM 边界（`LLMRouter`）；
 *   2. 断言**可观测输出**——`ContextEngine.prepareMessages()` 返回的
 *      `usage.systemTokens` 是计数器行为的直接函数（`estimateTokens(systemPrompt, this.tokenCounter)`），
 *      因此「引擎用的是哪个计数器、那个计数器处于哪个模型」都能被外部观测到。
 *
 * 契约（本文件锁住的 5 条可观测行为）：
 *   A. 引擎的预算计数**不是**进程级单例算的：把单例的校准因子推到 2.0，agent 的引擎读数不受影响。
 *   B. 走真实 `handleMessage()` 后，引擎的 `systemTokens` 变成该模型的**精确 tiktoken 计数**
 *      （模型激活真的传导到了引擎）。
 *   C. 走真实 `handleMessageStream()`（流式主路径）后，同样精确。
 *   D. 两个不同模型的 agent 互不串扰：B 的激活不改变 A 引擎的读数，A/B 各自模型自洽。
 *   E. AgentManager 启动即启用 Anthropic 计数凭据（`false → true`），且凭据可真正派发。
 *
 * 无法从外部观测、因此**未**在此文件硬编断言的接线（如实说明）：
 *   - `_executeTaskInternal` 的激活（`agent.ts:6009`）：该路径是私有方法，需要真实
 *     Task + TaskExecutor + mailbox 队列才能驱动，本文件只做 chat 两条路径的行为验证；
 *     任务路径的「调用点存在」仍由 `wiring-contracts.test.ts` 的文本切片守卫。
 *   - 「Anthropic count API 真被走到」目前**无法**断言为生效：全仓 `countTokensViaAPI()`
 *     没有任何生产调用点（只有测试调用），所以它被记为一个**已知缺口**用
 *     characterization 用例显式标出（见文件末尾），而不是编一个假的生效断言。
 *   - P0-1 事件转发接线的行为级覆盖已在 `agent-event-forwarding.test.ts`，此处不重复。
 *
 * ── 突变验证（记录在此便于复核；两次突变后均已把 `agent.ts` 原样还原）──────────
 *   M1：`agent.ts:750` 改回 `new ContextEngine()`（注入退化为进程级单例）
 *       → 本文件 6 条用例中 **4 条变红**（4 条 P1-9 行为断言全部抓到「调用了但不生效」）。
 *   M2：只删 `handleMessageStream` 里的 `await this.activateTokenCounterForModel();`
 *       → **只有**「流式主路径」那条变红（说明它守的是流式路径本身的激活，而非注入）。
 *
 * ── 顺带发现的源码疑点（本文件未修改 src，只记录）────────────────────────────
 *   `token-counter.ts:36` 的 `getTiktokenEncodingName()` 把 `gpt-4-turbo` 判为
 *   `o200k_base`，但 gpt-4-turbo(-preview/1106) 实际使用 `cl100k_base` → 该模型族会
 *   按错编码器计数（本文件用 `gpt-4` 才拿到 cl100k，`gpt-4-turbo` 与 `gpt-4o` 结果完全相同）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';

import { Agent } from '../src/agent.js';
import { AgentManager } from '../src/agent-manager.js';
import { ContextEngine } from '../src/context-engine.js';
import { EventBus } from '../src/events.js';
import { MemoryStore } from '../src/memory/store.js';
import type { LLMRouter } from '../src/llm/router.js';
import {
  SmartTokenCounter,
  createTokenCounter,
  getDefaultTokenCounter,
  initTokenCounter,
  isAnthropicTokenCounterEnabled,
} from '../src/token-counter.js';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'wiring-behavior-role',
  name: 'Wiring Behaviour Role',
  description: '接线行为测试用的角色',
  category: 'engineering',
  systemPrompt: 'You are a wiring behaviour probe agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

/**
 * 探针文本：中文 + 拉丁混排，刻意选成「三种计数方式互相可区分」的样本，
 * 使得「引擎到底用了哪个计数器 / 哪个模型」在 `systemTokens` 上**必然**可分：
 *   - 启发式（activeModel 为空）→ 按 cjkRatio 折算；
 *   - o200k_base（gpt-4o 系）→ 精确值与启发式不同；
 *   - cl100k_base（gpt-4 系）→ 与 o200k 也不同。
 * 具体数值不硬编码，全部由参照计数器在用例内现算（见 referenceCounters()）。
 */
const PROBE_TEXT = '这是一个用于验证 token 计数器接线的中文探针文本，需要足够长以便区分不同编码器。'.repeat(10);

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: '接线行为测试的固定回复。',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 25 },
    })),
    chatStream: vi.fn(async (_req: unknown, onEvent?: (e: unknown) => void) => {
      onEvent?.({ type: 'text_delta', text: '流式固定回复。' });
      return {
        content: '流式固定回复。',
        finishReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    }),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

/**
 * 构造**真实** Agent。`defaultModel` 决定 `getEffectiveModel()` 的返回值，
 * 也就是 `activateTokenCounterForModel()` 会激活哪个模型——这是生产配置字段，
 * 不走任何测试专用后门。
 */
function makeAgent(opts: { id: string; model: string; provider: string }): Agent {
  return new Agent({
    config: {
      id: opts.id,
      name: `Wiring Probe ${opts.id}`,
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: opts.provider, defaultModel: opts.model },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

function makeStore(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), 'wiring-behaviour-ms-')));
}

/** 用引擎真实打包一次请求：`usage.systemTokens` 即该引擎计数器对 systemPrompt 的计数。 */
async function pack(engine: ContextEngine, store: MemoryStore, sessionId: string) {
  return engine.prepareMessages({
    systemPrompt: PROBE_TEXT,
    sessionMessages: [{ role: 'user', content: '探针消息' }] as never,
    memory: store,
    sessionId,
    modelContextWindow: 200_000,
    toolDefinitions: [],
  });
}

/**
 * 三种“计数来源”的参照值，全部由真实 `SmartTokenCounter` 现算：
 *   - heuristic：activeModel 为空 → 启发式（校准因子 1.0）；
 *   - o200k / cl100k：激活对应编码器并确保加载完成 → 精确 tiktoken。
 * 预加载编码器只影响「按 model 回查缓存」的计数器，不会污染新计数器的空 activeModel。
 */
async function referenceCounters(): Promise<{
  heuristic: number;
  o200k: number;
  cl100k: number;
}> {
  const o200kCounter = new SmartTokenCounter();
  o200kCounter.setActiveModel('gpt-4o');
  await o200kCounter.ensureReady();

  // 注意：`getTiktokenEncodingName()` 把 `gpt-4-turbo` 归到 o200k_base（疑似上游归类错误，
  // 见本文件末尾的源码疑点记录），所以这里用 `gpt-4` 才能落到 cl100k_base。
  const cl100kCounter = new SmartTokenCounter();
  cl100kCounter.setActiveModel('gpt-4');
  await cl100kCounter.ensureReady();

  const heuristicCounter = new SmartTokenCounter();
  return {
    heuristic: heuristicCounter.countTokens(PROBE_TEXT),
    o200k: o200kCounter.countTokens(PROBE_TEXT),
    cl100k: cl100kCounter.countTokens(PROBE_TEXT),
  };
}

/** 守卫：若编码器没真的加载（或在某些环境里退化），精确/启发式断言会变成假绿，必须显式失败。 */
function assertEncodersDistinguishable(ref: { heuristic: number; o200k: number; cl100k: number }): void {
  expect(
    ref.o200k,
    'js-tiktoken 未生效（精确计数与启发式相同）：本文件的核心断言会变成假绿，必须先修环境',
  ).not.toBe(ref.heuristic);
  expect(ref.cl100k, '两种编码器对本探针文本不可区分：无法验证「用对了模型编码器」').not.toBe(ref.o200k);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-wiring-behaviour-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('接线行为 · P1-9 per-agent 计数器真的驱动 ContextEngine 的预算计数', () => {
  it('单例校准因子被推到 2.0 时，agent 引擎的预算计数不受影响（引擎用的不是进程级单例）', async () => {
    // 把进程级单例校准到 2.0：如果引擎的 tokenCounter 是它，所有计数都会翻倍。
    const singleton = getDefaultTokenCounter();
    for (let i = 0; i < 5; i++) singleton.calibrate(100, 200);
    expect(singleton.getCalibrationFactor()).toBe(2.0);
    const cleanHeuristic = new SmartTokenCounter().countTokens(PROBE_TEXT);
    expect(
      singleton.countTokens(PROBE_TEXT),
      '探针不自洽：单例的读数与干净计数器相同，本用例无法分辨来源',
    ).not.toBe(cleanHeuristic);

    const agent = makeAgent({ id: 'wiring-singleton-probe', model: 'deepseek-chat', provider: 'deepseek' });
    const p = await pack(agent.getContextEngine(), makeStore(), 'sess_singleton');

    // 引擎读数是干净计数器（因子 1.0）的值 → 引擎没有用被污染的进程级单例。
    expect(p.usage.systemTokens).toBe(cleanHeuristic);
    expect(p.usage.systemTokens).not.toBe(singleton.countTokens(PROBE_TEXT));
  });

  it('真实 handleMessage() 激活模型后，引擎的 systemTokens 是该模型的精确 tiktoken 计数', async () => {
    const ref = await referenceCounters();
    assertEncodersDistinguishable(ref);

    const agent = makeAgent({ id: 'wiring-chat-probe', model: 'gpt-4o', provider: 'openai' });
    await agent.handleMessage('hi');

    const p = await pack(agent.getContextEngine(), makeStore(), 'sess_chat');
    expect(p.usage.systemTokens, '模型激活没有传导到 ContextEngine 的计数器').toBe(ref.o200k);
    // 同时确认不是「随便挂了个编码器」：cl100k 的值不同，说明用的是模型的编码器。
    expect(p.usage.systemTokens).not.toBe(ref.cl100k);
  });

  it('流式主路径 handleMessageStream() 同样激活：引擎读数一样精确', async () => {
    const ref = await referenceCounters();
    assertEncodersDistinguishable(ref);

    const agent = makeAgent({ id: 'wiring-stream-probe', model: 'gpt-4o', provider: 'openai' });
    await agent.handleMessageStream('hi', () => {});

    const p = await pack(agent.getContextEngine(), makeStore(), 'sess_stream');
    expect(p.usage.systemTokens, '流式主路径没有把生效模型激活到计数器').toBe(ref.o200k);
  });

  it('两个不同模型的 agent 互不串扰：B 的激活不改变 A 引擎的读数，且各自模型自洽', async () => {
    const ref = await referenceCounters();
    assertEncodersDistinguishable(ref);
    const store = makeStore();

    // A：Claude（本仓库没有 Claude 的本地编码器 → 启发式）
    const agentA = makeAgent({ id: 'wiring-agent-a', model: 'claude-3-5-haiku-20241022', provider: 'anthropic' });
    await agentA.handleMessage('hi');
    const before = (await pack(agentA.getContextEngine(), store, 'sess_a1')).usage.systemTokens;

    // B：GPT-4o（激活 o200k 编码器）
    const agentB = makeAgent({ id: 'wiring-agent-b', model: 'gpt-4o', provider: 'openai' });
    await agentB.handleMessage('hi');
    const after = (await pack(agentA.getContextEngine(), store, 'sess_a2')).usage.systemTokens;
    const sysB = (await pack(agentB.getContextEngine(), store, 'sess_b1')).usage.systemTokens;

    // B 的设置不得影响 A 的引擎（共享计数器时 A 会跟着变成 o200k 的精确值）。
    expect(after, 'agent B 的模型激活串扰到了 agent A 的 ContextEngine').toBe(before);
    expect(after).not.toBe(ref.o200k);
    // B 自己的引擎必须是精确值。
    expect(sysB, 'agent B 的 ContextEngine 未使用其 per-agent 计数器').toBe(ref.o200k);
    expect(after).not.toBe(sysB);
  });
});

describe('接线行为 · P1-10 Anthropic 精确计数接线', () => {
  it('AgentManager 构造即启用 Anthropic 计数凭据（false → true），且凭据可真正派发给计数器', async () => {
    const prevKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-wiring-probe';
    try {
      // 先把凭据清空，确保「变成 true」只能由 AgentManager 的构造接线造成。
      initTokenCounter({});
      expect(isAnthropicTokenCounterEnabled()).toBe(false);

      new AgentManager({ llmRouter: makeMockRouter(), dataDir: tempDir });

      expect(
        isAnthropicTokenCounterEnabled(),
        'AgentManager 构造没有接线 initTokenCounter(env)：生产启动路径下 Anthropic 计数不会启用',
      ).toBe(true);

      // 凭据必须真的沿「启动期 init → createTokenCounter（Agent 内部用的同一工厂）」派发到网络边界。
      const counter = createTokenCounter();
      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ input_tokens: 7 }) }));
      vi.stubGlobal('fetch', fetchSpy);
      const n = await counter.countTokensViaAPI([{ role: 'user', content: 'hi' }], 'claude-3-5-haiku-20241022');

      expect(n).toBe(7);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
      expect(url).toContain('/v1/messages/count_tokens');
      expect(init.headers['x-api-key']).toBe('sk-ant-wiring-probe');
    } finally {
      if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
  });

  it('【已知缺口 · characterization】Claude 聊天路径不产生 count_tokens 请求：精确计数仍是死代码', async () => {
    // 这条用例刻意**记录当前事实**而不是记录理想行为：
    //   启用凭据（isAnthropicTokenCounterEnabled() === true）之后走完整聊天路径，
    //   仍然没有任何 /v1/messages/count_tokens 请求，Claude 的计数全程是本地启发式。
    // 根因：`SmartTokenCounter.countTokensViaAPI()` 在全仓**没有任何生产调用点**（只有测试调用）。
    // 一旦有人把它接进计数路径，本用例会变红 —— 这是**预期**的：请把断言反转为
    // 「确实发出了 count_tokens 请求且 usage 采用 API 返回值」，契约随之升级。
    initTokenCounter({ anthropicApiKey: 'sk-ant-wiring-probe' });
    expect(isAnthropicTokenCounterEnabled()).toBe(true);

    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ input_tokens: 7 }) }));
    vi.stubGlobal('fetch', fetchSpy);

    const agent = makeAgent({ id: 'wiring-anthropic-gap', model: 'claude-3-5-haiku-20241022', provider: 'anthropic' });
    await agent.handleMessage('hi');
    const p = await pack(agent.getContextEngine(), makeStore(), 'sess_anthropic_gap');

    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.filter((u) => u.includes('count_tokens'))).toHaveLength(0);
    // API 返回的 7 从未进入预算：引擎读数是本地启发式量级，而不是 7。
    expect(p.usage.systemTokens).toBeGreaterThan(50);
    expect(p.usage.systemTokens).not.toBe(7);
  });
});
