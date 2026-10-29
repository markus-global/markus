/**
 * Wire the outbound dispatcher into a running backend (design §7, slice G4).
 *
 * Kept out of `start.ts` so the assembly is small, testable and obvious: bind the
 * two ports (a `channel_bindings`-backed lookup, a router-backed sink), subscribe
 * to HITL notifications and EventBus task events, hand back a detacher.
 *
 * Before this, "approval reached a chat app" existed only inside the Feishu
 * notifier, which is why no other platform could carry one. Nothing here is
 * platform-specific: a new platform becomes reachable by having an instance row.
 */
import {
  OutboundDispatcher,
  RepoNotifyPreferenceSource,
  RepoNotifyTargetLookup,
  RouterOutboundSink,
  renderCapabilitiesOf,
  getManifest,
  type BindingRowLike,
  type InstanceSource,
  type NotificationSource,
  type SendOptions,
  type PlatformField,
  type NotificationLike,
  type DispatchOutcome,
} from '@markus/comms';
import { createLogger } from '@markus/shared';

const log = createLogger('outbound-setup');

export interface OutboundWiringOptions {
  router: {
    sendToChannel(
      platform: string,
      channelId: string,
      content: string,
      instanceId?: string,
      options?: SendOptions,
    ): Promise<string | undefined>;
  };
  /** `channel_bindings` reader. Absent ⇒ dispatch is not wired. */
  bindingRepo?: { listByOrg(orgId: string): BindingRowLike[] };
  /**
   * `platform_instances` reader — resolves a binding's instance to its platform,
   * and (via `listByOrg`) finds a **declared** destination without any binding
   * (the reliable terminus, design §3 step 2).
   */
  instanceRepo?: InstanceSource;
  /** Who is the org Secretary — the owner of the global (level-3) default. */
  orgSecretaryId?: () => string | undefined;
  /**
   * Manifest field definitions per platform — the `notifyTarget` annotation
   * source for a **declared** destination. Defaults to the platform registry;
   * injectable so the DB→outbound path is testable without the real manifest.
   */
  fieldDefs?: (platform: string) => PlatformField[];
  /** HITL notification source (`HITLService`). */
  notificationSource?: NotificationSource;
  /** EventBus — task events are forwarded when present. */
  eventBus?: { on(event: string, fn: (payload: unknown) => void): () => void };
  orgId?: string;
  /** Buffer `info` messages into a periodic digest instead of sending each. */
  digestInfo?: boolean;
  /** Secret for signing approval action refs. */
  actionSecret?: string;
  /**
   * Resolve an agent's display name from its id — lets a delivered notification
   * name the agent that sent it (`agentId` → "来自 Agent 名"). Optional; without
   * it, notifications are delivered unattributed rather than with a raw id.
   */
  agentName?: (agentId: string) => string | undefined;
  /**
   * Resolve the team an agent belongs to — shown alongside the agent so a
   * notification says which team it came from. Optional and independent of
   * `agentName`: a missing team never blocks a delivery.
   */
  agentTeamName?: (agentId: string) => string | undefined;
  /**
   * Resolve the language outbound approval buttons are written in — the
   * recipient's locale. Optional; absent means English defaults, so the wiring
   * stays usable in a context that knows nothing about users.
   */
  locale?: () => string | undefined;
  /**
   * Delivered-message hook. The only place a caller ever learns the platform
   * message id — and that id is what a later state change needs in order to
   * converge the message the human is holding (e.g. an approval card decided in
   * the Markus UI must stop looking clickable in the chat app).
   */
  onDelivered?: (notification: NotificationLike, outcome: DispatchOutcome) => void;
}

export interface OutboundWiring {
  dispatcher: OutboundDispatcher;
  /** Unsubscribe every source this wiring attached. */
  detach: () => void;
}

/**
 * Build and attach the outbound dispatcher. Returns `undefined` when there is no
 * binding store to resolve targets from — in that case the legacy notifier path
 * still runs, and we say so rather than pretending dispatch is active.
 */
export function setupOutboundDispatch(opts: OutboundWiringOptions): OutboundWiring | undefined {
  if (!opts.bindingRepo) {
    log.warn('Outbound dispatch not wired — no channel-binding store available');
    return undefined;
  }
  const orgId = opts.orgId ?? 'default';

  // Every destination is resolved from the DB — `channel_bindings` plus the
  // `platform_instances.config` that Settings writes. No `markus.json` reader
  // here (design §3 "Single source of truth").
  const lookup = new RepoNotifyTargetLookup({
    bindingRepo: opts.bindingRepo,
    instanceRepo: opts.instanceRepo,
    orgSecretaryId: opts.orgSecretaryId,
    fieldDefs: opts.fieldDefs,
  });

  const sink = new RouterOutboundSink({
    router: opts.router,
    // Capabilities come from the platform manifest — a new platform teaches the
    // gateway what it can render, with no code here.
    capabilitiesOf: (platform) => renderCapabilitiesOf(getManifest(platform)?.capabilities),
  });

  // Preference enforcement reads the *same* `platform_instances` source the
  // lookup resolves destinations from — one config source for both (design §3).
  const preferences = new RepoNotifyPreferenceSource({ instanceRepo: opts.instanceRepo });

  const dispatcher = new OutboundDispatcher({
    lookup,
    sink,
    preferences,
    orgId,
    digestInfo: opts.digestInfo,
    actionSecret: opts.actionSecret,
    agentName: opts.agentName,
    agentTeamName: opts.agentTeamName,
    locale: opts.locale,
    onDelivered: opts.onDelivered,
  });

  const detachers: Array<() => void> = [];
  if (opts.notificationSource) {
    detachers.push(dispatcher.attachNotifications(opts.notificationSource));
  }
  if (opts.eventBus) detachers.push(dispatcher.attachEventBus(opts.eventBus));

  log.info('Outbound dispatcher wired', {
    orgId,
    sources: detachers.length,
    digest: Boolean(opts.digestInfo),
  });

  return {
    dispatcher,
    detach: () => {
      for (const d of detachers) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
