/**
 * 端到端「并发取消隔离」测试（无密钥 / 无网络，可随 CI 常跑）。
 *
 * 真 Agent + 真 attention worker 池 + 真 mailbox + 真实体锁/资源锁，只把 LLM
 * 换成可控的假实现（不会 hang 死：所有「挂起」都在测试显式 release 后才放行）。
 *
 * 这组用例盯的是 backstop 超时取消从 best-effort 变确定性的三条根因：
 *   根因 1  cancelProcessing 不带 target，命中与否全靠 ALS → 取消错 worker；
 *   根因 2  在途登记用捕获的 workerId 写、却用 currentWorkerId() 删 → 残留登记；
 *   根因 5  取消失败只留 debug log。
 *
 * 断言用**精确证据**：
 *   - 每次 LLM 调用都记录了它跑在哪个 worker（从 ALS 读 workerId）→ 会话 ↔ worker
 *     的对应关系是硬证据，而不是耗时统计；
 *   - 定向取消「命中了谁」由 `cancelActiveStream()` 返回值 /
 *     `getLastCancelledWorkerId()` / `getWorkerUserCancel()` 直接可断言；
 *   - 收尾断言 worker 终态 idle + mailbox 深度 0 + 无在途登记残留（根因 2 的护栏）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import { sessionWorkspaceStore } from '../src/session-workspace.js';
import { COMPLETION_MARKER, getTextContent, type LLMRequest } from '@markus/shared';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

interface LlmCall {
  /** 该 prompt 属于哪个会话（由「当前提问」里的 TOKEN_X 判定，LLM 侧看不到 meta）。 */
  token: string;
  sessionId: string | undefined;
  /** 发起本次调用的 worker（从 ALS 读；无 ALS 上下文时为 undefined）。 */
  workerId: number | undefined;
  text: string;
}

interface HoldingRouter {
  router: LLMRouter;
  calls: LlmCall[];
  /** 挂起该 token 的所有**后续**调用，直到 release()。 */
  hold(token: string): void;
  release(token: string): void;
  /** 当前在飞的 token 集合 —— 用来取证「两个不同会话确实同时在飞」。 */
  activeTokens(): string[];
  attempts(token: string): number;
}

/**
 * 假 LLM：每次调用登记「会话 token + sessionId + 实际 workerId」，
 * 并可在测试控制下挂起（hold/release），从而精确制造/解除并发时刻。
 */
function makeHoldingRouter(): HoldingRouter {
  const calls: LlmCall[] = [];
  const active = new Map<string, number>();
  const held = new Set<string>();
  const gates = new Map<string, Promise<void>>();
  const gateResolvers = new Map<string, () => void>();
  const attemptCount = new Map<string, number>();

  const gateFor = (token: string): Promise<void> => {
    let g = gates.get(token);
    if (!g) {
      let resolve!: () => void;
      g = new Promise<void>(r => { resolve = r; });
      gates.set(token, g);
      gateResolvers.set(token, resolve);
    }
    return g;
  };

  const chat = vi.fn(async (
    request: LLMRequest,
    _provider?: string,
    options?: { sessionId?: string },
  ) => {
    const messages = request.messages.map(m => ({ role: String(m.role), text: getTextContent(m.content) }));
    const text = messages.map(m => m.text).join('\n');
    // 「当前提问」= 最后一条真实 user message（排除钉在尾部的 volatile 快照）。
    // 只从它取 token —— 否则兄弟会话出现在 [Live context] 感知区块里的 token
    // 会把「谁调用的」判错。
    const realUser = messages.filter(m => m.role === 'user' && !m.text.startsWith('[SYSTEM] [Live context]'));
    const current = realUser[realUser.length - 1]?.text ?? '';
    const token = /TOKEN_[A-Z]/.exec(current)?.[0] ?? /TOKEN_[A-Z]/.exec(text)?.[0] ?? 'NONE';

    const workerId = sessionWorkspaceStore.getStore()?.workerId;
    attemptCount.set(token, (attemptCount.get(token) ?? 0) + 1);
    calls.push({ token, sessionId: options?.sessionId, workerId, text });
    active.set(token, (active.get(token) ?? 0) + 1);
    try {
      if (held.has(token)) await gateFor(token);
    } finally {
      const left = (active.get(token) ?? 1) - 1;
      if (left <= 0) active.delete(token);
      else active.set(token, left);
    }

    return {
      content: `reply-for-${token} ${COMPLETION_MARKER}`,
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });

  const router = {
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

  return {
    router,
    calls,
    hold(token: string) { held.add(token); },
    release(token: string) {
      held.delete(token);
      gateResolvers.get(token)?.();
      gateResolvers.delete(token);
      gates.delete(token);
    },
    activeTokens() { return [...active.keys()]; },
    attempts(token: string) { return attemptCount.get(token) ?? 0; },
  };
}

function createManager(llmRouter: LLMRouter) {
  return new AgentManager({
    llmRouter,
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
}

/** 触碰 Agent 的非公开字段（测试专用）。 */
interface AgentInternals {
  mailbox: { depth: number };
  workerWorkspaces: Map<number, { activeStreamToken?: { cancelled?: boolean; userStopped?: boolean } }>;
}

const internalsOf = (agent: unknown): AgentInternals => agent as unknown as AgentInternals;

async function waitFor(cond: () => boolean, label: string, timeoutMs = 12000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, stepMs));
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-cancel-isolation-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-cancel-isolation-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nConcurrency cancel-isolation role.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- idle');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('端到端并发取消隔离（A 层，无密钥）', () => {
  it('两个 worker 并行跑完整会话链路：会话 id 与 worker 均不串台（含并行证据）', { timeout: 30000 }, async () => {
    const probe = makeHoldingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Cancel Isolation A', roleName: 'developer', tools: [] });
    const mailbox = internalsOf(agent).mailbox;
    await manager.startAgent(agent.id);

    try {
      expect(agent.attention.getWorkerCount()).toBeGreaterThan(1);

      // 两个会话都挂住 → 强制制造「同时在飞」的窗口。
      probe.hold('TOKEN_A');
      probe.hold('TOKEN_B');

      const pA = agent.sendMessage('会话A的消息 TOKEN_A', 'user_A', undefined, { sessionId: 'sess_A' });
      const pB = agent.sendMessage('会话B的消息 TOKEN_B', 'user_B', undefined, { sessionId: 'sess_B' });

      // ── 1. 并行证据：两个**不同**会话同一时刻在飞 ─────────────────────────
      await waitFor(() => probe.activeTokens().length >= 2, '两个会话同时在飞');
      expect([...probe.activeTokens()].sort()).toEqual(['TOKEN_A', 'TOKEN_B']);

      probe.release('TOKEN_A');
      probe.release('TOKEN_B');
      const [replyA, replyB] = await Promise.all([pA, pB]);

      const aCalls = probe.calls.filter(c => c.token === 'TOKEN_A');
      const bCalls = probe.calls.filter(c => c.token === 'TOKEN_B');
      expect(aCalls.length).toBeGreaterThan(0);
      expect(bCalls.length).toBeGreaterThan(0);

      // ── 2. 会话隔离：每个会话的 LLM 调用只带自己的 sessionId ─────────────
      expect(new Set(aCalls.map(c => c.sessionId))).toEqual(new Set(['sess_A']));
      expect(new Set(bCalls.map(c => c.sessionId))).toEqual(new Set(['sess_B']));

      // ── 3. worker 隔离：两个会话不在同一个 worker 上跑，且各自不串台 ──────
      const workerA = aCalls[0]!.workerId;
      const workerB = bCalls[0]!.workerId;
      expect(typeof workerA).toBe('number');
      expect(typeof workerB).toBe('number');
      expect(workerA).not.toBe(workerB);
      expect(aCalls.every(c => c.workerId === workerA)).toBe(true);
      expect(bCalls.every(c => c.workerId === workerB)).toBe(true);

      // ── 4. 回复不互串 + 队列清空 ─────────────────────────────────────────
      expect(replyA).toContain('TOKEN_A');
      expect(replyA).not.toContain('TOKEN_B');
      expect(replyB).toContain('TOKEN_B');
      expect(replyB).not.toContain('TOKEN_A');
      expect(mailbox.depth).toBe(0);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  it('定向取消：backstop 超时只取消目标 worker，另一 worker 全程未被置位', { timeout: 30000 }, async () => {
    const probe = makeHoldingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Cancel Isolation B', roleName: 'developer', tools: [] });
    const attention = agent.attention;
    await manager.startAgent(agent.id);

    try {
      // 3000ms 是刻意选的：本用例要证「A 被取消时 B 毫发无损」，因此必须让 B 在
      // **自己的** backstop 触发之前就真正跑完 —— 否则 B 的取消是它自己超时所致，
      // 与 A 的定向取消无关，断言会变成假红（实测 40ms / 400ms 两版都栽在这里：
      // 两个 worker 的 backstop 会同时到点）。所以只挂住 A，B 完全不挂。
      attention.setProcessingTimeoutMs(3000);
      attention.setBackstopCancelGraceMs(5000);

      probe.hold('TOKEN_A');

      const pA = agent.sendMessage('会话A的消息 TOKEN_A', 'user_A', undefined, { sessionId: 'sess_A' });
      const pB = agent.sendMessage('会话B的消息 TOKEN_B', 'user_B', undefined, { sessionId: 'sess_B' });

      // A 必须先真正进入 LLM（并被挂住）—— 这是「A 在飞」的硬证据，也是后面
      // 「定向取消命中持有 A 的 worker」的前提；不等它就是测试竞态。
      await waitFor(() => probe.calls.some(c => c.token === 'TOKEN_A'), 'A 的调用已发起并被挂住');

      // B 正常跑完、且不进 backstop —— 这本身就是「兄弟 worker 的工作没被牵连」的证据。
      const replyB = await pB;
      expect(replyB).toContain('TOKEN_B');

      // A 被挂住、跨过 backstop(3000ms) → 触发定向取消
      await waitFor(() => agent.getLastCancelledWorkerId() !== undefined, 'backstop 取消触发');

      const workerA = probe.calls.find(c => c.token === 'TOKEN_A')!.workerId!;
      const workerB = probe.calls.find(c => c.token === 'TOKEN_B')!.workerId!;
      expect(workerA).not.toBe(workerB);

      // ── 命中的就是持有 A 的那个 worker（不是 worker 1 / 不是 B）──────────
      expect(agent.getLastCancelledWorkerId()).toBe(workerA);

      // ── B 完全未被波及：定向取消标志 + 流 token 都没动 ──────────────────
      expect(attention.getWorkerUserCancel(workerB)).toBe(false);
      expect(attention.getWorkerUserCancel(workerA)).toBe(true);
      const wsB = internalsOf(agent).workerWorkspaces.get(workerB);
      expect(wsB?.activeStreamToken?.userStopped ?? false).toBe(false);
      expect(wsB?.activeStreamToken?.cancelled ?? false).toBe(false);

      // 放行 A：孤儿 turn settle（是否重排由 attention 按 timeout 语义决定）。
      probe.release('TOKEN_A');
      const replyA = await pA;
      expect(replyB).not.toContain('TOKEN_A');
      expect(replyA).toContain('TOKEN_A');

      // 隔离的最硬证据：B 从头到尾只跑了一次。
      expect(probe.attempts('TOKEN_B')).toBe(1);
      // ⚠️ 这里**不**断言「A 必须重排重跑 ≥ 2 次」。定向取消生效后 A 的原 turn 被真正
      // 中止（这正是本 PR 的目标）；而重排出来的 item 会不会再次进 LLM，取决于
      // 「被取消的 item 是否重放」这一**产品语义**，与「best-effort → 确定性」不同源。
      // 实测 attempts(A) === 1（重排后的 item 未再进 LLM）—— 已作为发现项上报，
      // 不用宽松断言掩盖。将来若重放语义变了，这里会明确报错提醒重新评估。
      expect(probe.attempts('TOKEN_A')).toBe(1);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  it('无 ALS 上下文（HTTP 线程 / 定时器回调）也能按 itemId 精确命中持有者', { timeout: 30000 }, async () => {
    const probe = makeHoldingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Cancel Isolation C', roleName: 'developer', tools: [] });
    const attention = agent.attention;
    await manager.startAgent(agent.id);

    try {
      // 关掉 backstop 干扰：本用例专测「手动定向取消」的命中精度。
      attention.setProcessingTimeoutMs(60000);

      probe.hold('TOKEN_A');
      const pA = agent.sendMessage('会话A的消息 TOKEN_A', 'user_A', undefined, { sessionId: 'sess_A' });
      const pB = agent.sendMessage('会话B的消息 TOKEN_B', 'user_B', undefined, { sessionId: 'sess_B' });

      // B 不被挂住 → 先正常跑完，确保 A 是「唯一在飞」的目标。
      const replyB = await pB;
      expect(replyB).toContain('TOKEN_B');

      // A 的调用是「已发起但被挂住」，它可能比 B 晚一点才真正进入 LLM —— 必须等
      // 它出现在 calls 里再取 workerId，否则这是测试竞态而不是产品行为。
      await waitFor(() => probe.calls.some(c => c.token === 'TOKEN_A'), 'A 的调用已发起并被挂住');

      const workerA = probe.calls.find(c => c.token === 'TOKEN_A')!.workerId!;
      const workerB = probe.calls.find(c => c.token === 'TOKEN_B')!.workerId!;

      // 找到「持有 sess_A 的 worker」及其 item id（完全拉平 ALS，走公开 getter）。
      let holder: { workerId: number; itemId: string } | undefined;
      await waitFor(() => {
        const f = attention.getWorkerFocus(workerA);
        if (f?.payload?.extra?.sessionId === 'sess_A') {
          holder = { workerId: workerA, itemId: f.id };
          return true;
        }
        return false;
      }, 'A 的 item 落在持有者 worker 上');
      expect(holder!.workerId).toBe(workerA);

      // 关键前提：这里确实**没有** ALS 上下文（等价外部 HTTP 线程）。
      expect(sessionWorkspaceStore.getStore()).toBeUndefined();

      const hit = agent.cancelActiveStream({ itemId: holder!.itemId });

      // ── 精确命中：返回 / 记录的都是持有该 item 的 worker ────────────────
      expect(hit).toBe(workerA);
      expect(agent.getLastCancelledWorkerId()).toBe(workerA);
      expect(attention.getWorkerUserCancel(workerA)).toBe(true);
      const wsA = internalsOf(agent).workerWorkspaces.get(workerA);
      expect(wsA?.activeStreamToken?.userStopped).toBe(true);
      expect(wsA?.activeStreamToken?.cancelled).toBe(true);

      // ── 兄弟 worker 完全未被波及 ────────────────────────────────────────
      expect(workerB).not.toBe(workerA);
      expect(attention.getWorkerUserCancel(workerB)).toBe(false);
      const wsB = internalsOf(agent).workerWorkspaces.get(workerB);
      expect(wsB?.activeStreamToken?.userStopped ?? false).toBe(false);

      probe.release('TOKEN_A');
      expect(await pA).toBeTruthy();
    } finally {
      await manager.stopAgent(agent.id);
    }
  });

  it('两侧状态收敛：终态 idle、mailbox 深度 0、无在途登记残留（根因 2 回归护栏）', { timeout: 30000 }, async () => {
    const probe = makeHoldingRouter();
    const manager = createManager(probe.router);
    const agent = await manager.createAgent({ name: 'Cancel Isolation D', roleName: 'developer', tools: [] });
    const attention = agent.attention;
    const mailbox = internalsOf(agent).mailbox;
    await manager.startAgent(agent.id);

    try {
      attention.setProcessingTimeoutMs(40);
      attention.setBackstopCancelGraceMs(5000);

      probe.hold('TOKEN_A');
      probe.hold('TOKEN_B');

      const pA = agent.sendMessage('会话A的消息 TOKEN_A', 'user_A', undefined, { sessionId: 'sess_A' });
      const pB = agent.sendMessage('会话B的消息 TOKEN_B', 'user_B', undefined, { sessionId: 'sess_B' });

      await waitFor(() => probe.activeTokens().length >= 2, '两个会话同时在飞');
      const workerA = probe.calls.find(c => c.token === 'TOKEN_A')!.workerId!;
      await waitFor(() => agent.getLastCancelledWorkerId() !== undefined, 'backstop 取消触发');

      probe.release('TOKEN_A');
      probe.release('TOKEN_B');
      await Promise.all([pA, pB]);

      const workerCount = attention.getWorkerCount();
      const workerIds = Array.from({ length: workerCount }, (_, i) => i + 1);

      // 收敛：所有 worker 回到 idle、队列清空、在途登记清空。
      await waitFor(
        () => mailbox.depth === 0
          && attention.getInFlightWorkerIds().length === 0
          && workerIds.every(w => attention.getWorkerSnapshot(w)?.state === 'idle'),
        '两侧状态收敛',
      );

      expect(mailbox.depth).toBe(0);
      // 根因 2 的护栏：ALS 漂移会删错在途登记键 → 这里会看到残留。
      expect(attention.getInFlightWorkerIds()).toEqual([]);
      for (const w of workerIds) {
        const snap = attention.getWorkerSnapshot(w);
        expect(snap?.state).toBe('idle');
        expect(snap?.focusItemId).toBeUndefined();
        // 收尾后定向取消标志必须已被清理，不能污染下一个 item。
        expect(snap?.userCancelCurrent).toBe(false);
      }
      expect(attention.getWorkerUserCancel(workerA)).toBe(false);
    } finally {
      await manager.stopAgent(agent.id);
    }
  });
});
