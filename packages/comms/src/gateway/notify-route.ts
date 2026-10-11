/**
 * Three-level notification routing (messaging-gateway.md §7.2/§7.3, slice G4).
 *
 * "Where does a notification go?" is answered in exactly one place, by a walk
 * that ends at a level that **always** exists:
 *
 *   1. `agent`    — the producing agent has its own notification sink;
 *   2. `instance` — the agent's bot instance has one;
 *   3. `global`   — the org-wide default (**the Secretary channel**).
 *
 * The old failure (design D5) was that delivery was bound to the *same* binding
 * that routes inbound replies: an agent nobody had bound had no channel, so its
 * notifications were silently dropped. Terminating at a global default — and
 * recording which level matched — makes "never orphaned" a property of the
 * structure rather than a promise someone has to remember.
 */
import type { OutboundOrigin } from './outbound.js';

/** Which level of the walk produced the target. */
export type NotifyScope = 'agent' | 'instance' | 'global';

/** A concrete, sendable notification destination. */
export interface NotifyTarget {
  /** Manifest id (`feishu`, `telegram`, …) — how the sink finds the adapter. */
  platform: string;
  /** Bot instance to send through; absent means the platform's implicit bot. */
  instanceId?: string;
  /** Native conversation id to post into. */
  nativeId: string;
  /** Channel kind hint; notifications are outbound-only. */
  kind?: string;
}

/**
 * The binding source the resolver reads. Production backs this with
 * `channel_bindings`; tests back it with a fake. Level 3 is required to be
 * answerable — a lookup that cannot name a global default is a configuration bug
 * the dispatcher will surface, not paper over.
 */
export interface NotifyTargetLookup {
  agentTarget(orgId: string, agentId: string): NotifyTarget | undefined;
  instanceTarget(orgId: string, agentId: string): NotifyTarget | undefined;
  globalTarget(orgId: string): NotifyTarget | undefined;
}

export interface ResolvedNotifyTarget {
  target: NotifyTarget;
  matchedScope: NotifyScope;
}

/**
 * Walk `agent → instance → global`, first hit wins. Returns `undefined` only when
 * even the global level is unset — which the caller must treat as a loud error,
 * never as "nothing to do".
 */
export function resolveNotifyTarget(
  orgId: string,
  origin: OutboundOrigin,
  lookup: NotifyTargetLookup,
): ResolvedNotifyTarget | undefined {
  if (origin.agentId) {
    const agent = lookup.agentTarget(orgId, origin.agentId);
    if (agent) return { target: agent, matchedScope: 'agent' };

    const instance = lookup.instanceTarget(orgId, origin.agentId);
    if (instance) return { target: instance, matchedScope: 'instance' };
  }

  const global = lookup.globalTarget(orgId);
  if (global) return { target: global, matchedScope: 'global' };

  return undefined;
}
