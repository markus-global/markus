/**
 * Connection verification — "does this bot actually work, *both ways*?"
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * The old Settings "Test" button was a credential probe (`manifest.testConnection`):
 * it exchanged the token for an identity call (`getMe`, `auth.test`, …) and
 * reported pass/fail. That answers "are these credentials valid?" but never
 * "can this bot post into my channel, and can I talk back to it?" — the two
 * questions a user actually has. A bot with a valid token but no `im:message`
 * send scope probes green and then silently fails to deliver approvals.
 *
 * ── The two legs, measured independently ────────────────────────────────────
 *
 *   outbound  bot → IM   : the platform *accepted* a send through this instance
 *   inbound   IM → bot   : an inbound message from the target channel was seen
 *
 * Each leg is recorded on its own, because the interesting failures are
 * asymmetric: "received but cannot post" (missing send scope) and "can post but
 * the bot is not in the group" are different bugs with different fixes. Collapsing
 * them into one boolean would hide exactly the diagnostic the user needs.
 *
 * The run ends `verified` when the inbound leg is seen — which is also the proof
 * of the outbound leg, since the user is answering a message they could only have
 * received.
 *
 * ── Why a registry, and why one matching point ──────────────────────────────
 *
 * Matching "this inbound message is my test reply" is a **stateful** question, so
 * it cannot live in the per-platform adapters (that would be N implementations of
 * one rule). It lives here, and the router asks exactly once, at the single
 * inbound choke point, before resolving an agent target. A consumed test message
 * never reaches an agent — otherwise a verification reply would land in the
 * agent's conversation and pollute its session.
 *
 * State is deliberately in-memory and TTL-bounded: a pending test is a transient
 * handshake, not a fact worth persisting.
 */

import { createLogger, type Message } from '@markus/shared';

const log = createLogger('connection-test');

/** One direction of the handshake. */
export type ConnectionTestLegState = 'pending' | 'ok' | 'failed';

export interface ConnectionTestLeg {
  state: ConnectionTestLegState;
  /** ISO timestamp of the last transition. Absent while `pending`. */
  at?: string;
  /** Human-readable evidence or failure reason. */
  detail?: string;
}

/**
 * `awaiting_reply`   — the prompt was delivered; we are waiting for the answer.
 * `awaiting_inbound` — no sendable target yet; we are waiting for the user to
 *                      message the bot first (then the ack proves outbound).
 * `verified`         — the reply arrived: both directions work.
 * `expired`          — the window closed with no reply.
 */
export type ConnectionTestStatus =
  | 'awaiting_reply'
  | 'awaiting_inbound'
  | 'verified'
  | 'expired';

/** The wire shape the Settings UI polls. */
export interface ConnectionTestSnapshot {
  instanceId: string;
  platform: string;
  status: ConnectionTestStatus;
  /** Short code the prompt asks the user to quote back. `null` when none was sent. */
  code: string | null;
  targetChannelId: string | null;
  targetChannelName: string | null;
  outbound: ConnectionTestLeg;
  inbound: ConnectionTestLeg;
  startedAt: string;
  expiresAt: string;
}

/** Where the prompt should be posted. */
export interface ConnectionTestTarget {
  channelId: string;
  name?: string | null;
}

/**
 * How the registry posts into a platform. Supplied by the wiring layer (it owns
 * the live adapters), so this module stays transport-agnostic and unit-testable.
 */
export interface ConnectionTestSender {
  /** Resolve when the platform accepted the send; **reject** when it did not. */
  send(instanceId: string, channelId: string, text: string): Promise<void>;
}

export interface ConnectionTestOptions {
  sender: ConnectionTestSender;
  /** How long a run stays matchable. Default 10 minutes. */
  ttlMs?: number;
  now?: () => number;
  /** Injectable for deterministic tests. */
  code?: () => string;
  prompt?: (ctx: { code: string; platform: string }) => string;
  acknowledgement?: (ctx: { platform: string }) => string;
  /**
   * Called once, when a run reaches `verified`.
   *
   * The gateway is the only component that observes the proof — the user's
   * reply arrives out of band through the inbound path — so it is also the
   * writer of the durable "this bot works" fact. Best-effort by contract: the
   * verification already happened, so a failure to record it must not throw
   * back into the reply path.
   */
  onVerified?: (ctx: { instanceId: string; platform: string; at: string }) => void | Promise<void>;
}

/** Unambiguous alphabet — no `0/O` or `1/I` to mistype from a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function defaultCode(): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function defaultPrompt(ctx: { code: string; platform: string }): string {
  return (
    '🔗 Markus connection test\n\n' +
    `请回复这条消息，内容包含 ${ctx.code} 即可完成验证。\n` +
    `Reply to this message with ${ctx.code} to confirm.`
  );
}

function defaultAcknowledgement(): string {
  return (
    '✅ 已收到你的回复，双向连接正常。Markus 可以在本会话收发消息了。\n' +
    '✅ Reply received — the connection works in both directions.'
  );
}

export class ConnectionTestRegistry {
  private readonly runs = new Map<string, ConnectionTestSnapshot>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly newCode: () => string;
  private readonly renderPrompt: (ctx: { code: string; platform: string }) => string;
  private readonly renderAck: (ctx: { platform: string }) => string;

  constructor(private readonly opts: ConnectionTestOptions) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.newCode = opts.code ?? defaultCode;
    this.renderPrompt = opts.prompt ?? defaultPrompt;
    this.renderAck = opts.acknowledgement ?? defaultAcknowledgement;
  }

  /**
   * Start (or restart) a verification run for one instance.
   *
   * With a `target`, the prompt goes out immediately — that *is* the outbound
   * measurement. Without one (the platform cannot enumerate channels and none is
   * bound yet) the run starts in the inbound-first shape: the user messages the
   * bot, and the acknowledgement we send back measures the outbound leg. A prompt
   * that fails to send falls back to the same shape rather than dead-ending,
   * because a failed send leaves the user with nothing to reply to.
   */
  async begin(
    instanceId: string,
    platform: string,
    target?: ConnectionTestTarget | null,
  ): Promise<ConnectionTestSnapshot> {
    const code = target ? this.newCode() : null;
    const run: ConnectionTestSnapshot = {
      instanceId,
      platform,
      status: target ? 'awaiting_reply' : 'awaiting_inbound',
      code,
      targetChannelId: target?.channelId ?? null,
      targetChannelName: target?.name ?? null,
      outbound: { state: 'pending' },
      inbound: { state: 'pending' },
      startedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };
    this.runs.set(instanceId, run);

    if (target && code) {
      try {
        await this.opts.sender.send(instanceId, target.channelId, this.renderPrompt({ code, platform }));
        run.outbound = {
          state: 'ok',
          at: new Date(this.now()).toISOString(),
          detail: 'test message accepted by the platform',
        };
      } catch (error) {
        log.warn('Connection test prompt could not be sent — falling back to inbound-first', {
          instanceId,
          platform,
          error: String(error),
        });
        run.outbound = { state: 'failed', at: new Date(this.now()).toISOString(), detail: String(error) };
        run.status = 'awaiting_inbound';
        run.code = null;
        run.targetChannelId = null;
        run.targetChannelName = null;
      }
    }

    log.info('Connection test started', { instanceId, platform, status: run.status });
    return this.snapshot(run);
  }

  /**
   * Offer one inbound message to the active run. Returns `true` when the message
   * was a test reply and has been consumed — the caller must then **not** route
   * it to an agent.
   */
  async noteInbound(message: Message): Promise<boolean> {
    const run = this.runFor(message);
    if (!run) return false;
    if (this.expireIfNeeded(run)) return false;
    if (run.status !== 'awaiting_reply' && run.status !== 'awaiting_inbound') return false;
    // A run started with a known target only accepts the reply in that channel.
    if (run.targetChannelId && run.targetChannelId !== message.channelId) return false;

    const at = new Date(this.now()).toISOString();
    run.inbound = {
      state: 'ok',
      at,
      detail: message.senderId ? `reply from ${message.senderId}` : 'reply received',
    };
    // Inbound-first: the channel the user wrote from *becomes* the target.
    if (!run.targetChannelId) run.targetChannelId = message.channelId;

    // The acknowledgement is the outbound measurement in the inbound-first shape,
    // and a courtesy confirmation otherwise.
    try {
      await this.opts.sender.send(run.instanceId, run.targetChannelId, this.renderAck({ platform: run.platform }));
      if (run.outbound.state !== 'ok') {
        run.outbound = { state: 'ok', at, detail: 'acknowledgement accepted by the platform' };
      }
    } catch (error) {
      run.outbound = { state: 'failed', at, detail: String(error) };
    }

    // Record the durable "this bot works" fact **before** publishing `verified`.
    // A reader that observes `verified` (the Settings badge re-reads the instance
    // list when it does) must never find a row that has not been written yet —
    // that ordering is what flipped the badge back to "unverified". Best-effort
    // by contract: the handshake already happened, so a storage failure must not
    // fail the verification; it is logged and the run still verifies.
    try {
      await this.opts.onVerified?.({ instanceId: run.instanceId, platform: run.platform, at });
    } catch (error) {
      log.warn('Connection test verified but the durable fact could not be recorded', {
        instanceId: run.instanceId,
        platform: run.platform,
        error: String(error),
      });
    }

    run.status = 'verified';

    log.info('Connection test verified', {
      instanceId: run.instanceId,
      platform: run.platform,
      channelId: run.targetChannelId,
      outbound: run.outbound.state,
    });
    return true;
  }

  /** The active run for an instance — `undefined` when none was ever started. */
  get(instanceId: string): ConnectionTestSnapshot | undefined {
    const run = this.runs.get(instanceId);
    if (!run) return undefined;
    this.expireIfNeeded(run);
    return this.snapshot(run);
  }

  clear(instanceId: string): void {
    this.runs.delete(instanceId);
  }

  /**
   * Which run a message belongs to. Instance-scoped messages must match their own
   * run; an instance-less message (legacy single-bot shape) may match the platform's
   * run only when it is unambiguous — guessing between two bots would attribute a
   * reply to the wrong one.
   */
  private runFor(message: Message): ConnectionTestSnapshot | undefined {
    if (message.instanceId) return this.runs.get(message.instanceId);
    const candidates = [...this.runs.values()].filter((r) => r.platform === message.platform);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** Transitions a run to `expired` in place; returns true when it is no longer live. */
  private expireIfNeeded(run: ConnectionTestSnapshot): boolean {
    if (run.status === 'verified' || run.status === 'expired') return run.status !== 'verified';
    if (this.now() < Date.parse(run.expiresAt)) return false;
    run.status = 'expired';
    return true;
  }

  /** Plain copy — a caller must never be able to mutate live state. */
  private snapshot(run: ConnectionTestSnapshot): ConnectionTestSnapshot {
    return {
      ...run,
      outbound: { ...run.outbound },
      inbound: { ...run.inbound },
    };
  }
}
