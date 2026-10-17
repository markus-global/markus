import { describe, it, expect } from 'vitest';
import { dbMsgToChat } from '../src/pages/ChatHelpers.ts';

/**
 * "No output" is a VERDICT, not an observation.
 *
 * Bug this pins: the newest agent bubble announced "this agent produced no
 * output" and then flipped to the real answer — because the client derived the
 * verdict from *absence of content*, which is the normal state before history
 * arrives / before the first delta lands. Only the server may stamp
 * `metadata.emptyReply`, and the client must not re-derive it.
 */

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    content: '',
    createdAt: new Date(2026, 0, 1).toISOString(),
    metadata: {},
    ...overrides,
  } as never;
}

describe('emptyReply authority', () => {
  it('does NOT mark a content-less assistant row as empty (loading / in-flight)', () => {
    const msg = dbMsgToChat(row());
    expect(msg.emptyReply).toBeFalsy();
  });

  it('does NOT invent an empty verdict for a stopped row', () => {
    const msg = dbMsgToChat(row({ metadata: { isStopped: true } }));
    expect(msg.emptyReply).toBeFalsy();
  });

  it('trusts the server flag', () => {
    const msg = dbMsgToChat(row({ metadata: { emptyReply: true } }));
    expect(msg.emptyReply).toBe(true);
  });
});
