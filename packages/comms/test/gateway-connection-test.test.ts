import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@markus/shared';
import { ConnectionTestRegistry, type ConnectionTestSender } from '../src/gateway/connection-test.js';

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    platform: 'telegram',
    direction: 'inbound',
    channelId: 'chat-1',
    senderId: 'user-1',
    senderName: 'User',
    agentId: '',
    content: { type: 'text', text: 'hello' },
    timestamp: new Date().toISOString(),
    ...over,
  };
}

/** A sender that records what it was asked to deliver and resolves. */
function recordingSender(): { sender: ConnectionTestSender; sent: Array<{ instanceId: string; channelId: string; text: string }> } {
  const sent: Array<{ instanceId: string; channelId: string; text: string }> = [];
  return {
    sent,
    sender: {
      async send(instanceId, channelId, text) {
        sent.push({ instanceId, channelId, text });
      },
    },
  };
}

describe('ConnectionTestRegistry', () => {
  it('sends a prompt and records the outbound leg as ok', async () => {
    const { sender, sent } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender, code: () => 'ABC123' });

    const run = await registry.begin('bi_1', 'telegram', { channelId: 'chat-1', name: 'Ops' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ instanceId: 'bi_1', channelId: 'chat-1', text: expect.stringContaining('ABC123') });
    expect(run.status).toBe('awaiting_reply');
    expect(run.code).toBe('ABC123');
    expect(run.outbound.state).toBe('ok');
    expect(run.inbound.state).toBe('pending');
  });

  it('consumes a reply in the target channel and verifies both legs', async () => {
    const { sender, sent } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender, code: () => 'ABC123' });
    await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    const consumed = await registry.noteInbound(message({ instanceId: 'bi_1', channelId: 'chat-1', text: 'ABC123' }));

    expect(consumed).toBe(true);
    const run = registry.get('bi_1')!;
    expect(run.status).toBe('verified');
    expect(run.inbound.state).toBe('ok');
    expect(run.outbound.state).toBe('ok');
    // prompt + acknowledgement
    expect(sent).toHaveLength(2);
  });

  it('does not consume a message from a different channel', async () => {
    const { sender } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender });
    await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    const consumed = await registry.noteInbound(message({ instanceId: 'bi_1', channelId: 'chat-2' }));

    expect(consumed).toBe(false);
    expect(registry.get('bi_1')!.status).toBe('awaiting_reply');
  });

  it('does not consume anything when no run was started', async () => {
    const { sender } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender });
    expect(await registry.noteInbound(message({ instanceId: 'bi_9' }))).toBe(false);
  });

  it('starts inbound-first when no target is known, and the ack measures outbound', async () => {
    const { sender, sent } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender });

    const started = await registry.begin('bi_1', 'telegram', null);
    expect(started.status).toBe('awaiting_inbound');
    expect(started.code).toBeNull();
    expect(sent).toHaveLength(0);

    expect(await registry.noteInbound(message({ instanceId: 'bi_1', channelId: 'chat-7' }))).toBe(true);

    const run = registry.get('bi_1')!;
    expect(run.status).toBe('verified');
    expect(run.targetChannelId).toBe('chat-7');
    // the acknowledgement *is* the outbound evidence in this shape
    expect(run.outbound.state).toBe('ok');
    expect(sent[0]?.channelId).toBe('chat-7');
  });

  it('falls back to inbound-first when the prompt cannot be sent', async () => {
    const sender: ConnectionTestSender = {
      send: vi.fn().mockRejectedValue(new Error('not a member of this chat')),
    };
    const registry = new ConnectionTestRegistry({ sender });

    const run = await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    expect(run.outbound.state).toBe('failed');
    expect(run.outbound.detail).toContain('not a member');
    expect(run.status).toBe('awaiting_inbound');
    expect(run.code).toBeNull();
    // The unusable target is cleared, so the reply may come from anywhere.
    expect(run.targetChannelId).toBeNull();
  });

  it('expires a run once the window closes', async () => {
    let now = 1_000_000;
    const { sender } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender, now: () => now, ttlMs: 1000 });
    await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    now += 5000;

    expect(registry.get('bi_1')!.status).toBe('expired');
    expect(await registry.noteInbound(message({ instanceId: 'bi_1', channelId: 'chat-1' }))).toBe(false);
  });

  it('matches an instance-less message only when the platform run is unambiguous', async () => {
    const { sender } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender });
    await registry.begin('bi_1', 'telegram', null);

    // One run on telegram → an instance-less legacy message can be attributed.
    expect(await registry.noteInbound(message({ platform: 'telegram' }))).toBe(true);

    // Two runs on telegram → attributing the reply would guess; refuse instead.
    const two = new ConnectionTestRegistry({ sender });
    await two.begin('bi_1', 'telegram', null);
    await two.begin('bi_2', 'telegram', null);
    expect(await two.noteInbound(message({ platform: 'telegram' }))).toBe(false);
  });

  it('writes the durable fact before publishing the run as verified', async () => {
    const { sender } = recordingSender();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onVerified = vi.fn(() => gate);
    const registry = new ConnectionTestRegistry({ sender, code: () => 'ABC123', onVerified });
    await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    const pending = registry.noteInbound(
      message({ instanceId: 'bi_1', channelId: 'chat-1', text: 'ABC123' }),
    );
    // Let the handler reach the persistence step (past the acknowledgement send).
    await new Promise((r) => setTimeout(r, 0));
    expect(onVerified).toHaveBeenCalled();

    // A reader (the Settings badge reloads when it observes `verified`) must never
    // see the run flip before the row it implies exists: doing so made the badge
    // re-read a stale row and fall straight back to "unverified".
    expect(registry.get('bi_1')!.status).not.toBe('verified');

    release();
    await pending;
    expect(registry.get('bi_1')!.status).toBe('verified');
  });

  it('still verifies when recording the durable fact fails', async () => {
    const { sender } = recordingSender();
    const registry = new ConnectionTestRegistry({
      sender,
      onVerified: () => Promise.reject(new Error('disk full')),
    });
    await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    // Best-effort by contract: the handshake already happened, so a storage
    // failure must not turn a completed verification into a failed one.
    await expect(
      registry.noteInbound(message({ instanceId: 'bi_1', channelId: 'chat-1', text: 'x' })),
    ).resolves.toBe(true);
    expect(registry.get('bi_1')!.status).toBe('verified');
  });

  it('never mutates live state through the returned snapshot', async () => {
    const { sender } = recordingSender();
    const registry = new ConnectionTestRegistry({ sender });
    await registry.begin('bi_1', 'telegram', { channelId: 'chat-1' });

    const copy = registry.get('bi_1')!;
    copy.status = 'expired';
    copy.outbound.state = 'failed';

    expect(registry.get('bi_1')!.status).toBe('awaiting_reply');
    expect(registry.get('bi_1')!.outbound.state).toBe('ok');
  });
});
