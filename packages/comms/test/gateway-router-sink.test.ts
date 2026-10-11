/**
 * Slice G4 — the router-backed sink.
 *
 * The sink's one responsibility: turn a resolved target + a rendered message into
 * one adapter call, carrying the **instance id** so a platform with several bots
 * sends through the right one (the gap G2 flagged: `sendToChannel` without an
 * instance warns and picks the first bot).
 */
import { describe, it, expect, vi } from 'vitest';
import { RouterOutboundSink } from '../src/gateway/router-sink.js';
import { renderOutbound } from '../src/gateway/render.js';

const TARGET = { platform: 'telegram', instanceId: 'bi_sales', nativeId: '111', kind: 'notification' };
const RENDERED = renderOutbound({ title: 't', body: 'b', severity: 'info' }, { markdown: true });

describe('RouterOutboundSink', () => {
  it('sends through the router with platform, native id, text, instance id and the format decision', async () => {
    const sendToChannel = vi.fn(async () => 'm_1');
    const sink = new RouterOutboundSink({
      router: { sendToChannel },
      capabilitiesOf: () => ({ markdown: true }),
    });

    const id = await sink.send(TARGET, RENDERED);
    expect(id).toBe('m_1');
    // The renderer's format choice must reach the adapter, not be discarded here.
    expect(sendToChannel).toHaveBeenCalledWith('telegram', '111', RENDERED.text, 'bi_sales', {
      markdown: true,
    });
  });

  it('reports the target capabilities', () => {
    const sink = new RouterOutboundSink({
      router: { sendToChannel: async () => undefined },
      capabilitiesOf: (platform, instanceId) => ({ cards: platform === 'slack' && instanceId === 'bi_ops' }),
    });
    expect(sink.capabilities({ platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' })).toEqual({ cards: true });
    expect(sink.capabilities({ platform: 'telegram', instanceId: 'bi_a', nativeId: '1' })).toEqual({ cards: false });
  });
});
