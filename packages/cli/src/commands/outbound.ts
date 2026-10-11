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
  RepoNotifyTargetLookup,
  RouterOutboundSink,
  renderCapabilitiesOf,
  getManifest,
  type BindingRowLike,
  type InstanceRowLike,
  type NotificationSource,
  type NotifyTarget,
} from '@markus/comms';
import { createLogger } from '@markus/shared';

const log = createLogger('outbound-setup');

export interface OutboundWiringOptions {
  router: { sendToChannel(platform: string, channelId: string, content: string, instanceId?: string): Promise<string | undefined> };
  /** `channel_bindings` reader. Absent ⇒ dispatch is not wired. */
  bindingRepo?: { listByOrg(orgId: string): BindingRowLike[] };
  /** `platform_instances` reader — resolves a binding's instance to its platform. */
  instanceRepo?: { findById(id: string): InstanceRowLike | undefined };
  /** Who is the org Secretary — the owner of the global (level-3) default. */
  orgSecretaryId?: () => string | undefined;
  /** Legacy platform notify channel, the global default's last resort. */
  legacyNotifyTarget?: (orgId: string) => NotifyTarget | undefined;
  /** HITL notification source (`HITLService`). */
  notificationSource?: NotificationSource;
  /** EventBus — task events are forwarded when present. */
  eventBus?: { on(event: string, fn: (payload: unknown) => void): () => void };
  orgId?: string;
  /** Buffer `info` messages into a periodic digest instead of sending each. */
  digestInfo?: boolean;
  /** Secret for signing approval action refs. */
  actionSecret?: string;
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

  const lookup = new RepoNotifyTargetLookup({
    bindingRepo: opts.bindingRepo,
    instanceRepo: opts.instanceRepo,
    orgSecretaryId: opts.orgSecretaryId,
    fallback: opts.legacyNotifyTarget,
  });

  const sink = new RouterOutboundSink({
    router: opts.router,
    // Capabilities come from the platform manifest — a new platform teaches the
    // gateway what it can render, with no code here.
    capabilitiesOf: (platform) => renderCapabilitiesOf(getManifest(platform)?.capabilities),
  });

  const dispatcher = new OutboundDispatcher({
    lookup,
    sink,
    orgId,
    digestInfo: opts.digestInfo,
    actionSecret: opts.actionSecret,
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
