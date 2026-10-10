/**
 * The DB-backed {@link BindingLookup} — the single writer for inbound routing
 * (design §2 "binding resolution: two writers ✗" → one).
 *
 * It reads the two G1 tables through *structural* ports, so this package keeps
 * its "no storage dependency" boundary: callers hand it the SQLite repos and the
 * types line up. The platform level is realised as the platform's
 * `label='default'` instance binding (design §6.3) — no schema change.
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

/** Structural view of `platform_instances` (satisfied by SqlitePlatformInstanceRepo). */
export interface PlatformInstanceSource {
  listByPlatform(
    orgId: string,
    platform: string,
  ): ReadonlyArray<{ id: string; label: string }>;
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

function asScope(scope: string): ScopeBinding['scope'] {
  return scope === 'channel' || scope === 'instance' ? scope : 'global';
}

export class RepoBindingLookup implements BindingLookup {
  constructor(private readonly deps: RepoBindingLookupDeps) {}

  /**
   * `channel_bindings` has no platform column, so an instance-scope row belongs
   * to this platform only if its instance does; `global` rows are
   * platform-agnostic.
   */
  bindings(orgId: string, platform: string): readonly ScopeBinding[] {
    const instanceIds = new Set(
      this.deps.instanceRepo.listByPlatform(orgId, platform).map((i) => i.id),
    );
    const out: ScopeBinding[] = [];
    for (const row of this.deps.bindingRepo.listByOrg(orgId)) {
      const scope = asScope(row.scope);
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
    return out;
  }

  platformDefaultAgent(orgId: string, platform: string): string | undefined {
    const def = this.deps.instanceRepo
      .listByPlatform(orgId, platform)
      .find((i) => i.label === DEFAULT_INSTANCE_LABEL);
    if (!def) return undefined;
    for (const row of this.deps.bindingRepo.listByOrg(orgId)) {
      if (row.scope === 'instance' && row.instanceId === def.id) return row.agentId;
    }
    return undefined;
  }

  orgDefaultAgent(orgId: string): string | undefined {
    return this.deps.orgDefaultAgent?.(orgId);
  }
}
