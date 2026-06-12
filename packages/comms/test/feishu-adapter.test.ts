import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuAdapter } from '../src/feishu/adapter.js';
import type { FeishuClient } from '../src/feishu/client.js';

// Factory to create a mock FeishuClient
function makeMockClient(): Partial<FeishuClient> {
  return {
    getTenantToken: vi.fn().mockResolvedValue('mock-token'),
    sendTextMessage: vi.fn().mockResolvedValue('om_mock_sent'),
    sendInteractiveMessage: vi.fn().mockResolvedValue('om_mock_card'),
    replyMessage: vi.fn().mockResolvedValue('om_mock_reply'),
    replyCard: vi.fn().mockResolvedValue('om_mock_reply_card'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    adapter = new FeishuAdapter();
    mockClient = makeMockClient();
    // Inject mock client via property access (adapter's client is private, but we use duck-typing for tests)
    (adapter as Record<string, unknown>)['client'] = mockClient;
    (adapter as Record<string, unknown>)['connected'] = true;
  });

  describe('updateMessage', () => {
    it('should delegate to client.updateMessage', async () => {
      await adapter.updateMessage('oc_channel', 'om_msg', 'updated text');

      expect(mockClient.updateMessage).toHaveBeenCalledWith(
        'om_msg',
        JSON.stringify({ text: 'updated text' }),
      );
    });

    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(
        adapter.updateMessage('oc_channel', 'om_msg', 'text'),
      ).rejects.toThrow('Feishu adapter not connected');
    });

    it('should propagate client errors', async () => {
      mockClient.updateMessage = vi.fn().mockRejectedValue(new Error('update failed'));

      await expect(
        adapter.updateMessage('oc_channel', 'om_msg', 'text'),
      ).rejects.toThrow('update failed');
    });
  });

  describe('deleteMessage', () => {
    it('should delegate to client.deleteMessage', async () => {
      await adapter.deleteMessage('oc_channel', 'om_msg');

      expect(mockClient.deleteMessage).toHaveBeenCalledWith('om_msg');
    });

    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(
        adapter.deleteMessage('oc_channel', 'om_msg'),
      ).rejects.toThrow('Feishu adapter not connected');
    });

    it('should propagate client errors', async () => {
      mockClient.deleteMessage = vi.fn().mockRejectedValue(new Error('delete failed'));

      await expect(
        adapter.deleteMessage('oc_channel', 'om_msg'),
      ).rejects.toThrow('delete failed');
    });
  });

  describe('sendReply', () => {
    it('should send a text reply via client.replyMessage', async () => {
      const result = await adapter.sendReply('oc_channel', 'om_original', 'Hello reply');

      expect(result).toBe('om_mock_reply');
      expect(mockClient.replyMessage).toHaveBeenCalledWith(
        'om_original',
        JSON.stringify({ text: 'Hello reply' }),
      );
    });

    it('should send an interactive card reply via client.replyCard when asCard is set', async () => {
      const card = { config: { wide_screen_mode: true } };
      const result = await adapter.sendReply('oc_channel', 'om_original', JSON.stringify(card), {
        asCard: true,
      });

      expect(result).toBe('om_mock_reply_card');
      expect(mockClient.replyCard).toHaveBeenCalledWith('om_original', card);
    });

    it('should send a post reply when richText is set', async () => {
      const result = await adapter.sendReply('oc_channel', 'om_original', '{"zh_cn":{"title":"Test"}}', {
        richText: true,
      });

      expect(result).toBe('om_mock_reply');
      expect(mockClient.replyMessage).toHaveBeenCalledWith(
        'om_original',
        '{"zh_cn":{"title":"Test"}}',
        'post',
      );
    });

    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(
        adapter.sendReply('oc_channel', 'om_original', 'text'),
      ).rejects.toThrow('Feishu adapter not connected');
    });
  });

  describe('sendMessage with options', () => {
    it('should send as card when asCard is set', async () => {
      const cardStr = JSON.stringify({ config: { wide_screen_mode: true } });
      await adapter.sendMessage('oc_channel', cardStr, { asCard: true });

      expect(mockClient.sendInteractiveMessage).toHaveBeenCalledWith(
        'oc_channel',
        JSON.parse(cardStr),
        'chat_id',
      );
    });

    it('should send with custom receiveIdType', async () => {
      await adapter.sendMessage('oc_channel', 'Hello', {
        receiveIdType: 'open_id',
      });

      expect(mockClient.sendTextMessage).toHaveBeenCalledWith('oc_channel', 'Hello', 'open_id');
    });
  });

  describe('sendCard', () => {
    it('should delegate to client.sendInteractiveMessage', async () => {
      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Test' } } };
      const result = await adapter.sendCard('oc_channel', card);

      expect(result).toBe('om_mock_card');
      expect(mockClient.sendInteractiveMessage).toHaveBeenCalledWith('oc_channel', card);
    });
  });

  describe('isConnected', () => {
    it('should return connection status', () => {
      expect(adapter.isConnected()).toBe(true);

      (adapter as Record<string, unknown>)['connected'] = false;
      expect(adapter.isConnected()).toBe(false);
    });
  });
});
