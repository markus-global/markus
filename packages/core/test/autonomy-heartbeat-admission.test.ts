import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { agentAddressRef, platformOriginRef } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * C10-C — the trust boundary's agent-level autonomy axis at the ONE patrol admission.
 *
 * SSOT: docs/design/c10-c-trust-boundary-2026-11-23.md
 *   §1 A3 — `maySelfInitiate(config.autonomy, ceiling)` goes at the TOP of
 *           `handleHeartbeat`, and the block MUST go through `recordHeartbeatSkip`
 *           (liveness preserved: `state.lastHeartbeat` refreshed, no LLM), never a
 *           bare `return` — an observe agent that stops reporting looks dead in the UI.
 *   §2.0 — every a2a item carries `fromVerified=false` today (mailbox default) and for
 *           `from.kind==='agent'` identity is the platform-built id. So the ceiling is
 *           only asked when unverified agent OR external senders are queued;
 *           platform origins are our own writes and must NOT feed the agent axis.
 *           A (Owner 2026-11-25): external events now owe a turn, so the sender's
 *           authority is capped HERE (T6b/T6c) instead of erased from the intent.
 *   §2.3 — one port, one consumer: `Agent.setTrustBoundaryPort(port)` where
 *           `port.selfInitiationCeiling(senderAgentIds, unverifiedExternal)` receives
 *           the INPUT (queued unverified sender ids + the external flag) and decides.
 *           Port absent ⇒ undefined ceiling ⇒ documented fail-open.
 *   §4   — red first: written against the contract BEFORE the implementation exists.
 *           On base 00358c88: T1 is behaviorally RED (base patrols an observe agent),
 *           T3/T4/T6 are RED because the port seam does not exist (setter missing).
 *
 * Harness mirrors test/heartbeat-liveness.test.ts (mock LLMRouter + fresh tempDir).
 * Patrol is driven through the public `agent.triggerHeartbeat()` WITHOUT `start()`:
 * starting the agent would (a) run an attention loop that consumes the queued probe
 * item and (b) enqueue wake rows that spend their own LLM calls — both would turn
 * "did the patrol run?" into a different question.
 *
 * Fingerprint premise (measured, agent.ts:11061 `lastHeartbeatFingerprint = ''`):
 * the first tick's fingerprint is never `''`, so the very first patrol is never
 * skipped for "state unchanged". Every case below also holds a non-empty queue, so
 * the ONLY thing that can block the patrol is the autonomy axis / the ceiling.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'c10c-autonomy-admission-role',
  name: 'C10-C Autonomy Admission Role',
  description: 'Red-first tests for the autonomy axis at the single patrol admission',
  category: 'engineering',
  systemPrompt: 'You are a C10-C autonomy admission test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

type Autonomy = 'observe' | 'act';

/** §2.3 contract — the port the agent asks for a ceiling; it never decides itself. */
interface TrustBoundaryPort {
  selfInitiationCeiling(senderAgentIds: string[], unverifiedExternal: boolean): Autonomy | undefined;
}

/** §2.3 contract — the setter that will be added to Agent. */
interface TrustPortHost {
  setTrustBoundaryPort(port?: TrustBoundaryPort): void;
}

function makeMockRouter(overrides?: {
  chatFn?: (...args: unknown[]) => Promise<unknown>;
}): LLMRouter {
  const chat = vi.fn(overrides?.chatFn ?? (async () => ({
    content: 'HEARTBEAT_OK',
    finishReason: 'end_turn',
    usage: { inputTokens: 40, outputTokens: 20 },
  })));
  return {
    chat,
    chatStream: vi.fn(async () => ({
      content: 'HEARTBEAT_OK',
      finishReason: 'end_turn',
      usage: { inputTokens: 40, outputTokens: 20 },
    })),
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
 * Fresh Agent per test. `extra` is spread into the config last, so it overrides
 * `id` (each test gets a distinct id) and carries the C10-C field under test
 * (`autonomy`) — the config is cast to `never` exactly as heartbeat-liveness does,
 * because `AgentConfig.autonomy` does not exist on base.
 */
function createAgent(router: LLMRouter, extra?: Record<string, unknown>) {
  return new Agent({
    config: {
      id: 'c10c-autonomy-admission-agent',
      name: 'C10-C Autonomy Admission Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      ...(extra ?? {}),
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

/**
 * Install the §2.3 port through the contract setter.
 *
 * Asserts the setter EXISTS first: on base 00358c88 the seam is absent, and a raw
 * TypeError ("setTrustBoundaryPort is not a function") reads like a harness bug.
 * This makes the red say what is actually missing (the seam), not merely that a
 * member is undefined two frames deeper.
 */
function installTrustPort(agent: Agent, port: TrustBoundaryPort): void {
  const host = agent as unknown as Partial<TrustPortHost>;
  const setter = host.setTrustBoundaryPort;
  expect(
    typeof setter,
    'Agent.setTrustBoundaryPort(port) must exist — C10-C §2.3: one port, one consumer, '
    + 'the ceiling has exactly one entry point (the heartbeat admission)',
  ).toBe('function');
  setter!.call(agent, port);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Bounded wait for a positive ("patrol happened") assertion. */
async function expectPatrolStarted(router: LLMRouter, why: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(router.chat.mock.calls.length, why).toBeGreaterThan(0);
    },
    { timeout: 5000, interval: 20 },
  );
}

/** Bounded settle window for a negative ("patrol must not happen") assertion. */
const NEGATIVE_WINDOW_MS = 500;

/**
 * Enqueue an item that STAYS QUEUED (agent is not started ⇒ no attention loop) and
 * carries a caller-chosen envelope origin.
 *
 * Measured: `Agent.enqueueToMailbox(sourceType, payload, options?)` (agent.ts:1898)
 * forwards to `Mailbox.enqueue(..., options?: EnqueueOptions)` and `EnqueueOptions`
 * carries `origin?: DeliveryOrigin` (mailbox.ts:150-172) ⇒ the origin goes in through
 * the public agent API; there is no need to reach into `agent.mailbox`. Mailbox itself
 * builds the envelope via `buildDeliveryEnvelope` (mailbox.ts:1193-1204) and, per
 * §2.0, defaults `fromVerified` to `false` when the delivery point does not state it.
 *
 * `refOrigin: 'platform-internal'` is declared because these probe items carry no
 * WorkUnit identity (the suite also sets MARKUS_LENIENT_IDENTITY=1 globally; this
 * keeps the probe honest either way). `to` is omitted ⇒ the mailbox addresses the
 * item to this agent, the only resolvable target.
 */
function enqueueQueuedItem(
  agent: Agent,
  sourceType: 'a2a_message' | 'external_signal' | 'system_event',
  payload: { summary: string; content: string },
  origin?: {
    from: ReturnType<typeof agentAddressRef> | { kind: 'external'; address: string };
    /** A 后真实 ingest 对外部信号恒给 action_required；夹具必须能表达这一点。 */
    intent?: string;
  },
) {
  return agent.enqueueToMailbox(
    sourceType,
    payload,
    {
      ...(origin ? { origin: { from: origin.from } } : {}),
      ...(origin?.intent ? { intent: origin.intent } : {}),
      refOrigin: 'platform-internal',
    } as never,
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c10c-autonomy-admission-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the axis itself: autonomy=observe must not self-initiate, but must stay alive
// ─────────────────────────────────────────────────────────────────────────────
describe('C10-C §1 A3 — autonomy=observe blocks the patrol but keeps liveness', () => {
  it('T1: autonomy=observe + queued work + triggerHeartbeat → no LLM patrol, lastHeartbeat refreshed', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t1_observe',
      orgId: 'default',
      autonomy: 'observe',
    });

    // Queued non-heartbeat work ⇒ the patrol fingerprint WOULD change, so the only
    // thing that may block the patrol here is the autonomy axis (§1 A3) — not the
    // "state unchanged" idle skip. It also keeps the port out of it: from.kind='platform'.
    enqueueQueuedItem(agent, 'system_event', {
      summary: 'platform event',
      content: 'queued work that would otherwise drive a patrol',
    });

    agent.triggerHeartbeat();
    await sleep(NEGATIVE_WINDOW_MS);

    expect(
      router.chat.mock.calls.length,
      'autonomy=observe must not self-initiate a patrol — 0 LLM calls expected (§1 A3)',
    ).toBe(0);
    // §1 A3: the block goes through `recordHeartbeatSkip`, never a bare return — an
    // observe agent that stops reporting liveness looks dead in the UI.
    expect(
      agent.getState().lastHeartbeat,
      'an observe agent must still report liveness — recordHeartbeatSkip refreshes '
      + 'state.lastHeartbeat (§1 A3: "must go through recordHeartbeatSkip, NOT a bare return")',
    ).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — control: autonomy=act is unchanged behavior (green at base by design)
// ─────────────────────────────────────────────────────────────────────────────
describe('C10-C §1 A3 — autonomy=act keeps patrolling', () => {
  it('T2: autonomy=act + triggerHeartbeat → patrol runs (router.chat called)', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t2_act',
      orgId: 'default',
      autonomy: 'act',
    });

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'autonomy=act must still patrol — the axis is fail-open for act (§1 A1/A3)',
    );
    expect(router.chat.mock.calls.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3–T6 — the §2.3 verified=false ceiling, asked at the same single admission
// ─────────────────────────────────────────────────────────────────────────────
describe('C10-C §2.3 — the verified=false ceiling is an INPUT asked at the same admission', () => {
  it('T3: queued unverified agent-sender item + port→observe → patrol capped (no LLM)', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t3_capped',
      orgId: 'default',
      autonomy: 'act',
    });

    const ceiling = vi.fn(
      (senderAgentIds: string[]): Autonomy | undefined =>
        senderAgentIds.includes('agt_other') ? 'observe' : undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    // §2.0: the delivery point states only `from`; mailbox.ts defaults fromVerified
    // to false — exactly the seam the ceiling keys on. The item stays queued (the
    // agent is not started), which is the "unverified input still pending" condition.
    const item = enqueueQueuedItem(
      agent,
      'a2a_message',
      { summary: 'peer said hi', content: 'cross-org unverified a2a message' },
      { from: agentAddressRef('agt_other') },
    );
    expect(item.envelope?.from).toEqual({ kind: 'agent', agentId: 'agt_other' });
    expect(item.envelope?.fromVerified).toBe(false);
    expect(agent.getMailbox().getQueuedItems().some(i => i.id === item.id)).toBe(true);

    agent.triggerHeartbeat();
    await sleep(NEGATIVE_WINDOW_MS);

    // §2.3: the agent derives the INPUT (sender ids), the port decides.
    expect(
      ceiling.mock.calls.length,
      'the ceiling must be asked while an unverified agent-sender item is queued (§2.3)',
    ).toBeGreaterThan(0);
    const senderIds = ceiling.mock.calls[0]?.[0] ?? [];
    expect(
      senderIds,
      'the agent must derive the port INPUT from queued from.kind===\'agent\' && '
      + 'fromVerified===false senders (§2.3)',
    ).toContain('agt_other');

    expect(
      router.chat.mock.calls.length,
      'ceiling=observe for a queued unverified agent sender must cap an act agent — '
      + '0 LLM calls expected (§2.3)',
    ).toBe(0);
    expect(
      agent.getState().lastHeartbeat,
      'a capped patrol must still refresh lastHeartbeat (recordHeartbeatSkip, §1 A3)',
    ).toBeTruthy();
  });

  it('T4: same queued item but the port lifts the ceiling (undefined) → patrol runs', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t4_lifted',
      orgId: 'default',
      autonomy: 'act',
    });

    const ceiling = vi.fn(
      (_senderAgentIds: string[]): Autonomy | undefined => undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    enqueueQueuedItem(
      agent,
      'a2a_message',
      { summary: 'peer said hi', content: 'cross-org a2a message, policy lifted to auto' },
      { from: agentAddressRef('agt_other') },
    );

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'ceiling undefined (policy auto / same org) must not cap an act agent (§2.3)',
    );
    expect(ceiling.mock.calls.length).toBeGreaterThan(0);
  });

  it('T5: act agent, NO port set, same queued item → patrol runs (documented fail-open)', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t5_noport',
      orgId: 'default',
      autonomy: 'act',
    });

    enqueueQueuedItem(
      agent,
      'a2a_message',
      { summary: 'peer said hi', content: 'no trust port wired (single-org / embedded)' },
      { from: agentAddressRef('agt_other') },
    );

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'port absent ⇒ no ceiling ⇒ an act agent patrols unchanged (§2.3 documented fail-open)',
    );
  });

  // A (Owner 2026-11-25): T6 used to assert "platform AND external senders never
  // feed the ceiling". That bundled two different facts under one assertion, and
  // A moves exactly one of them: external events now OWE a turn (the platform
  // decides), so the sender's authority is capped HERE instead of at ingest.
  // Split so each half bites on its own — a regression in either one turns red.
  it('T6a: only platform-origin senders queued → port NOT asked, patrol runs', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t6a_platform',
      orgId: 'default',
      autonomy: 'act',
    });

    enqueueQueuedItem(
      agent,
      'system_event',
      { summary: 'platform event', content: 'platform-originated signal in the queue' },
      { from: platformOriginRef() },
    );
    const queuedFromKinds = agent.getMailbox().getQueuedItems()
      .map(i => i.envelope?.from?.kind);
    expect(queuedFromKinds.length).toBeGreaterThan(0);
    expect(
      queuedFromKinds,
      'premise: only our own platform writes are queued',
    ).not.toContain('agent');
    expect(queuedFromKinds).not.toContain('external');

    const ceiling = vi.fn(
      (_senderAgentIds: string[], _unverifiedExternal: boolean): Autonomy | undefined => undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'platform origins are our own writes — they must not feed the ceiling',
    );
    expect(
      ceiling.mock.calls.length,
      'no unverified agent/external sender ⇒ the port must not be asked',
    ).toBe(0);
  });

  it('T6b: unverified EXTERNAL sender queued → port asked with unverifiedExternal=true, observe caps patrol', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t6b_external',
      orgId: 'default',
      autonomy: 'act',
    });

    const item = enqueueQueuedItem(
      agent,
      'external_signal',
      { summary: 'rss item', content: 'unverified external signal — owes a turn, cannot drive patrol' },
      // A 后真实 ingest 给的就是 action_required（欠回合）。夹具不给 intent 会退到
      // deliver = record 类，那是不驱动回合的输入，本就不该封顶（见 T6d）。
      { from: { kind: 'external', address: 'stranger@example.com' }, intent: 'action_required' },
    );
    expect(item.envelope?.from).toEqual({ kind: 'external', address: 'stranger@example.com' });
    expect(item.envelope?.fromVerified).toBe(false);

    // The port decides; the agent only derives the INPUT. An external address has
    // no agent row, so it must arrive as the explicit flag, NOT smuggled into the
    // id list (where a lookup would silently resolve it to nothing = no ceiling).
    const ceiling = vi.fn(
      (_senderAgentIds: string[], unverifiedExternal: boolean): Autonomy | undefined =>
        unverifiedExternal ? 'observe' : undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    agent.triggerHeartbeat();
    await sleep(NEGATIVE_WINDOW_MS);

    expect(ceiling.mock.calls.length).toBeGreaterThan(0);
    const [senderIds, externalFlag] = ceiling.mock.calls[0]!;
    expect(externalFlag, 'unverified external origin must reach the port as its own fact').toBe(true);
    expect(senderIds, 'an external address is not an agent id').toEqual([]);
    expect(
      router.chat.mock.calls.length,
      'port said observe ⇒ self-initiated patrol must not run',
    ).toBe(0);
  });

  it('T6d: record-class external signal (owes NO turn) must NOT cap patrol — else the queue deadlocks', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t6d_record',
      orgId: 'default',
      autonomy: 'act',
    });

    // 活实例取证（2026-11-25）：27 条 queued 外部信号持久化为 intent='deliver'。
    // 它们不驱动回合，若仍封顶就形成死锁：巡逻被它们封住，而它们只能靠回合消费。
    const item = enqueueQueuedItem(
      agent,
      'external_signal',
      { summary: 'legacy record', content: 'pre-A external signal persisted as deliver' },
      { from: { kind: 'external', address: 'stranger@example.com' }, intent: 'deliver' },
    );
    expect(item.envelope?.intent).toBe('deliver');
    expect(item.envelope?.fromVerified).toBe(false);

    const ceiling = vi.fn(
      (_senderAgentIds: string[], unverifiedExternal: boolean): Autonomy | undefined =>
        unverifiedExternal ? 'observe' : undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'input that drives no turn must not cap the patrol that would drain it (deadlock)',
    );
    expect(
      ceiling.mock.calls.length,
      'no turn-owing unverified input queued ⇒ the port must not be asked',
    ).toBe(0);
  });

  it('T6c: unverified external sender but port lifts the ceiling → patrol runs (policy is the port\'s call)', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t6c_lifted',
      orgId: 'default',
      autonomy: 'act',
    });

    enqueueQueuedItem(
      agent,
      'external_signal',
      { summary: 'rss item', content: 'unverified external signal, org policy auto' },
      { from: { kind: 'external', address: 'stranger@example.com' }, intent: 'action_required' },
    );

    const ceiling = vi.fn(
      (_senderAgentIds: string[], _unverifiedExternal: boolean): Autonomy | undefined => undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'the agent must not hard-code the external ceiling — the port owns the policy',
    );
    expect(ceiling.mock.calls[0]![1]).toBe(true);
  });
});
