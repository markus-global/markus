import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildEvolveSeedPrompt,
  formatEvolveTranscript,
  EVOLVE_TRANSCRIPT_MAX_MESSAGES,
  type EvolveSourceMessage,
} from '../src/evolve-from-message.js';
import {
  AGENT_A,
  AGENT_B,
  MockIncomingMessage,
  MockServerResponse,
  createTestServer,
  type TestContext,
} from './api-server-test-helpers.js';

async function waitForResponse(res: MockServerResponse, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!res.ended && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function requestAsync(
  server: TestContext['server'],
  method: string,
  path: string,
  body?: unknown,
) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const req = new MockIncomingMessage(method, path, {
    ...(bodyStr ? { 'content-type': 'application/json' } : {}),
  }, bodyStr);
  const res = new MockServerResponse();
  server.handleRequest(req as never, res as never);
  req._simulate();
  await waitForResponse(res);
  let json: Record<string, unknown> = {};
  try {
    if (res.body) json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = { _raw: res.body };
  }
  return { status: res.statusCode, json };
}

describe('evolve-from-message helpers', () => {
  it('B-evolve-seed-includes-parent-transcript and tool summaries', () => {
    const messages: EvolveSourceMessage[] = [
      {
        id: 'm2',
        role: 'assistant',
        content: 'Done',
        createdAt: '2026-07-26T12:00:02.000Z',
        metadata: {
          segments: [
            { type: 'tool', tool: 'memory_save', status: 'done', result: 'saved insight' },
          ],
        },
      },
      {
        id: 'm1',
        role: 'user',
        content: 'Please remember this',
        createdAt: '2026-07-26T12:00:01.000Z',
      },
    ];
    const { transcript, focusMarked } = formatEvolveTranscript(messages, { focusMessageId: 'm2' });
    expect(transcript).toContain('Please remember this');
    expect(transcript).toContain('[tool memory_save done]');
    expect(transcript).toContain('>>> FOCUS');
    expect(focusMarked).toBe(true);
  });

  it('B-evolve-seed-marks-focus-message by sourceText fallback', () => {
    const messages: EvolveSourceMessage[] = [
      { id: 'm1', role: 'assistant', content: 'Exact bubble text', createdAt: '2026-07-26T12:00:00.000Z' },
    ];
    const { transcript, focusMarked } = formatEvolveTranscript(messages, {
      focusText: 'Exact bubble text',
    });
    expect(focusMarked).toBe(true);
    expect(transcript).toContain('>>> FOCUS');
  });

  it('truncates when message cap is hit', () => {
    const messages: EvolveSourceMessage[] = Array.from({ length: EVOLVE_TRANSCRIPT_MAX_MESSAGES + 5 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    })).reverse();
    const { truncated, transcript } = formatEvolveTranscript(messages);
    expect(truncated).toBe(true);
    expect(transcript.split('\n\n').length).toBeLessThanOrEqual(EVOLVE_TRANSCRIPT_MAX_MESSAGES);
  });

  it('B-evolve-seed-includes-parent-session-id and habits instructions', () => {
    const seed = buildEvolveSeedPrompt({
      parentSessionId: 'cs_parent',
      evolutionSessionId: 'cs_child',
      sourceMessageId: 'm_focus',
      userNote: 'Encode the retry pattern',
      transcript: 'user: hi',
      truncated: true,
    });
    expect(seed).toContain('parentSessionId: cs_parent');
    expect(seed).toContain('evolutionSessionId: cs_child');
    expect(seed).toContain('sourceMessageId (focus): m_focus');
    expect(seed).toContain('Encode the retry pattern');
    expect(seed).toContain('scope: "chat_session"');
    expect(seed).toContain('Learning Habits');
    expect(seed).toContain('package_install');
    expect(seed).toContain('truncated');
  });
});

describe('POST /api/agents/:id/evolve-from-message', () => {
  let ctx: TestContext;

  beforeEach(() => {
    process.env['AUTH_ENABLED'] = 'false';
    ctx = createTestServer();
    vi.mocked(ctx.storage.chatSessionRepo.getMessages).mockResolvedValue({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Fix the deploy script',
          createdAt: new Date('2026-07-26T10:00:00.000Z'),
          metadata: null,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Updated deploy.yml',
          createdAt: new Date('2026-07-26T10:00:05.000Z'),
          metadata: {
            segments: [{ type: 'tool', tool: 'file_edit', status: 'done', result: 'ok' }],
          },
        },
      ],
      hasMore: false,
    } as never);
    vi.mocked(ctx.storage.chatSessionRepo.getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'cs_parent') {
        return { id: 'cs_parent', agentId: AGENT_A, userId: 'anonymous', title: 'Main', isMain: true };
      }
      if (sessionId === 'cs_other_agent') {
        return { id: 'cs_other_agent', agentId: AGENT_B, userId: 'anonymous', title: 'Other', isMain: false };
      }
      if (sessionId === 'cs_foreign_user') {
        return { id: 'cs_foreign_user', agentId: AGENT_A, userId: 'user-other', title: 'Foreign', isMain: false };
      }
      return null;
    });
    vi.mocked(ctx.storage.chatSessionRepo.createSession).mockImplementation((agentId: string, userId?: string) => ({
      id: 'cs_evo_1',
      agentId,
      userId: userId ?? null,
      title: null,
      isMain: false,
      createdAt: new Date(),
      lastMessageAt: new Date(),
    }));
  });

  it('B-evolve-api-creates-child-session / metadata / seed / only child', async () => {
    const res = await requestAsync(ctx.server, 'POST', `/api/agents/${AGENT_A}/evolve-from-message`, {
      parentSessionId: 'cs_parent',
      sourceMessageId: 'm2',
      sourceText: 'Updated deploy.yml',
      userNote: 'Keep deploy steps',
    });
    expect(res.status).toBe(200);
    expect(res.json.sessionId).toBe('cs_evo_1');
    expect(res.json.agentId).toBe(AGENT_A);
    expect(res.json.parentSessionId).toBe('cs_parent');
    expect(res.json.focusMarked).toBe(true);

    const seed = String(res.json.seedPrompt ?? '');
    expect(seed).toContain('parentSessionId: cs_parent');
    expect(seed).toContain('evolutionSessionId: cs_evo_1');
    expect(seed).toContain('Fix the deploy script');
    expect(seed).toContain('[tool file_edit done]');
    expect(seed).toContain('>>> FOCUS');
    expect(seed).toContain('Learning Habits');
    expect(seed).toContain('Keep deploy steps');

    expect(ctx.storage.chatSessionRepo.createSession).toHaveBeenCalledWith(AGENT_A, 'anonymous');
    expect(ctx.storage.chatSessionRepo.updateSessionMetadata).toHaveBeenCalledWith('cs_evo_1', expect.objectContaining({
      kind: 'evolution',
      parentSessionId: 'cs_parent',
      sourceMessageId: 'm2',
      sourceAgentId: AGENT_A,
      createdFrom: 'remember_button',
    }));
    expect(ctx.storage.chatSessionRepo.appendMessage).not.toHaveBeenCalled();
    expect(ctx.storage.chatSessionRepo.updateLastMessage).toHaveBeenCalledWith('cs_evo_1', 'Remember / Evolution');
  });

  it('B-evolve-api-rejects-non-dm-parent (wrong agent)', async () => {
    const res = await requestAsync(ctx.server, 'POST', `/api/agents/${AGENT_A}/evolve-from-message`, {
      parentSessionId: 'cs_other_agent',
    });
    expect(res.status).toBe(400);
    expect(ctx.storage.chatSessionRepo.createSession).not.toHaveBeenCalled();
  });

  it('B-evolve-api-rejects-non-dm-parent (foreign user)', async () => {
    const res = await requestAsync(ctx.server, 'POST', `/api/agents/${AGENT_A}/evolve-from-message`, {
      parentSessionId: 'cs_foreign_user',
    });
    expect(res.status).toBe(403);
    expect(ctx.storage.chatSessionRepo.createSession).not.toHaveBeenCalled();
  });

  it('rejects missing parentSessionId', async () => {
    const res = await requestAsync(ctx.server, 'POST', `/api/agents/${AGENT_A}/evolve-from-message`, {});
    expect(res.status).toBe(400);
  });
});
