import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ActiveStreamRegistry } from '../src/active-stream-registry.js';

class MockResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  body = '';
  writeHead() { this.headersSent = true; }
  write(chunk: string) { this.body += chunk; return true; }
  end() { this.writableEnded = true; }
}

describe('ActiveStreamRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('replays buffered events on attach then live-tails', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    session.push({ type: 'text_delta', text: 'Hello' });
    session.push({ type: 'text_delta', text: ' world' });

    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    expect(res.body).toContain('reattach');
    expect(res.body).toContain('Hello');
    expect(res.body).toContain(' world');

    session.push({ type: 'text_delta', text: '!' });
    expect(res.body).toContain('!');

    session.complete({ type: 'done', content: 'Hello world!' });
    expect(res.body).toContain('"type":"done"');
    expect((res as unknown as MockResponse).writableEnded).toBe(true);
  });

  it('status reports active while streaming and briefly after done (TTL reattach)', () => {
    const reg = new ActiveStreamRegistry();
    reg.register({ streamId: 's1', agentId: 'a1', sessionId: 'sess1', messageId: 'm1' });
    expect(reg.status('a1', 'sess1').active).toBe(true);
    expect(reg.status('a1', 'sess1').status).toBe('streaming');
    reg.getByAgentSession('a1', 'sess1')!.complete({ type: 'done', content: 'x' });
    // Still attachable within DONE_TTL so a late refresh can drain terminal done.
    expect(reg.status('a1', 'sess1').active).toBe(true);
    expect(reg.status('a1', 'sess1').status).toBe('done');
  });

  it('allows attach after done to replay terminal event', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    session.push({ type: 'text_delta', text: 'Hi' });
    session.complete({ type: 'done', content: 'Hi' });

    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    expect(res.body).toContain('"type":"done"');
    expect((res as unknown as MockResponse).writableEnded).toBe(true);
  });

  it('emits UI snapshot on attach and skips historical ring text when snapshot exists', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    session.push({ type: 'text_delta', text: 'old-' });
    session.push({ type: 'agent_tool', tool: 'generate_image', phase: 'start' });
    session.setUiSnapshot({
      content: 'Hello from tools',
      segments: [
        { type: 'tool', tool: 'generate_image', status: 'done' },
        { type: 'text', content: 'Hello from tools' },
      ],
    });

    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    expect(res.body).toContain('"type":"snapshot"');
    expect(res.body).toContain('generate_image');
    expect(res.body).toContain('Hello from tools');
    // Historical text_delta must not be replayed (would duplicate snapshot text).
    expect(res.body).not.toContain('"text":"old-"');

    session.push({ type: 'text_delta', text: '!' });
    expect(res.body).toContain('"text":"!"');
  });
});
