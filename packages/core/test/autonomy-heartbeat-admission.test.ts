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
 *           only asked when queued agent-sender items exist; platform / external
 *           senders are signal-capped elsewhere (B) and must NOT feed the agent axis.
 *   §2.3 — one port, one consumer: `Agent.setTrustBoundaryPort(port)` where
 *           `port.selfInitiationCeiling(senderAgentIds)` receives the INPUT (queued
 *           from.kind==='agent' && fromVerified===false sender ids) and decides.
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
  selfInitiationCeiling(senderAgentIds: string[]): Autonomy | undefined;
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
  origin?: { from: ReturnType<typeof agentAddressRef> | { kind: 'external'; address: string } },
) {
  return agent.enqueueToMailbox(
    sourceType,
    payload,
    {
      ...(origin ? { origin: { from: origin.from } } : {}),
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

  it('T6: only platform/external senders queued → port NOT asked, patrol runs', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      id: 'agt_c10c_t6_nonsender',
      orgId: 'default',
      autonomy: 'act',
    });

    // from.kind='platform' (explicit platformOriginRef) and from.kind='external'.
    enqueueQueuedItem(
      agent,
      'system_event',
      { summary: 'platform event', content: 'platform-originated signal in the queue' },
      { from: platformOriginRef() },
    );
    enqueueQueuedItem(
      agent,
      'external_signal',
      { summary: 'rss item', content: 'unverified external signal (B caps its demand, not patrol)' },
      { from: { kind: 'external', address: 'stranger@example.com' } },
    );
    const queuedFromKinds = agent.getMailbox().getQueuedItems()
      .map(i => i.envelope?.from?.kind);
    expect(queuedFromKinds.length).toBeGreaterThan(0);
    expect(
      queuedFromKinds,
      'premise: no queued from.kind===\'agent\' sender exists in this case',
    ).not.toContain('agent');

    const ceiling = vi.fn(
      (_senderAgentIds: string[]): Autonomy | undefined => undefined,
    );
    installTrustPort(agent, { selfInitiationCeiling: ceiling });

    agent.triggerHeartbeat();

    await expectPatrolStarted(
      router,
      'non-agent senders must not feed the agent ceiling — patrol must run (§2.0)',
    );
    expect(
      ceiling.mock.calls.length,
      'no queued from.kind===\'agent\' unverified sender ⇒ the port must not be asked (§2.3)',
    ).toBe(0);
  });
});
