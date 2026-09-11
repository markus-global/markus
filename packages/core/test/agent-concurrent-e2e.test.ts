/**
 * A 层端到端并发测试（无密钥 / 无网络，可随 CI 常跑）。
 *
 * 真 Agent + 真 attention worker 池 + 真 mailbox + 真实体锁/资源锁，
 * 只把 LLM 换成可观测的假实现。验的是**并发编排本身**，不是「模型答得好不好」
 * —— 后者需要真 key，属于 B 层，用 skipIf 门控。
 *
 * 断言用**精确证据**而不是耗时统计：
 *   1. overlap：某一时刻在飞的两个 prompt 必须**分别**携带 TOKEN_A / TOKEN_B
 *      —— 这样才不会把「同一次 turn 内的两次 LLM 调用」误判成两个会话并行。
 *   2. sessionId：服务 A 的调用必须带 sess_A，服务 B 的必须带 sess_B
 *      —— 端到端验证 SessionWorkspace 的隔离真的生效。
 *   3. 回复互不包含对方的 token —— 无串线。
 *   4. 两个会话全程只触及自己的会话 id（没有任何一次调用串到对方的会话）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import { COMPLETION_MARKER, getTextContent, type LLMRequest } from '@markus/shared';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

/** 串行执行时假 LLM 的等待上限：超时后放行 → peak 断言失败，而不是把测试挂死。 */
const SERIAL_FALLBACK_WAIT_MS = 1500;

interface LlmCall {
  /** 该 prompt 属于哪个会话（由内容里的 TOKEN_X 判定，LLM 侧看不到 meta）。 */
  token: string;
  sessionId: string | undefined;
  /** 送进模型的完整 prompt 文本（用于验证「消息没被静默丢弃」）。 */
  text: string;
  /** 结构化消息列表 —— 用于精确区分「本会话消息」与「感知区块」。 */
  messages: Array<{ role: string; text: string }>;
}

interface RouterProbe {
  router: LLMRouter;
  calls: LlmCall[];
  /** 被观测到的「两个**不同**会话同时在飞」的瞬间。 */
  overlap: Set<string> | null;
}

/**
 * 可观测的假 LLM。
 *
 * 关键机制：每次调用把「自己服务的会话 token」登记进 activeTokens，只有当
 * activeTokens 里**同时存在两个不同 token** 时才算真并发，此时记录证据并放行
 * 所有等待者。串行执行时永远等不到两个不同 token 同时在飞 → 等到超时。
 */
function makeProbeRouter(): RouterProbe {
  const calls: LlmCall[] = [];
  const probe: RouterProbe = { router: undefined as unknown as LLMRouter, calls, overlap: null };

  const activeTokens = new Set<string>();
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>(res => { releaseBarrier = res; });

  const extractToken = (text: string): string => /TOKEN_[A-Z]/.exec(text)?.[0] ?? 'NONE';

  const chat = vi.fn(async (
    request: LLMRequest,
    _provider?: string,
    options?: { sessionId?: string },
  ) => {
    const messages = request.messages.map(m => ({ role: String(m.role), text: getTextContent(m.content) }));
    const text = messages.map(m => m.text).join('\n');
    const token = extractToken(text);
    calls.push({ token, sessionId: options?.sessionId, text, messages });

    activeTokens.add(token);
    if (activeTokens.size >= 2) {
      // 两个**不同**会话同时在飞 —— 这就是要证的并发。
      probe.overlap = new Set(activeTokens);
      releaseBarrier();
    }
    try {
      await Promise.race([
        barrier,
        new Promise(resolve => setTimeout(resolve, SERIAL_FALLBACK_WAIT_MS)),
      ]);
    } finally {
      activeTokens.delete(token);
    }

    return {
      content: `reply-for-${token} ${COMPLETION_MARKER}`,
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });

  probe.router = {
    defaultProviderName: 'anthropic',
    chat,
    chatStream: vi.fn(async function* () {
      yield { type: 'done', content: `reply ${COMPLETION_MARKER}`, finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
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

  return probe;
}

function createManager(llmRouter: LLMRouter) {
  return new AgentManager({
    llmRouter,
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-concurrent-e2e-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-concurrent-e2e-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nConcurrency e2e role.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- idle');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('端到端并发：两个独立会话被两个分身同时服务（A 层，无密钥）', () => {
  it('会话 A / B 真并行、会话 id 不串线、回复不互串', { timeout: 30000 }, async () => {
    const probe = makeProbeRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Concurrent E2E', roleName: 'developer', tools: [] });
    const mailbox = (agent as unknown as { mailbox: { depth: number } }).mailbox;
    await manager.startAgent(agent.id);

    try {
      // 前提校验：默认配置确实开了并发（否则这个测试没有意义）。
      expect(agent.attention.getWorkerCount()).toBeGreaterThan(1);

      const [replyA, replyB] = await Promise.all([
        agent.sendMessage('会话A的消息 TOKEN_A', 'user_A', undefined, { sessionId: 'sess_A' }),
        agent.sendMessage('会话B的消息 TOKEN_B', 'user_B', undefined, { sessionId: 'sess_B' }),
      ]);

      // ── 1. 真并发：两个不同会话确实同一时刻在飞 ──────────────────────────
      expect(probe.overlap).not.toBeNull();
      expect([...(probe.overlap ?? [])].sort()).toEqual(['TOKEN_A', 'TOKEN_B']);

      // ── 2. 会话隔离：每个会话的 LLM 调用只带自己的 sessionId ─────────────
      const aCalls = probe.calls.filter(c => c.token === 'TOKEN_A');
      const bCalls = probe.calls.filter(c => c.token === 'TOKEN_B');
      expect(aCalls.length).toBeGreaterThan(0);
      expect(bCalls.length).toBeGreaterThan(0);
      expect(new Set(aCalls.map(c => c.sessionId))).toEqual(new Set(['sess_A']));
      expect(new Set(bCalls.map(c => c.sessionId))).toEqual(new Set(['sess_B']));

      for (const [own, sibling] of [['TOKEN_A', 'TOKEN_B'], ['TOKEN_B', 'TOKEN_A']] as const) {
        for (const call of probe.calls.filter(c => c.token === own)) {
          // 2a. Scheme A 位置不变量：per-turn volatile 快照必须是**最后一条**消息。
          //     它逐轮变化，只要后面还有任何消息，那部分就永远无法命中前缀缓存。
          const last = call.messages[call.messages.length - 1]!;
          expect(last.role, 'prompt 末尾应是 volatile 快照').toBe('user');
          expect(last.text, 'volatile 快照必须钉在 history 尾部').toContain('[SYSTEM] [Live context]');

          // 2b. 会话隔离：最后一条「真实」user message（即当前提问，排除 volatile
          //     快照）必须只有本会话自己的内容 —— 别的会话的消息绝不能混进会话历史。
          const realUserMsgs = call.messages.filter(
            m => m.role === 'user' && !m.text.startsWith('[SYSTEM] [Live context]'),
          );
          const current = realUserMsgs[realUserMsgs.length - 1]!;
          expect(current.text, `${call.sessionId} 当前消息应是自己发的`).toContain(own);
          expect(current.text, `${call.sessionId} 当前消息混入了其他会话内容`).not.toContain(sibling);

          // 2c. 跨分身感知是**有意且有界的**：兄弟会话的内容只允许作为一行摘要出现在
          //     volatile 感知区块（Concurrency Context）里 —— 而不是被当成本会话的消息。
          const whole = call.messages.map(m => m.text).join('\n');
          const occurrences = whole.split(sibling).length - 1;
          expect(occurrences, '兄弟会话内容被重复注入').toBeLessThanOrEqual(1);
          if (occurrences === 1) {
            expect(last.text, '兄弟会话内容只能出现在 volatile 感知区块').toContain(sibling);
            const idx = last.text.indexOf(sibling);
            expect(
              last.text.slice(Math.max(0, idx - 800), idx),
              '兄弟会话内容只能出现在 Concurrency Context 感知区块中',
            ).toContain('Concurrency Context');
          }
        }
      }

      // ── 3. 无串线：回复各自解决各自的会话 ────────────────────────────────
      expect(replyA).toContain('TOKEN_A');
      expect(replyA).not.toContain('TOKEN_B');
      expect(replyB).toContain('TOKEN_B');
      expect(replyB).not.toContain('TOKEN_A');

      // ── 4. 两个 item 都被消费完毕（无残留、无重排）────────────────────────
      // 注：这里不用 vi.spyOn 观测 AgentMailbox 内部方法 —— 在 startAgent 之前
      // 安装的间谍不会可靠地拦截内部调用（实测会得到误导性的 0 次）。
      // 用「回复已 resolve + 队列已空」作为端到端的完成证据。
      expect(mailbox.depth).toBe(0);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  it('同一会话的两个 item 绝不被并行 —— 且两条消息都不会被静默丢弃', { timeout: 30000 }, async () => {
    const probe = makeProbeRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Concurrent E2E Same', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);

    try {
      // 同一会话连发两条 —— 实体键完全相同（user:user_A + conv:sess_SAME），
      // 因此无论走串行还是走「合并成一次 turn」，都不允许两个分身同时服务它。
      const [r1, r2] = await Promise.all([
        agent.sendMessage('同一会话第一条 TOKEN_A', 'user_A', undefined, { sessionId: 'sess_SAME' }),
        agent.sendMessage('同一会话第二条 TOKEN_B', 'user_A', undefined, { sessionId: 'sess_SAME' }),
      ]);

      // 1. 安全属性：从未出现两个不同会话同时在飞。
      expect(probe.overlap).toBeNull();

      // 2. 该会话的所有 LLM 调用都只带自己的 sessionId（没串到别的会话）。
      expect(probe.calls.length).toBeGreaterThan(0);
      expect(new Set(probe.calls.map(c => c.sessionId))).toEqual(new Set(['sess_SAME']));

      // 3. 不丢消息：两条消息都必须进入过模型上下文。
      //    这一条与「串行」还是「合并成一次 turn」的实现选择解耦 —— 无论走哪条路径，
      //    都不能出现「第二条被合并时静默丢掉」的情况。
      const servedText = probe.calls.map(c => c.text).join('\n');
      expect(servedText).toContain('TOKEN_A');
      expect(servedText).toContain('TOKEN_B');

      // 4. 两个调用方都拿到了回复（串行/合并 ≠ 让某个调用方一直挂着）。
      expect(r1).toBeTruthy();
      expect(r2).toBeTruthy();
    } finally {
      await manager.stopAgent(agent.id);
    }
  });
});
