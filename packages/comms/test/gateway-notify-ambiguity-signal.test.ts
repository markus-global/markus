/**
 * The multi-bot ambiguity warning must describe a choice that actually existed.
 *
 * Defect (2026-11-21, found while diagnosing a Feishu approval button that failed
 * with "目标回调服务当前未在线"): `deliver()` filtered the resolver's alternatives
 * by *scope* only. The resolver hands back every candidate after the winner
 * **unjudged** — it is a pure walk, and "why may this message not go there"
 * belongs to the dispatcher. So a bot whose notifications were switched off was
 * logged under `alsoAvailable`, and the line read "Several notification
 * destinations available — the first eligible one was used".
 *
 * That is worse than no warning: it asserts a routing ambiguity where the walk
 * had correctly picked the only enabled bot, and it points the operator at
 * "fix the routing" — a lever that was never broken. The diagnosis it caused
 * proposed re-routing notifications to the disabled bot.
 *
 * These assert the warning itself, because the warning is the product surface
 * that misled a reader. Counting deliveries would stay green with the lie intact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotifyCandidate, NotifyTarget, NotifyTargetLookup } from '../src/gateway/notify-route.js';
import type { NotifyPreferenceSource } from '../src/gateway/notify-prefs.js';
import type { OutboundMessage } from '../src/gateway/outbound.js';

// Same capture shape as router.test.ts: the log line is the contract under test.
const logCapture = vi.hoisted(() => ({
  lines: [] as Array<{ level: string; msg: string; data?: Record<string, unknown> }>,
}));

vi.mock('@markus/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@markus/shared')>();
  const record = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    logCapture.lines.push({ level, msg, data });
  };
  const makeLogger = (): Record<string, unknown> => ({
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => makeLogger(),
  });
  return { ...actual, createLogger: () => makeLogger() };
});

const { OutboundDispatcher } = await import('../src/gateway/dispatcher.js');

const ON: NotifyTarget = { platform: 'feishu', instanceId: 'bi_default', nativeId: 'oc_default' };
const OFF: NotifyTarget = { platform: 'feishu', instanceId: 'bi_cto', nativeId: 'oc_cto' };

const APPROVAL: OutboundMessage = {
  title: '审批',
  body: '部署请求',
  severity: 'action_required',
  actions: [{ id: 'approve', label: '批准', ref: 'r1' }],
  origin: { agentId: 'agt_ops' },
};

/** Two instance-level candidates, in the order the production lookup emits. */
function lookupOf(first: NotifyTarget, second: NotifyTarget): NotifyTargetLookup {
  const candidates: NotifyCandidate[] = [
    { target: first, scope: 'instance' },
    { target: second, scope: 'instance' },
  ];
  return { candidates: () => candidates };
}

/** Per-target preferences: `disabledFor` names the bot whose notify switch is off. */
function prefsDisabling(disabledFor: string | undefined): NotifyPreferenceSource {
  return {
    preferencesFor: (t) => (t.instanceId === disabledFor ? { notifyEnabled: false } : {}),
  };
}

function sink(): { capabilities: () => Record<string, boolean>; send: () => Promise<string> } {
  return { capabilities: () => ({ markdown: true }), send: async () => 'native_1' };
}

const ambiguityWarnings = (): Array<Record<string, unknown> | undefined> =>
  logCapture.lines
    .filter((l) => l.level === 'warn' && l.msg.includes('Several notification destinations'))
    .map((l) => l.data);

beforeEach(() => {
  logCapture.lines.length = 0;
});

describe('outbound ambiguity warning — a reported choice must be a real choice', () => {
  it('stays silent when the only other bot has notifications switched off', async () => {
    const dispatcher = new OutboundDispatcher({
      lookup: lookupOf(ON, OFF),
      sink: sink(),
      preferences: prefsDisabling('bi_cto'),
    });

    expect((await dispatcher.dispatch(APPROVAL)).delivered).toBe(true);

    // No choice existed, so nothing may claim one did.
    expect(ambiguityWarnings()).toEqual([]);
  });

  it('still reports the choice when both bots could have carried it', async () => {
    const dispatcher = new OutboundDispatcher({
      lookup: lookupOf(ON, OFF),
      sink: sink(),
      preferences: prefsDisabling(undefined),
    });

    expect((await dispatcher.dispatch(APPROVAL)).delivered).toBe(true);

    const warnings = ambiguityWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!['chosen']).toMatchObject({ instanceId: 'bi_default' });
    expect(warnings[0]!['alsoAvailable']).toEqual([
      { platform: 'feishu', instanceId: 'bi_cto', nativeId: 'oc_cto' },
    ]);
  });
});