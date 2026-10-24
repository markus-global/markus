/**
 * The request must replay the WHOLE session when there is room for it.
 *
 * `Agent.requestHistory` used to apply `requestHistoryWindow(all, 400, 100)`: a
 * COUNT-based cut that withheld everything before the last ~400 messages whether
 * or not the request needed it. Measured on a 713-message session sitting at 53%
 * of a 1000k window, ~300 messages (~116k tokens) were dropped from every call —
 * the exact "trim to save tokens" behaviour that was banned, and the reason the
 * banner's `variable` never matched the session's real size.
 *
 * The engine never capped by count; these tests pin that contract, since the
 * agent now relies on it. Cutting remains possible, but only when the request
 * physically exceeds the window.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';

let dir: string;
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-fullhist-'));
  memory = new MemoryStore(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a session of `n` short turns and return the prepared request. */
async function packSession(n: number, windowTokens: number, padChars = 0) {
  const session = memory.createSession('agt_full');
  const pad = padChars > 0 ? ' ' + 'x'.repeat(padChars) : '';
  for (let i = 0; i < n; i++) {
    memory.appendMessage(session.id, { role: 'user', content: `question ${i}${pad}` });
    memory.appendMessage(session.id, { role: 'assistant', content: `answer ${i}${pad}` });
  }
  const all = memory.getRecentMessages(session.id, Number.MAX_SAFE_INTEGER);
  const prepared = await new ContextEngine().prepareMessages({
    systemPrompt: 'sys',
    sessionMessages: all,
    memory,
    sessionId: session.id,
    modelContextWindow: windowTokens,
    modelMaxOutput: 8_000,
  });
  return { all, prepared };
}

describe('full history replay', () => {
  it('replays a 450-message session in full when the window has room', async () => {
    const { all, prepared } = await packSession(225, 1_000_000); // 450 messages

    expect(all.length).toBe(450);
    // Only the system message and the volatile tail are extra: nothing withheld.
    const body = prepared.messages
      .slice(1)
      .filter((m) => !String(m.content).startsWith('[SYSTEM] [Live context]'));
    expect(body.length).toBe(450);
    expect(String(body[0]!.content)).toBe('question 0'); // the head is NOT slid
  });

});
