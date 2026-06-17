import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../src/feishu/client.js';

describe('FeishuClient', () => {
  let client: FeishuClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset token state by creating a fresh client each time
    client = new FeishuClient({
      appId: 'test-app-id',
      appSecret: 'test-secret',
      domain: 'https://open.feishu.cn',
    });

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // Mock successful token fetch (called on first API call)
    mockFetch.mockResolvedValue({
      json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
    });
  });

  describe('sendInteractiveMessage', () => {
    it('should send an interactive card message and return message_id', async () => {
      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Hello' } } };

      // First call: token fetch, second call: send message
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_mock123' } }),
        });

      const result = await client.sendInteractiveMessage('oc_test_chat', card);

      expect(result).toBe('om_mock123');

      // Verify the send message request
      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
      expect(sendCall[1].method).toBe('POST');
      const body = JSON.parse(sendCall[1].body);
      expect(body.msg_type).toBe('interactive');
      expect(body.receive_id).toBe('oc_test_chat');
    });
  });

  describe('replyMessage', () => {
    it('should reply to a message and return the new message_id', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_reply_123' } }),
        });

      const result = await client.replyMessage('om_original', JSON.stringify({ text: 'reply text' }));

      expect(result).toBe('om_reply_123');

      const replyCall = mockFetch.mock.calls[1];
      expect(replyCall[0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_original/reply');
      expect(replyCall[1].method).toBe('POST');
      const body = JSON.parse(replyCall[1].body);
      expect(body.msg_type).toBe('text');
    });

    it('should reply with interactive card type when specified', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_card_reply' } }),
        });

      const card = { config: { wide_screen_mode: true } };
      const result = await client.replyMessage('om_original', JSON.stringify(card), 'interactive');

      expect(result).toBe('om_card_reply');
      const replyCall = mockFetch.mock.calls[1];
      const body = JSON.parse(replyCall[1].body);
      expect(body.msg_type).toBe('interactive');
    });
  });

  describe('replyCard', () => {
    it('should reply with a card and return the new message_id', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_card_reply' } }),
        });

      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Card Reply' } } };
      const result = await client.replyCard('om_original', card);

      expect(result).toBe('om_card_reply');

      const replyCall = mockFetch.mock.calls[1];
      expect(replyCall[0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_original/reply');
      expect(replyCall[1].method).toBe('POST');
      const body = JSON.parse(replyCall[1].body);
      expect(body.msg_type).toBe('interactive');
    });
  });

  describe('updateMessage', () => {
    it('should update a message with PATCH request', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok' }),
        });

      await client.updateMessage('om_test_msg', JSON.stringify({ text: 'Updated content' }));

      const updateCall = mockFetch.mock.calls[1];
      expect(updateCall[0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_test_msg');
      expect(updateCall[1].method).toBe('PATCH');
      const body = JSON.parse(updateCall[1].body);
      expect(body.msg_type).toBe('text');
      expect(body.content).toBe(JSON.stringify({ text: 'Updated content' }));
    });

    it('should throw error when update fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 10003, msg: 'message not found' }),
        });

      await expect(client.updateMessage('om_nonexistent', 'new content')).rejects.toThrow('Feishu updateMessage failed: message not found');
    });

    it('should use specified msgType for update', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok' }),
        });

      await client.updateMessage('om_test', JSON.stringify({}), 'interactive');

      const updateCall = mockFetch.mock.calls[1];
      const body = JSON.parse(updateCall[1].body);
      expect(body.msg_type).toBe('interactive');
    });
  });

  describe('updateInteractiveMessage', () => {
    it('should update with interactive card content', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok' }),
        });

      const card = { config: { wide_screen_mode: true } };
      await client.updateInteractiveMessage('om_test', card);

      const updateCall = mockFetch.mock.calls[1];
      const body = JSON.parse(updateCall[1].body);
      expect(body.msg_type).toBe('interactive');
      expect(body.content).toBe(JSON.stringify(card));
    });
  });

  describe('sendTextMessage', () => {
    it('should send a text message and return message_id', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_text_123' } }),
        });

      const result = await client.sendTextMessage('oc_test_chat', 'Hello world');

      expect(result).toBe('om_text_123');
      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toContain('/im/v1/messages');
      const body = JSON.parse(sendCall[1].body);
      expect(body.msg_type).toBe('text');
      expect(JSON.parse(body.content).text).toBe('Hello world');
    });

    it('should use custom receive id type', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_open_123' } }),
        });

      await client.sendTextMessage('ou_user', 'Hi', 'open_id');

      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toContain('receive_id_type=open_id');
    });
  });

  describe('getTenantToken', () => {
    it('should throw when auth fails', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ code: 99991663, msg: 'invalid app' }),
      });

      await expect(client.getTenantToken()).rejects.toThrow('Feishu auth failed: invalid app');
    });

    it('should reuse cached token without refetching', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ code: 0, tenant_access_token: 'cached-token', expire: 7200 }),
      });

      const first = await client.getTenantToken();
      const second = await client.getTenantToken();
      expect(first).toBe('cached-token');
      expect(second).toBe('cached-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendRichTextMessage', () => {
    it('should send rich text post message', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_post_123' } }),
        });

      const content = [[{ tag: 'text', text: 'Hello' }]];
      const result = await client.sendRichTextMessage('oc_chat', 'Title', content);

      expect(result).toBe('om_post_123');
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.msg_type).toBe('post');
    });
  });

  describe('getMessageList', () => {
    it('should fetch messages for a chat', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, data: { items: [{ message_id: 'om_1' }] } }),
        });

      const items = await client.getMessageList('oc_chat');
      expect(items).toHaveLength(1);
    });
  });

  describe('getChatList', () => {
    it('should fetch chat list', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, data: { items: [{ chat_id: 'oc_1' }] } }),
        });

      const items = await client.getChatList();
      expect(items).toHaveLength(1);
    });
  });

  describe('getDocContent', () => {
    it('should fetch docx content', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, data: { content: 'doc body' } }),
        });

      const content = await client.getDocContent('doc_token_1', 'docx');
      expect(content).toBe('doc body');
      expect(mockFetch.mock.calls[1][0]).toContain('/docx/v1/documents/');
    });

    it('should fetch sheet metadata', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, data: { content: '' } }),
        });

      await client.getDocContent('sheet_token', 'sheet');
      expect(mockFetch.mock.calls[1][0]).toContain('/sheets/v3/spreadsheets/');
    });

    it('should throw when doc fetch fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 10003, msg: 'doc not found' }),
        });

      await expect(client.getDocContent('bad_doc')).rejects.toThrow('Feishu doc fetch failed');
    });
  });

  describe('deleteMessage', () => {
    it('should delete a message with DELETE request', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, msg: 'ok' }),
        });

      await client.deleteMessage('om_test_msg');

      const deleteCall = mockFetch.mock.calls[1];
      expect(deleteCall[0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_test_msg');
      expect(deleteCall[1].method).toBe('DELETE');
    });

    it('should throw error when delete fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 10003, msg: 'message not found' }),
        });

      await expect(client.deleteMessage('om_nonexistent')).rejects.toThrow('Feishu deleteMessage failed: message not found');
    });
  });
});
