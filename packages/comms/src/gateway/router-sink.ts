/**
 * The router-backed outbound sink (messaging-gateway.md §7.4, slice G4).
 *
 * Thin by design: it maps a {@link NotifyTarget} onto the adapter router's
 * `sendToChannel`, forwarding the **instance id** so a platform hosting several
 * bots sends through the right one — closing the gap G2 left open (a lookup
 * without an instance warns and picks the first bot).
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
    // arrived with literal `**` on every platform that is not Discord.
    const markdown = rendered.format !== 'text';
    return this.deps.router.sendToChannel(
      target.platform,
      target.nativeId,
      rendered.text,
      target.instanceId,
      { markdown },
    );
  }
}
