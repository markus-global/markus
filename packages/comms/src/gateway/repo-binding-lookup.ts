/**
 * The DB-backed {@link BindingLookup} — the single writer for inbound routing
 * (design §2 "binding resolution: two writers ✗" → one).
 *
 * It reads the two G1 tables through *structural* ports, so this package keeps
 * its "no storage dependency" boundary: callers hand it the SQLite repos and the
 * types line up.
 *
 * ── Where a bot's answering agent lives ─────────────────────────────────────
 *
 * Exactly one place: `platform_instances.config.agentId` — the field the
 * Settings card writes and reads back. This lookup **derives** the instance
 * level from that row; it does not read a separate `scope='instance'` binding
 * row.
 *
 * It used to read such a row, and nothing ever wrote one for a bot created or
 * edited through Settings (that path only ever touched `config.agentId`). The
 * instance level therefore never matched, every inbound message fell through to
 * the global Secretary, and the "binding an agent" feature was silently inert
 * on *every* platform. A route with no writer is not a route. Deriving the
 * route from the row the user actually edits is what keeps the settings write
 * and the routing read on ONE source of truth — there is no second copy to
 * drift out of sync.
 *
 * The platform level is realised the same way: the answering agent of the
 * platform's `label='default'` instance (design §6.3), read from *its* config.
 */

import type { BindingLookup, ScopeBinding } from './inbound.js';

/** The label the G1 migration gives the single migrated bot of a platform. */
export const DEFAULT_INSTANCE_LABEL = 'default';

/** Structural view of `channel_bindings` (satisfied by SqliteChannelBindingRepo). */
export interface ChannelBindingSource {
  listByOrg(orgId: string): ReadonlyArray<{
    scope: string;
    instanceId: string | null;
    nativeId: string | null;
    kind: string | null;
    agentId: string;
  }>;
}

/**
 * Structural view of `platform_instances` (satisfied by
 * SqlitePlatformInstanceRepo). `config` is where a bot keeps its answering
 * agent, under the `agentId` key — the one the Settings form writes.
 */
export interface PlatformInstanceSource {
  listByPlatform(
    orgId: string,
    platform: string,
  ): ReadonlyArray<{ id: string; label: string; config?: Record<string, unknown> | null }>;
}

export interface RepoBindingLookupDeps {
  bindingRepo: ChannelBindingSource;
  instanceRepo: PlatformInstanceSource;
  /**
   * Terminal fallback for level 5 when no `global` binding row exists — the org
   * Secretary. Keeps `resolveInboundTarget` from returning `undefined` in
   * practice (design §6.1 "step 5 always resolves").
   */
  orgDefaultAgent?: (orgId: string) => string | undefined;
}

/**
 * Stored rows route at exactly two scopes: `global` and `channel`.
 *
 * Anything else is **not a route** — and must not become one by default. The old
 * `else → 'global'` fallback answered a different question than the one asked:
 * a row whose `scope` we do not recognise (a future column-carrier such as a
 * mailbox-address binding, `scope='address'`) was silently promoted to the
 * org-wide fallback, so it would have become the answer for *every* unbound
 * inbound message in the org. That is the same defect family as reading a
 * persona out of a payload: structure inferred from a value that does not mean
 * it. `instance` is **derived** from the instance row (see `bindings()`), never
 * read from a stored binding row.
 *
 * Returning `null` (skip) keeps legitimate legacy rows untouched: production
 * only ever holds `global` / `channel` / `instance`.
 */
function storedRoutingScope(scope: string): 'global' | 'channel' | null {
  return scope === 'global' || scope === 'channel' ? scope : null;
}

/** A bot's answering agent, read from its own row — its `config.agentId`. */
function answeringAgentId(instance: {
  config?: Record<string, unknown> | null;
}): string | undefined {
  const raw = instance.config?.['agentId'];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

export class RepoBindingLookup implements BindingLookup {
  constructor(private readonly deps: RepoBindingLookupDeps) {}

  /**
   * `channel_bindings` has no platform column, so an instance-scope row belongs
   * to this platform only if its instance does; `global` rows are
   * platform-agnostic.
   *
   * `scope='instance'` routes are **derived** from the instance rows, never read
   * from a binding row: the settings write path owns `config.agentId`, so a
   * stored copy would be a second writer of the same fact — and, having no
   * writer at all, was always absent (the defect this class fixes).
   */
  bindings(orgId: string, platform: string): readonly ScopeBinding[] {
    const instances = this.deps.instanceRepo.listByPlatform(orgId, platform);
    const instanceIds = new Set(instances.map((i) => i.id));
    const out: ScopeBinding[] = [];

    for (const row of this.deps.bindingRepo.listByOrg(orgId)) {
      // Instance scope is derived below — a stored row would be a stale second
      // copy of the bot's own `config.agentId`. Any other unknown scope
      // (e.g. `address`) is not a route at all: skip, never promote.
      const scope = storedRoutingScope(row.scope);
      if (scope === null) continue;
      if (scope !== 'global' && (row.instanceId === null || !instanceIds.has(row.instanceId))) {
        continue;
      }
      out.push({
        scope,
        instanceId: row.instanceId,
        nativeId: row.nativeId,
        kind: row.kind,
        agentId: row.agentId,
      });
    }

    // Level 3 — each bot answers as the agent its own row names. This is the
    // field the Settings card writes, so the two are the same fact.
    for (const instance of instances) {
      const agentId = answeringAgentId(instance);
      if (agentId) {
        out.push({ scope: 'instance', instanceId: instance.id, nativeId: null, kind: null, agentId });
      }
    }

    return out;
  }

  platformDefaultAgent(orgId: string, platform: string): string | undefined {
    const def = this.deps.instanceRepo
      .listByPlatform(orgId, platform)
      .find((i) => i.label === DEFAULT_INSTANCE_LABEL);
    return def ? answeringAgentId(def) : undefined;
  }

  orgDefaultAgent(orgId: string): string | undefined {
    return this.deps.orgDefaultAgent?.(orgId);
  }
}
