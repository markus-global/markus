/**
 * The messaging gateway's single inbound resolution point
 * (docs/design/messaging-gateway.md §6.1, slice G3).
 *
 * Before this, "who should answer an inbound message?" was answered in more than
 * one place — the router held a startup snapshot, the Feishu live path re-read
 * the DB per message, and an unbound message was dropped (defects D6 and the
 * §2 "two writers" row). This module is that answer, once.
 *
 * Pure and storage-agnostic: the binding source is a small port, so the whole
 * precedence chain is unit-testable without a database.
 */

import type { Message } from '@markus/shared';
import {
  conversationKeyOf,
  isInboundIgnored,
  type ChannelKind,
} from './conversation-key.js';

/** Which level produced the winning agent — recorded for observability, not guessed. */
export type MatchedScope = 'explicit' | 'channel' | 'instance' | 'platform' | 'global';

/** A binding row, structurally compatible with `channel_bindings`. */
export interface ScopeBinding {
  scope: 'global' | 'instance' | 'channel';
  /** Set for `instance` / `channel` scopes; `null` for `global`. */
  instanceId: string | null;
  /** Native conversation id; set for `channel` scope only. */
  nativeId: string | null;
  /** Binding kind hint. `'main'` *designates* the channel as the agent's home. */
  kind: string | null;
  agentId: string;
}

/**
 * The binding source the resolver reads. Deliberately narrow so any storage
 * (SQLite today, something else tomorrow) can satisfy it structurally.
 */
export interface BindingLookup {
  /** All scope bindings for an org on a platform. */
  bindings(orgId: string, platform: string): readonly ScopeBinding[];
  /**
   * Platform-wide default (level 4). Realised as the binding on the platform's
   * `label='default'` instance — the row G1's migration produced from the legacy
   * platform-level `agentId` (see design §6.3; no schema change).
   */
  platformDefaultAgent(orgId: string, platform: string): string | undefined;
  /**
   * Terminal fallback for level 5 when no `global` binding row exists — the org
   * Secretary. Optional: a lookup with no Secretary simply cannot resolve.
   */
  orgDefaultAgent?(orgId: string): string | undefined;
}

/** A normalised inbound message: everything resolution needs, nothing else. */
export interface InboundEnvelope {
  orgId: string;
  platform: string;
  /** Native conversation id inside the instance. */
  nativeId: string;
  /** Bot instance that received it; absent for single-instance / legacy adapters. */
  instanceId?: string;
  /** Adapter-declared kind; defaults to `group` (isolation is identical for dm/group). */
  kind?: ChannelKind;
  /** Explicit target agent — always wins (Web UI sets it). */
  explicitAgentId?: string;
}

export interface ResolvedInboundTarget {
  instanceId: string | undefined;
  agentId: string;
  conversationKey: string;
  matchedScope: MatchedScope;
  kind: ChannelKind;
  /** True for `notification` channels: inbound is a destination, not a conversation. */
  ignored: boolean;
}

/** Build the envelope the resolver consumes from a platform `Message`. */
export function inboundEnvelopeOf(message: Message, orgId: string): InboundEnvelope {
  return {
    orgId,
    platform: message.platform,
    nativeId: message.channelId,
    instanceId: message.instanceId,
    kind: message.channelKind,
    explicitAgentId: message.agentId || undefined,
  };
}

/**
 * Nearest-wins resolution. Returns `undefined` only when **nothing at all** is
 * bound (no explicit agent, no channel/instance/platform/global binding, no
 * Secretary) — the one case a caller must log loudly rather than ignore.
 */
export function resolveInboundTarget(
  env: InboundEnvelope,
  lookup: BindingLookup,
): ResolvedInboundTarget | undefined {
  const instanceId = env.instanceId;
  const inst = instanceId ?? '';
  const bindings = lookup.bindings(env.orgId, env.platform);

  let agentId: string | undefined;
  let matchedScope: MatchedScope | undefined;
  let kind: ChannelKind = env.kind ?? 'group';

  // 1) explicit — the Web UI names the agent.
  if (env.explicitAgentId) {
    agentId = env.explicitAgentId;
    matchedScope = 'explicit';
  }

  // 2) channel — the most specific persisted route. A binding without an
  //    instance (bootstrap/legacy shape) matches a message without one.
  if (!agentId && env.nativeId) {
    const channelBinding = bindings.find(
      (b) =>
        b.scope === 'channel' &&
        (b.instanceId ?? '') === inst &&
        b.nativeId === env.nativeId,
    );
    if (channelBinding) {
      agentId = channelBinding.agentId;
      matchedScope = 'channel';
      // A channel's binding may *designate* its role: `main` is the agent's home
      // (maps to the agent's own main session, §6.2); `notification` is a
      // destination, so inbound on it is ignored. The binding is authoritative
      // here — the operator, not the adapter, decides the channel's role.
      if (channelBinding.kind === 'main' || channelBinding.kind === 'notification') {
        kind = channelBinding.kind;
      }
    }
  }

  // 3) instance — the bot's own default agent.
  if (!agentId && instanceId) {
    const instanceBinding = bindings.find(
      (b) => b.scope === 'instance' && b.instanceId === instanceId,
    );
    if (instanceBinding) {
      agentId = instanceBinding.agentId;
      matchedScope = 'instance';
    }
  }

  // 4) platform — the platform's default-instance binding (design §6.3).
  if (!agentId) {
    const platformAgent = lookup.platformDefaultAgent(env.orgId, env.platform);
    if (platformAgent) {
      agentId = platformAgent;
      matchedScope = 'platform';
    }
  }

  // 5) global — the org default route, materialised as the global binding.
  if (!agentId) {
    const globalBinding = bindings.find((b) => b.scope === 'global');
    if (globalBinding) {
      agentId = globalBinding.agentId;
      matchedScope = 'global';
    }
  }

  // 5b) global fallback — the live Secretary (so the chain always terminates).
  if (!agentId) {
    const secretary = lookup.orgDefaultAgent?.(env.orgId);
    if (secretary) {
      agentId = secretary;
      matchedScope = 'global';
    }
  }

  if (!agentId || !matchedScope) return undefined;

  return {
    instanceId,
    agentId,
    conversationKey: conversationKeyOf({ instanceId: inst, nativeId: env.nativeId, kind }),
    matchedScope,
    kind,
    ignored: isInboundIgnored(kind),
  };
}
