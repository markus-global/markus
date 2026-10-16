/**
 * The router-backed outbound sink (messaging-gateway.md §7.4, slice G4).
 *
 * Thin by design: it maps a {@link NotifyTarget} onto the adapter router's
 * `sendToChannel`, forwarding the **instance id** so a platform hosting several
 * bots sends through the right one — closing the gap G2 left open (a lookup
 * without an instance warns and picks the first bot).
 *
 * It also carries the two facts the transport used to discard (slice T2):
 *   • the renderer's **format** — so a card-capable platform takes its card path
 *     instead of every notification degrading to literal `[label] ref` text (R3);
 *   • the target's **receiveIdType** — so a destination can be a user DM, not
 *     only a chat (R4).
 *
 * Capabilities come from a callback rather than the router so the caller decides
 * where they are derived from (manifest `capabilities`, narrowed by the instance
 * row) without this file knowing about the registry.
 */
import type { OutboundSink } from './dispatcher.js';
import type { NotifyTarget } from './notify-route.js';
import type { RenderCapabilities, RenderedOutbound } from './render.js';
import type { SendOptions } from '../adapter.js';

export interface RouterOutboundSinkDeps {
  router: {
    sendToChannel(
      platform: string,
      channelId: string,
      content: string,
      instanceId?: string,
      options?: SendOptions,
    ): Promise<string | undefined>;
  };
  capabilitiesOf: (platform: string, instanceId?: string) => RenderCapabilities;
}

export class RouterOutboundSink implements OutboundSink {
  constructor(private readonly deps: RouterOutboundSinkDeps) {}

  capabilities(target: NotifyTarget): RenderCapabilities {
    return this.deps.capabilitiesOf(target.platform, target.instanceId);
  }

  send(target: NotifyTarget, rendered: RenderedOutbound): Promise<string | undefined> {
    // Carry the *format decision* the renderer already made to the adapter,
    // which owns the dialect. Discarding it here is why a markdown notification
    // arrived with literal `**` on every platform that is not Discord, and why a
    // card-capable platform never sent a card.
    const options: SendOptions = {
      format: rendered.format,
      markdown: rendered.format !== 'text',
    };
    // The addressing type the resolver chose (R4) — e.g. Feishu `open_id` for a
    // user DM instead of the old hard-coded `chat_id`.
    if (target.receiveIdType) options.receiveIdType = target.receiveIdType;
    // Structured content, only when a card was chosen: the adapter builds its own
    // dialect from this; the gateway never speaks a platform's card JSON.
    if (rendered.format === 'card') {
      options.card = {
        title: rendered.title,
        body: rendered.body,
        actions: rendered.actions.map((a) => ({
          id: a.id,
          label: a.label,
          ...(a.style ? { style: a.style } : {}),
          ref: a.ref,
        })),
        // The origin travels as structure so the card places the sender (and its
        // team) in its own slot instead of cramming it into the body text.
        ...(rendered.origin ? { origin: rendered.origin } : {}),
      };
    }
    return this.deps.router.sendToChannel(
      target.platform,
      target.nativeId,
      rendered.text,
      target.instanceId,
      options,
    );
  }
}
