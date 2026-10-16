/**
 * Notification-destination routing (design: docs/architecture/notification-delivery.md §3).
 *
 * "Where does a notification go?" is answered in exactly one place: a *walk* over
 * every destination this origin could reach, most specific first, ending at the
 * first one that is actually **sendable** — or at an explicit, loud *nothing*.
 *
 * ── What changed, and why (2026-10-16) ───────────────────────────────────────
 *
 * The walk used to be per-level: ask "the agent's own sink?", else "a declared
 * destination?", else …, and it stopped at the first level that returned
 * *anything*. Whether that anything could actually be **sent through** was a
 * separate question asked afterwards, by the dispatcher, as a **terminator**: if
 * the chosen bot had notifications switched off, the message was dropped — and
 * never re-tried against the next destination.
 *
 * That is exactly how an org with three bots lost every notification: two of
 * them (the Secretary's and one other) were fine, but the walk happened to stop
 * on a bot whose notification master switch was off, and the drop was logged as
 * `notify-disabled` — an *intentional* outcome, so nothing looked wrong.
 *
 * The two questions — *where could this go?* and *may it go there?* — are now
 * separated by construction:
 *
 *   • the lookup **enumerates candidates** ({@link NotifyTargetLookup.candidates}),
 *     most specific first;
 *   • *one* decision point ({@link NotifyEligibility}, supplied by the dispatcher)
 *     decides whether a candidate may carry the message;
 *   • the walk returns the **first eligible** candidate, so an ineligible one can
 *     no longer be a dead end;
 *   • when candidates existed but all were ineligible the result is an explicit
 *     `suppressed` — distinct from `undelivered` ("nowhere configured"), so a
 *     mis-route can never again masquerade as an intentional switch-off.
 */
import type { OutboundOrigin } from './outbound.js';
import type { SendReceiveIdType } from '../adapter.js';

/** Which level of the walk produced the target. */
export type NotifyScope = 'agent' | 'instance' | 'global';

/**
 * How a native id is addressed on the wire — the platform's receive-id *type*
 * (fixes R4). Feishu's vocabulary is the reference: `chat_id` for a group/bot
 * chat, `open_id` for a user DM. A platform that has a single addressing scheme
 * leaves it unset and uses its own default.
 *
 * One definition, shared with the adapter send contract ({@link SendReceiveIdType})
 * — a resolved target's addressing and what an adapter accepts cannot drift.
 */
export type NotifyReceiveIdType = SendReceiveIdType;

/**
 * The semantic kind of a *declared* destination — the value of the generic
 * `notifyTarget` manifest-field annotation. Platform-neutral by design: `chat`
 * means a channel/group, `user` means a person. A platform declares which of its
 * config fields is which, so the resolver needs no platform branch (fixes R5).
 */
export type NotifyDestinationKind = 'chat' | 'user';

/**
 * Map a declared destination kind onto the concrete receive-id type sent on the
 * wire. `chat → chat_id`, `user → open_id` (the reference platform's vocabulary);
 * an adapter with a different user-addressing token translates it at the edge.
 */
export function receiveIdTypeForDestination(kind: NotifyDestinationKind): NotifyReceiveIdType {
  return kind === 'user' ? 'open_id' : 'chat_id';
}

/** A concrete, sendable notification destination. */
export interface NotifyTarget {
  /** Manifest id (`feishu`, `telegram`, …) — how the sink finds the adapter. */
  platform: string;
  /** Bot instance to send through; absent means the platform's implicit bot. */
  instanceId?: string;
  /** Native conversation id to post into. */
  nativeId: string;
  /**
   * Send-addressing type for {@link nativeId}. Absent means "use the adapter's
   * default" (Feishu: `chat_id`). Honoured by the adapter, so `open_id` DM
   * delivery is expressible rather than impossible (fixes R4).
   */
  receiveIdType?: NotifyReceiveIdType;
  /** Channel kind hint; notifications are outbound-only. */
  kind?: string;
}

/** One possible destination, plus the walk level that produced it. */
export interface NotifyCandidate {
  target: NotifyTarget;
  scope: NotifyScope;
}

/**
 * The binding source the resolver reads. One method: **every** destination this
 * origin could reach, most specific first.
 *
 * It used to expose one method per level (`agentTarget`, `instanceDeclaredTarget`,
 * …), which is what made an unreachable candidate a dead end — the walk stopped at
 * the first level that returned anything, and the *eligibility* of that thing was
 * somebody else's problem. Enumerating instead of short-circuiting is what lets
 * "the first candidate happens to be switched off" fall through to the next one.
 *
 * Production backs this with `channel_bindings` + `platform_instances`; tests back
 * it with a fake.
 */
export interface NotifyTargetLookup {
  candidates(orgId: string, origin: OutboundOrigin): NotifyCandidate[];
}

/** A resolved destination plus the walk level that produced it. */
export interface ResolvedNotifyTarget {
  target: NotifyTarget;
  matchedScope: NotifyScope;
  /**
   * Candidates that existed after the chosen one — other destinations that were
   * available but not needed, each still tagged with its level. Surfaced so an
   * operator with two configured bots can *see* which one won (and that there was
   * a choice at all) instead of inferring it from a list order. Absent when the
   * chosen candidate was the last one.
   */
  alternatives?: NotifyCandidate[];
}

/** A candidate the eligibility predicate rejected, with the reason it gave. */
export interface NotifySkipped {
  target: NotifyTarget;
  reason: string;
}

/** Why the walk produced no terminus. Distinguishable from a send failure. */
export type NotifyUndeliveredReason = 'no-notify-target';

/**
 * The resolver's **total** result. Never `undefined`/`null`, so "no destination"
 * cannot be silently conflated with "nothing to do", and — the point of
 * {@link NotifySkipped} — "deliberately switched off" cannot be conflated with
 * "mis-routed to the wrong bot".
 */
export type NotifyResolution =
  | ({ status: 'resolved' } & ResolvedNotifyTarget)
  | { status: 'suppressed'; reason: string; skipped: NotifySkipped[] }
  | { status: 'undelivered'; reason: NotifyUndeliveredReason };

/**
 * May this candidate carry the message? `undefined` ⇒ yes, otherwise the reason
 * it may not. Supplied by the dispatcher, which owns *why* (notification
 * preferences for this message) — the resolver stays a pure walk and never needs
 * to know what a preference is.
 */
export type NotifyEligibility = (target: NotifyTarget) => string | undefined;

/**
 * Walk every candidate, most specific first, and return the **first eligible**
 * one. Ineligible candidates are skipped, not fatal: the walk continues to the
 * next destination (that is the fix for the 2026-10-16 mis-route, where one
 * switched-off bot swallowed every notification).
 *
 * When candidates existed but none was eligible the result is `suppressed` and
 * carries *every* skipped candidate with its reason — so the caller can say which
 * bots were considered and why each was passed over, rather than reporting a
 * single reason that reads like an intentional switch-off.
 */
export function resolveNotifyTarget(
  orgId: string,
  origin: OutboundOrigin,
  lookup: NotifyTargetLookup,
  isEligible?: NotifyEligibility,
): NotifyResolution {
  const candidates = lookup.candidates(orgId, origin);
  if (candidates.length === 0) return { status: 'undelivered', reason: 'no-notify-target' };

  const skipped: NotifySkipped[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const { target, scope } = candidates[i];
    const reason = isEligible?.(target);
    if (!reason) {
      const rest = candidates.slice(i + 1);
      return {
        status: 'resolved',
        target,
        matchedScope: scope,
        ...(rest.length > 0 ? { alternatives: rest } : {}),
      };
    }
    skipped.push({ target, reason });
  }

  return { status: 'suppressed', reason: skipped[0].reason, skipped };
}
