/**
 * Production notify-target lookup (design: docs/architecture/notification-delivery.md §3).
 *
 * Answers the *outbound* question, "where could this message go?", from two tables
 * that already exist: `channel_bindings` (which conversation an agent already
 * lives in) and `platform_instances` (which bots exist and what they declare).
 *
 * It returns **every** candidate, most specific first — it does not pick one. The
 * single decision about which candidate is actually sendable belongs to
 * {@link resolveNotifyTarget}'s eligibility predicate (see notify-route.ts for why
 * collapsing the two questions is what silently dropped notifications on
 * 2026-10-16).
 *
 * ── The levels, precisely ────────────────────────────────────────────────────
 * 1. **agent**    — the agent's own addressable conversation binding.
 * 2. **instance** — a destination the instance *declares* in its config, read
 *                   through the generic `notifyTarget` field annotation. This is
 *                   the reliable terminus: it needs **no binding at all**, so a
 *                   bot the user configured in Settings delivers even when no
 *                   agent has ever been DM'd (fixes R1 / R5).
 * 3. **instance** — an explicit `kind = 'notification'` binding sink on one of
 *                   those instances.
 * 4. **instance** — the instance's `notifyAgentId` → that agent's conversation
 *                   (best-effort; needs the target agent to have a binding).
 * 5. **global**   — the Secretary's conversation, else any global-scope binding
 *                   with a native id.
 *
 * Every level reads the **DB** (`channel_bindings` / `platform_instances`) — the
 * single source Settings writes. There is deliberately no legacy `markus.json`
 * reader on this path (design §3 "Single source of truth"): the configured fact
 * and the consumed fact are the same fact.
 *
 * ── Candidate ordering is explicit, never `ORDER BY label` ───────────────────
 *
 * `platform_instances` comes back sorted by `(platform, label)`, and the old walk
 * let that storage order *be* the routing priority — so which bot carried the
 * org's notifications was decided by a **label string**. That is how a bot labelled
 * `CTO` silently outranked one labelled `default`. Ordering is now stated here, in
 * the one place that answers "where could this go": the instances the producing
 * agent works in, then the org's declared global sink, then the Secretary's, then
 * the rest in creation order. A label is a thing users type; it is not a route.
 *
 * ── A switched-off bot is not a candidate ────────────────────────────────────
 *
 * `platform_instances.enabled` is the bot's master switch (the toggle next to its
 * connection status). A disabled bot is not connected at all (`start.ts` skips it),
 * so emitting it as a candidate could only ever produce a send failure. It is
 * therefore excluded here — structurally, not as a policy the resolver has to know
 * about.
 *
 * Structural types on purpose: comms does not import `@markus/storage`, so a
 * storage row is assignable without a cast and tests use plain objects.
 */
import {
  receiveIdTypeForDestination,
  type NotifyCandidate,
  type NotifyScope,
  type NotifyTarget,
  type NotifyTargetLookup,
  type ResolvedNotifyTarget,
} from './notify-route.js';
import type { OutboundOrigin } from './outbound.js';
import { getManifest, type PlatformField } from '../platforms/registry.js';

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
  /** The instance's config blob — carries declared destinations + `notifyAgentId`. */
  config?: Record<string, unknown> | null;
  /**
   * The bot's master switch. `false` ⇒ not connected ⇒ never a destination.
   * Absent ⇒ treated as enabled (older callers and tests pass bare rows).
   */
  enabled?: boolean;
  /** Creation timestamp — the tie-break among otherwise equal instances. */
  createdAt?: string;
}

/** The instance reader the lookup needs — `findById` plus an optional org scan. */
export interface InstanceSource {
  findById(id: string): InstanceRowLike | undefined;
  /**
   * Every instance of the org. Optional: present in production (`platform_instances`),
   * and what lets a *declared* destination be found without any binding. Absent
   * ⇒ only the instances named by the agent's own bindings are considered.
   */
  listByOrg?(orgId: string): InstanceRowLike[];
}

export interface RepoNotifyTargetLookupDeps {
  bindingRepo: { listByOrg(orgId: string): BindingRowLike[] };
  /** Resolves a binding's instance id to its platform. Absent ⇒ no target is resolvable. */
  instanceRepo?: InstanceSource;
  /** Who is the org's Secretary — the owner of the global (level-5) default. */
  orgSecretaryId?: (orgId: string) => string | undefined;
  /**
   * Manifest field definitions for a platform — the `notifyTarget` annotation
   * source. Defaults to the platform registry; injectable so the declaration
   * scan is testable without a real manifest.
   */
  fieldDefs?: (platform: string) => PlatformField[];
}

/** The explicit notification-target marker on a binding. */
const NOTIFICATION_KIND = 'notification';

export class RepoNotifyTargetLookup implements NotifyTargetLookup {
  constructor(private readonly deps: RepoNotifyTargetLookupDeps) {}

  /**
   * Every destination this origin could reach, most specific first.
   *
   * `alternatives` on the resolved side comes from this list, so the caller can
   * show *which* of several configured bots won rather than leaving it implicit.
   */
  candidates(orgId: string, origin: OutboundOrigin): NotifyCandidate[] {
    const rows = this.deps.bindingRepo.listByOrg(orgId);
    const instances = this.orderedInstances(orgId, origin.agentId, rows);
    const out: NotifyCandidate[] = [];
    const seen = new Set<string>();
    const push = (target: NotifyTarget | undefined, scope: NotifyScope): void => {
      if (!target) return;
      // Two bindings can describe the same conversation; a destination is one fact.
      const key = `${target.instanceId ?? ''}|${target.receiveIdType ?? ''}|${target.nativeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ target, scope });
    };

    // 1. agent — the producing agent's own conversations.
    if (origin.agentId) {
      for (const target of this.agentTargets(rows, origin.agentId, instances)) push(target, 'agent');
    }

    // 2. instance — a destination declared in the instance's own config (R1's
    //    reliable terminus). Every declaring instance is offered, in order, so the
    //    resolver can move past one whose notifications are switched off.
    for (const instance of instances) push(this.declaredTargetOf(instance), 'instance');

    // 3. instance — an explicit `kind = 'notification'` binding sink.
    for (const instance of instances) push(this.sinkTargetOf(rows, instance.id), 'instance');

    // 4. instance — the instance's notify-target agent ("leave empty to use the
    //    org secretary"): deliver to that agent's own conversation.
    if (origin.agentId) {
      for (const instance of instances) push(this.notifyAgentTargetOf(rows, instance.id, instances), 'instance');
    }

    // 5. global — the Secretary's own conversation, else the org's declared sink.
    for (const target of this.globalTargets(rows, orgId, instances)) push(target, 'global');

    return out;
  }

  /**
   * Instances worth considering for this message, in a **stated** priority order:
   *
   *   1. the ones the producing agent already works in (its own bindings);
   *   2. the org's declared global sink (`scope = 'global'` binding);
   *   3. the Secretary's;
   *   4. the rest, in creation order (`createdAt`, then id).
   *
   * Never `(platform, label)`: a label an operator typed must not decide which bot
   * carries the org's approvals.
   */
  private orderedInstances(orgId: string, agentId: string | undefined, rows: BindingRowLike[]): InstanceRowLike[] {
    const priority: Array<string | null | undefined> = [];
    if (agentId) {
      for (const row of rows) if (row.agentId === agentId) priority.push(row.instanceId);
    }
    priority.push(rows.find((r) => r.scope === 'global' && r.instanceId)?.instanceId);
    const secretaryId = this.deps.orgSecretaryId?.(orgId);
    if (secretaryId) {
      for (const row of rows) if (row.agentId === secretaryId) priority.push(row.instanceId);
    }
    const all = [...(this.deps.instanceRepo?.listByOrg?.(orgId) ?? [])].sort(byCreatedThenId);
    for (const instance of all) priority.push(instance.id);

    const out: InstanceRowLike[] = [];
    const seen = new Set<string>();
    for (const id of priority) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const instance = this.deps.instanceRepo?.findById(id);
      // A switched-off bot is not connected, so it is not a destination.
      if (!instance || instance.enabled === false) continue;
      out.push(instance);
    }
    return out;
  }

  /**
   * An agent's own addressable conversations, an explicit `notification` binding
   * first (it is the operator saying "notify me *here*").
   */
  private agentTargets(
    rows: BindingRowLike[],
    agentId: string,
    instances: InstanceRowLike[],
  ): NotifyTarget[] {
    const usable = new Set(instances.map((i) => i.id));
    const mine = rows.filter(
      (r) => r.agentId === agentId && r.instanceId !== null && r.nativeId !== null && usable.has(r.instanceId),
    );
    // Stable sort: explicit notification bindings first, otherwise binding order.
    const ranked = [...mine].sort(
      (a, b) => notificationRank(a) - notificationRank(b),
    );
    return ranked.map((r) => this.toTarget(r)).filter((t): t is NotifyTarget => Boolean(t));
  }

  /** A routing-level `kind = 'notification'` sink declared on the instance. */
  private sinkTargetOf(rows: BindingRowLike[], instanceId: string): NotifyTarget | undefined {
    const sink = rows.find(
      (r) => r.kind === NOTIFICATION_KIND && r.nativeId !== null && r.instanceId === instanceId,
    );
    return sink ? this.toTarget(sink) : undefined;
  }

  /**
   * The notification-target *agent* an instance declares, if any, delivered to
   * that agent's own conversation. This is the reader that closes the G4×G5 seam:
   * G5 writes `config.notifyAgentId`, and until it had a reader the control
   * persisted without ever taking effect.
   */
  private notifyAgentTargetOf(
    rows: BindingRowLike[],
    instanceId: string,
    instances: InstanceRowLike[],
  ): NotifyTarget | undefined {
    const notifyAgentId = this.declaredNotifyAgent(instanceId);
    if (!notifyAgentId) return undefined;
    return this.ownTarget(rows, notifyAgentId, instances);
  }

  /**
   * The org-wide defaults, most explicit first: the Secretary's own conversation,
   * then any global-scope binding that carries a native id (the org's *declared*
   * global sink). Both come from the DB; there is no legacy `markus.json` fallback.
   */
  private globalTargets(rows: BindingRowLike[], orgId: string, instances: InstanceRowLike[]): NotifyTarget[] {
    const out: NotifyTarget[] = [];
    const secretaryId = this.deps.orgSecretaryId?.(orgId);
    if (secretaryId) {
      const own = this.ownTarget(rows, secretaryId, instances);
      if (own) out.push(own);
    }
    const globalSink = rows.find(
      (r) => r.scope === 'global' && r.nativeId !== null && r.instanceId !== null,
    );
    if (globalSink) {
      const target = this.toTarget(globalSink);
      if (target) out.push(target);
    }
    return out;
  }

  /**
   * Read the destination an instance config *declares*, via the manifest fields
   * carrying the `notifyTarget` annotation. Manifest order is the tie-break on
   * the (rare) platforms that declare more than one destination.
   *
   * Only a `chat` destination is meaningful today: a notification goes to a group
   * the bot was added to. The one surviving `user` destination is WhatsApp, whose
   * Cloud API exposes no group concept at all — expressible there, impossible
   * elsewhere.
   */
  private declaredTargetOf(instance: InstanceRowLike): NotifyTarget | undefined {
    for (const field of this.fieldDefs(instance.platform)) {
      if (!field.notifyTarget) continue;
      const raw = instance.config?.[field.key];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;
      return {
        platform: instance.platform,
        instanceId: instance.id,
        nativeId: value,
        receiveIdType: receiveIdTypeForDestination(field.notifyTarget),
        kind: NOTIFICATION_KIND,
      };
    }
    return undefined;
  }

  private fieldDefs(platform: string): PlatformField[] {
    return this.deps.fieldDefs?.(platform) ?? getManifest(platform)?.fields ?? [];
  }

  /** The `config.notifyAgentId` an instance declares, if any. */
  private declaredNotifyAgent(instanceId: string): string | undefined {
    const value = this.deps.instanceRepo?.findById(instanceId)?.config?.['notifyAgentId'];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** An agent's own addressable conversation among *enabled* instances. */
  private ownTarget(
    rows: BindingRowLike[],
    agentId: string,
    instances: InstanceRowLike[],
  ): NotifyTarget | undefined {
    const usable = new Set(instances.map((i) => i.id));
    const mine = rows.filter(
      (r) => r.agentId === agentId && r.instanceId !== null && r.nativeId !== null && usable.has(r.instanceId),
    );
    if (mine.length === 0) return undefined;
    const preferred = mine.find((r) => r.kind === NOTIFICATION_KIND) ?? mine[0];
    return this.toTarget(preferred);
  }

  private toTarget(row: BindingRowLike): NotifyTarget | undefined {
    if (!row.instanceId || !row.nativeId) return undefined;
    const instance = this.deps.instanceRepo?.findById(row.instanceId);
    if (!instance || instance.enabled === false) return undefined;
    return {
      platform: instance.platform,
      instanceId: instance.id,
      nativeId: row.nativeId,
      kind: NOTIFICATION_KIND,
    };
  }
}

/** Explicit `notification` bindings sort before ordinary ones. */
function notificationRank(row: BindingRowLike): number {
  return row.kind === NOTIFICATION_KIND ? 0 : 1;
}

/**
 * Stable, non-semantic instance order: creation time, then id. Used only to make
 * the *remaining* instances deterministic — never to express a routing preference
 * (that is why it is not `label`).
 */
function byCreatedThenId(a: InstanceRowLike, b: InstanceRowLike): number {
  const at = a.createdAt ?? '';
  const bt = b.createdAt ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Re-exported for callers that only need the shape. */
export type { ResolvedNotifyTarget };
