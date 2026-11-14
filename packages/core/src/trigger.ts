/**
 * Triggers and subscriptions (C8-C) — "wait for an event without polling".
 *
 * Why this module exists
 * ---------------------------------------------------------------------------
 * Before this, an agent that had nothing to do until *something happened* had two bad
 * options: keep a periodic clock running (poll — the heartbeat's second timer, and the
 * queue noise this cut removes) or block on an empty mailbox with no record of what it
 * was actually waiting for. Neither states the condition, so nothing can tell whether
 * the agent is idle on purpose or stuck.
 *
 * A subscription is that missing statement: **"wake me when this arrives"**, written
 * down once, matched synchronously by the event that arrives, and swept by the existing
 * clock when it expires. Three rules keep it honest:
 *
 *  1. **No timer per subscription.** Matching is a pure predicate over an event that
 *     already exists (`mailbox:new-item`). Expiry is swept by the agent's single clock
 *     source — never by a `setTimeout` per subscription.
 *  2. **The event is the wake, not a proxy for it.** We do not invent a poll interval,
 *     a "check every N ms" flag, or a second queue. If the event does not exist, the
 *     subscription does not fire.
 *  3. **One registry per agent, one writer.** `subscribe` adds, `dispatch` matches and
 *     consumes (`once`), `sweepExpired` drops. No other code mutates a subscription.
 */
import type { MailboxItemType } from '@markus/shared';

/**
 * What an agent is waiting for.
 *
 * Deliberately small: this is the minimum that can be matched without asking the
 * platform to interpret content (R4 — the platform must not decide what an agent's
 * message means). More condition kinds get added only when a real caller needs one.
 */
export type WakeCondition =
  | { kind: 'mailbox-type'; sourceType: MailboxItemType }
  | { kind: 'mailbox-any' };

/** An event the registry can be matched against. Today the only source is the mailbox. */
export interface TriggerEvent {
  type: 'mailbox:new-item';
  agentId: string;
  sourceType: MailboxItemType;
  itemId: string;
}

export interface Subscription {
  id: string;
  agentId: string;
  wakeOn: WakeCondition;
  note?: string;
  createdAt: number;
  /** Absolute epoch ms; `null` = never expires. */
  expiresAt: number | null;
  /** Default true: a subscription is a one-shot wait unless the caller asks otherwise. */
  once: boolean;
  /** Last time it matched. For `once` subscriptions the entry is removed on match, so
   *  this is only observable on repeating ones. */
  firedAt?: number;
}

export interface SubscribeInput {
  agentId: string;
  wakeOn: WakeCondition;
  note?: string;
  now?: number;
  timeoutMs?: number;
  once?: boolean;
}

/** Default lifetime of a wait: long enough for a human-scale follow-up, short enough to
 *  never accumulate. Expiry is reported, not silently swallowed. */
export const SUBSCRIPTION_DEFAULT_TTL_MS = 6 * 3600_000;

let seq = 0;

function nextId(): string {
  seq += 1;
  return `sub_${Date.now().toString(36)}_${seq}`;
}

/**
 * Pure predicate: does this event satisfy that condition?
 * Kept pure so the matching rule is unit-testable without a registry, a bus or timers.
 */
export function matchesWakeCondition(cond: WakeCondition, event: TriggerEvent): boolean {
  if (event.type !== 'mailbox:new-item') return false;
  switch (cond.kind) {
    case 'mailbox-any':
      return true;
    case 'mailbox-type':
      return event.sourceType === cond.sourceType;
    default:
      return false;
  }
}

export class TriggerRegistry {
  private readonly subs = new Map<string, Subscription>();

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(input: SubscribeInput): Subscription {
    const at = input.now ?? this.now();
    const ttl = input.timeoutMs ?? SUBSCRIPTION_DEFAULT_TTL_MS;
    const sub: Subscription = {
      id: nextId(),
      agentId: input.agentId,
      wakeOn: input.wakeOn,
      note: input.note,
      createdAt: at,
      expiresAt: ttl > 0 ? at + ttl : null,
      once: input.once ?? true,
    };
    this.subs.set(sub.id, sub);
    return sub;
  }

  /**
   * Match an event against live subscriptions and return the ones it satisfied.
   *
   * Synchronous and side-effect-light on purpose: the caller decides what "waking" the
   * agent means, and there is exactly one place (this method) that decides a match.
   */
  dispatch(event: TriggerEvent): Subscription[] {
    const at = this.now();
    const matched: Subscription[] = [];
    for (const sub of this.subs.values()) {
      if (sub.agentId !== event.agentId) continue;
      if (sub.expiresAt !== null && at >= sub.expiresAt) continue;
      if (!matchesWakeCondition(sub.wakeOn, event)) continue;
      sub.firedAt = at;
      matched.push(sub);
      if (sub.once) this.subs.delete(sub.id);
    }
    return matched;
  }

  list(agentId?: string): Subscription[] {
    const all = [...this.subs.values()];
    return agentId ? all.filter(s => s.agentId === agentId) : all;
  }

  get(id: string): Subscription | undefined {
    return this.subs.get(id);
  }

  /** Drop one subscription (agent cancelled the wait). Returns whether it existed. */
  consume(id: string): boolean {
    return this.subs.delete(id);
  }

  clearAgent(agentId: string): number {
    let n = 0;
    for (const [id, sub] of this.subs) {
      if (sub.agentId === agentId) {
        this.subs.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /**
   * Drop expired subscriptions. Called by the agent's clock source — this is why the
   * registry needs no timer of its own. Returns what was dropped so the caller can log
   * "this wait expired" instead of leaving a silent hole.
   */
  sweepExpired(now: number = this.now()): Subscription[] {
    const expired: Subscription[] = [];
    for (const [id, sub] of this.subs) {
      if (sub.expiresAt !== null && now >= sub.expiresAt) {
        expired.push(sub);
        this.subs.delete(id);
      }
    }
    return expired;
  }

  size(): number {
    return this.subs.size;
  }
}
