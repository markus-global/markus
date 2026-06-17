import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { SlackClient } from '../src/slack/client.js';

function signBody(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return 'v0=' + createHmac('sha256', secret).update(base).digest('hex');
}

describe('SlackClient', () => {
  let client: SlackClient;
  const secret = 'test-signing-secret';

  beforeEach(() => {
    client = new SlackClient({ botToken: 'xoxb-test', signingSecret: secret });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('verifySignature', () => {
    it('accepts valid signatures', () => {
      const body = '{"type":"event_callback"}';
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = signBody(secret, ts, body);
      expect(client.verifySignature(sig, ts, body)).toBe(true);
    });

    it('rejects invalid signatures', () => {
      const body = '{"type":"event_callback"}';
      const ts = String(Math.floor(Date.now() / 1000));
      expect(client.verifySignature('v0=deadbeef', ts, body)).toBe(false);
    });

    it('rejects timestamps older than 5 minutes', () => {
      const body = '{}';
      const ts = String(Math.floor(Date.now() / 1000) - 600);
      const sig = signBody(secret, ts, body);
      expect(client.verifySignature(sig, ts, body)).toBe(false);
    });

    it('allows any signature when signing secret is empty', () => {
      const noSecret = new SlackClient({ botToken: 'xoxb-test', signingSecret: '' });
      expect(noSecret.verifySignature('v0=anything', '123', '{}')).toBe(true);
    });
  });

  describe('API methods', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: async () => ({ ok: true, ts: '1234.5678', channel: 'C1' }),
        }),
      );
    });

    it('sendTextMessage returns message ts', async () => {
      const ts = await client.sendTextMessage('C123', 'Hello', { thread_ts: '1111.2222' });
      expect(ts).toBe('1234.5678');
    });

    it('sendTextMessage throws on API error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: 'channel_not_found' }) }),
      );
      await expect(client.sendTextMessage('C999', 'Hi')).rejects.toThrow('channel_not_found');
    });

    it('sendBlocksMessage returns message ts', async () => {
      const blocks = [{ type: 'section', text: { type: 'plain_text', text: 'Hi' } }];
      const ts = await client.sendBlocksMessage('C123', blocks, 'fallback');
      expect(ts).toBe('1234.5678');
    });

    it('updateMessage succeeds', async () => {
      await expect(client.updateMessage('C123', '1234.5678', 'updated')).resolves.toBeUndefined();
    });

    it('deleteMessage succeeds', async () => {
      await expect(client.deleteMessage('C123', '1234.5678')).resolves.toBeUndefined();
    });

    it('deleteMessage throws on API error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: 'message_not_found' }) }),
      );
      await expect(client.deleteMessage('C123', '9999.0000')).rejects.toThrow('message_not_found');
    });
  });
});
