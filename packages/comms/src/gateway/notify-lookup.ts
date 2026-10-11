/**
 * Production notify-target lookup (messaging-gateway.md §7.3, slice G4).
 *
 * Reads `channel_bindings` — the same table that routes inbound — for the
 * *outbound* question, "where does this agent's notifications go?".
 *
 * ── The three levels, precisely ──────────────────────────────────────────────
 * 1. **agent**    — the agent's *own* addressable conversation. An explicit
 *                   `kind = 'notification'` binding wins; otherwise the agent's
 *                   own channel is used (which is what "the agent's channel" means
 *                   to a user — the two cannot disagree, by construction).
 * 2. **instance** — a notification sink declared *on the instance* the agent works
 *                   in. Either an explicit `kind = 'notification'` binding with a
 *                   native id, or the instance's **notification-target agent**
 *                   (`config.notifyAgentId`, set by the Settings UI) — in which
 *                   case the sink is that agent's own conversation. Lets an
 *                   operator say "everything on the sales bot notifies here"
 *                   without per-agent rows.
 * 3. **global**   — the Secretary's own conversation (level 1, applied to the org's
 *                   Secretary), else the platform's legacy notify channel.
 *
 * Why level 1 accepts a non-`notification` binding: the G1 migration seeds routing
 * bindings with `kind = NULL` (it has no way to know which conversation should
 * receive notifications). Requiring the marker would make level 1 and 3 dead on
 * every migrated install — i.e. notifications *would* be isolated, the exact
 * defect this slice removes. Preference order keeps an explicit choice supreme
 * while guaranteeing a terminus.
 *
 * Structural types on purpose: comms does not import `@markus/storage`, so a
 * storage row is assignable without a cast and tests use plain objects.
 */
import type { NotifyTarget, NotifyTargetLookup } from './notify-route.js';

/** Structural view of a `channel_bindings` row. */
export interface BindingRowLike {
  id: string;
  orgId: string;
  scope: string;
  instanceId: string | null;
  nativeId: string | null;
  kind: string | null;
  agentId: string;
}

/** Structural view of a `platform_instances` row (only what the lookup needs). */
export interface InstanceRowLike {
  id: string;
  platform: string;
  /** The instance's config blob — carries the G5 notification-target choice. */
  config?: Record<string, unknown> | null;
}

export interface RepoNotifyTargetLookupDeps {
  bindingRepo: { listByOrg(orgId: string): BindingRowLike[] };
  /** Resolves a binding's instance id to its platform. Absent ⇒ no target is resolvable. */
  instanceRepo?: { findById(id: string): InstanceRowLike | undefined };
  /** Who is the org's Secretary — the owner of the global (level-3) default. */
  orgSecretaryId?: (orgId: string) => string | undefined;
  /**
   * Last-resort global target: the platform notification channel from legacy
   * config (`notifyChatId` / `notifyOpenId`). Consulted only when the Secretary
   * has no addressable binding, so a pre-G4 install keeps delivering.
   */
  fallback?: (orgId: string) => NotifyTarget | undefined;
}

/** The explicit notification-target marker on a binding. */
const NOTIFICATION_KIND = 'notification';

export class RepoNotifyTargetLookup implements NotifyTargetLookup {
  constructor(private readonly deps: RepoNotifyTargetLookupDeps) {}

  agentTarget(orgId: string, agentId: string): NotifyTarget | undefined {
    return this.ownTarget(this.deps.bindingRepo.listByOrg(orgId), agentId);
  }

  instanceTarget(orgId: string, agentId: string): NotifyTarget | undefined {
    const rows = this.deps.bindingRepo.listByOrg(orgId);
    // Which instances does this agent work in? Any binding mentioning it names one.
    const instanceIds = new Set(
      rows.filter((r) => r.agentId === agentId && r.instanceId).map((r) => r.instanceId as string),
    );
    if (instanceIds.size === 0) return undefined;

    // (a) An explicit `kind = 'notification'` sink declared on the instance.
    const sink = rows.find(
      (r) =>
        r.kind === NOTIFICATION_KIND &&
        r.nativeId !== null &&
        r.instanceId !== null &&
        instanceIds.has(r.instanceId),
    );
    if (sink) return this.toTarget(sink);

    // (b) The instance's *notification target agent* — the "Notification target"
    // chosen in Settings (G5), stored as `platform_instances.config.notifyAgentId`.
    // "Approvals and notifications about this bot are delivered here" (the UI's
    // own words): deliver to that agent's own addressable conversation. Empty ⇒
    // nothing is declared, and the walk falls through to the global level —
    // which is exactly the UI's "leave empty to use the org secretary".
    for (const instanceId of instanceIds) {
      const notifyAgentId = this.declaredNotifyAgent(instanceId);
      if (!notifyAgentId) continue;
      const target = this.ownTarget(rows, notifyAgentId);
      if (target) return target;
    }

    return undefined;
  }

  /**
   * The notification-target agent an instance declares, if any. This is the
   * reader that closes the G4×G5 seam: G5 writes the key, and until now nothing
   * read it, so the control persisted without ever taking effect.
   */
  private declaredNotifyAgent(instanceId: string): string | undefined {
    const value = this.deps.instanceRepo?.findById(instanceId)?.config?.['notifyAgentId'];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  globalTarget(orgId: string): NotifyTarget | undefined {
    const secretaryId = this.deps.orgSecretaryId?.(orgId);
    if (secretaryId) {
      const own = this.ownTarget(this.deps.bindingRepo.listByOrg(orgId), secretaryId);
      if (own) return own;
    }
    return this.deps.fallback?.(orgId);
  }

  /** An agent's own addressable conversation: explicit notification binding first, else any. */
  private ownTarget(rows: BindingRowLike[], agentId: string): NotifyTarget | undefined {
    const mine = rows.filter((r) => r.agentId === agentId && r.instanceId !== null && r.nativeId !== null);
    if (mine.length === 0) return undefined;
    const preferred = mine.find((r) => r.kind === NOTIFICATION_KIND) ?? mine[0];
    return this.toTarget(preferred);
  }

  private toTarget(row: BindingRowLike): NotifyTarget | undefined {
    if (!row.instanceId || !row.nativeId) return undefined;
    const instance = this.deps.instanceRepo?.findById(row.instanceId);
    if (!instance) return undefined;
    return {
      platform: instance.platform,
      instanceId: instance.id,
      nativeId: row.nativeId,
      kind: NOTIFICATION_KIND,
    };
  }
}
