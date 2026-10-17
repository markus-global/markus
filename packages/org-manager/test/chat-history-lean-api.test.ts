import { describe, it, expect, vi } from 'vitest';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

/**
 * Real request/response coverage for the chat history payload shape.
 *
 * The list endpoint must ship the LEAN trace (tool results/args/intermediate
 * text stripped, markers set) and the detail endpoint must return the untouched
 * original — that pair is what makes "expand to load detail" honest.
 */

process.env['AUTH_ENABLED'] = 'false';

const BIG_RESULT = 'R'.repeat(40000);
const APPROVAL_RESULT = JSON.stringify({
  status: 'success',
  requirement: { id: 'req_1', status: 'pending', title: 'Ship it', description: 'd', priority: 'high' },
});

function heavyMessage() {
  return {
    id: 'cm_heavy',
    sessionId: 'sess-1',
    agentId: 'agt_a',
    role: 'assistant',
    content: 'FINAL ANSWER',
    tokensUsed: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: {
      segments: [
        { type: 'text', content: 'intermediate narration '.repeat(200) },
        { type: 'tool', tool: 'file_read', status: 'done', result: BIG_RESULT, arguments: { file_path: '/big.txt' } },
        { type: 'tool', tool: 'requirement_propose', status: 'done', result: APPROVAL_RESULT, arguments: { title: 'x' } },
        { type: 'text', content: 'FINAL ANSWER' },
      ],
      isError: false,
      taskId: 'tsk_1',
    },
  };
}

function seed(ctx: TestContext, message: Record<string, unknown>) {
  const repo = ctx.storage.chatSessionRepo as unknown as {
    getMessages: ReturnType<typeof vi.fn>;
    getMessage: ReturnType<typeof vi.fn>;
  };
  repo.getMessages.mockResolvedValue({ messages: [message], hasMore: false });
  repo.getMessage.mockReturnValue(message);
}

describe('GET /api/sessions/:id/messages — lean payload', () => {
  it('strips heavy trace fields and marks them', async () => {
    const ctx = createTestServer();
    seed(ctx, heavyMessage());

    const res = await request(ctx.server, 'GET', '/api/sessions/sess-1/messages?limit=50');
    expect(res.status).toBe(200);

    const messages = res.json['messages'] as Array<Record<string, unknown>>;
    const meta = messages[0]!['metadata'] as Record<string, unknown>;
    const segs = meta['segments'] as Array<Record<string, unknown>>;

    // the visible answer survives
    expect(messages[0]!['content']).toBe('FINAL ANSWER');
    expect(segs[segs.length - 1]!['content']).toBe('FINAL ANSWER');

    // intermediate narration body dropped, size recorded
    expect(segs[0]!['content']).toBe('');
    expect(segs[0]!['contentTruncated']).toBe(true);

    // big tool result dropped, arguments dropped
    expect(segs[1]!['result']).toBe('');
    expect(segs[1]!['resultTruncated']).toBe(true);
    expect(segs[1]!['resultSize']).toBe(BIG_RESULT.length);
    expect(segs[1]!['arguments']).toBeUndefined();
    expect(segs[1]!['argumentsDropped']).toBe(true);

    // approval result kept whole — the inline card parses it eagerly
    expect(segs[2]!['result']).toBe(APPROVAL_RESULT);

    // client is told to fetch detail
    expect(meta['segmentsTruncated']).toBe(true);
    // non-segment flags survive
    expect(meta['taskId']).toBe('tsk_1');

    // and the wire is dramatically smaller than the stored row
    const stored = JSON.stringify(heavyMessage().metadata);
    expect(res.raw.length * 5).toBeLessThan(stored.length);
  });

  it('?lean=0 still returns the full trace (diagnostics escape hatch)', async () => {
    const ctx = createTestServer();
    seed(ctx, heavyMessage());

    const res = await request(ctx.server, 'GET', '/api/sessions/sess-1/messages?limit=50&lean=0');
    const meta = (res.json['messages'] as Array<Record<string, unknown>>)[0]!['metadata'] as Record<string, unknown>;
    const segs = meta['segments'] as Array<Record<string, unknown>>;

    expect(segs[1]!['result']).toBe(BIG_RESULT);
    expect(segs[1]!['arguments']).toEqual({ file_path: '/big.txt' });
    expect(meta['segmentsTruncated']).toBeUndefined();
  });
});

describe('GET /api/sessions/:id/messages/:messageId — detail', () => {
  it('returns the untouched original for expansion', async () => {
    const ctx = createTestServer();
    const original = heavyMessage();
    seed(ctx, original);

    const res = await request(ctx.server, 'GET', '/api/sessions/sess-1/messages/cm_heavy');
    expect(res.status).toBe(200);

    const message = res.json['message'] as Record<string, unknown>;
    const meta = message['metadata'] as Record<string, unknown>;
    const segs = meta['segments'] as Array<Record<string, unknown>>;

    expect(segs[1]!['result']).toBe(BIG_RESULT);
    expect(segs[1]!['arguments']).toEqual({ file_path: '/big.txt' });
    expect(meta['segmentsTruncated']).toBeUndefined();
  });

  it('404s when the message does not belong to the session', async () => {
    const ctx = createTestServer();
    seed(ctx, heavyMessage());
    (ctx.storage.chatSessionRepo as unknown as { getMessage: ReturnType<typeof vi.fn> })
      .getMessage.mockReturnValue(null);

    const res = await request(ctx.server, 'GET', '/api/sessions/sess-1/messages/unknown');
    expect(res.status).toBe(404);
  });
});
