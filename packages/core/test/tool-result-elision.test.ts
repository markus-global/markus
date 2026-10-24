/**
 * Elision must be surgical: it may drop the BULK of a stale tool result, but it
 * must never break the message sequence (that is a 400, far worse than a cache
 * miss) and never touch what the agent is currently working on.
 */

import { describe, it, expect } from 'vitest';
import { elideStaleToolResults, ELIDED_MARKER } from '../src/tool-result-elision.js';
import type { LLMMessage } from '@markus/shared';

const msg = (m: Record<string, unknown>) => m as unknown as LLMMessage;

const tool = (id: string, chars: number) => msg({ role: 'tool', content: 'x'.repeat(chars), toolCallId: id });
const call = (id: string) => msg({ role: 'assistant', content: '', toolCalls: [{ id, name: 'shell_execute', arguments: {} }] });

/** Three completed rounds, then the current turn starts at index 6. */
function history(): LLMMessage[] {
  return [
    msg({ role: 'user', content: 'TASK EXECUTION: do the thing' }),  // 0
    call('c1'),                                                      // 1
    tool('c1', 5000),                                                // 2
    call('c2'),                                                      // 3
    tool('c2', 5000),                                                // 4
    call('c3'),                                                      // 5
    msg({ role: 'user', content: 'continue' }),                      // 6 ← current turn
    tool('c3', 5000),                                                // 7
  ];
}

describe('elideStaleToolResults', () => {
  it('elides old results and keeps the most recent ones verbatim', () => {
    const { messages, elided, freedChars } = elideStaleToolResults(history(), {
      keepRecent: 1,
      minChars: 1000,
      currentTurnStart: 6,
    });

    expect(elided).toBe(1);                 // c1 and c2 are eligible; c3 is in the current turn
    expect(freedChars).toBe(5000);
    expect(String(messages[2]!.content)).toContain(ELIDED_MARKER);
    expect(String(messages[4]!.content)).toBe('x'.repeat(5000)); // kept (most recent)
  });

  it('never touches the current turn', () => {
    const { messages } = elideStaleToolResults(history(), {
      keepRecent: 0,
      minChars: 10,
      currentTurnStart: 6,
    });
    expect(String(messages[7]!.content)).toBe('x'.repeat(5000));
  });

  it('preserves toolCallId — dropping it would 400 the whole sequence', () => {
    const { messages } = elideStaleToolResults(history(), { keepRecent: 0, minChars: 10, currentTurnStart: 6 });
    expect((messages[2] as { toolCallId?: string }).toolCallId).toBe('c1');
    expect((messages[4] as { toolCallId?: string }).toolCallId).toBe('c2');
  });

  it('leaves small results alone — a stub would cost more than it saves', () => {
    const small = [msg({ role: 'user', content: 'go' }), tool('c1', 50), msg({ role: 'user', content: 'next' })];
    const { elided } = elideStaleToolResults(small, { keepRecent: 0, minChars: 1000, currentTurnStart: 2 });
    expect(elided).toBe(0);
  });

  it('is idempotent — an already-elided result is not wrapped again', () => {
    const opts = { keepRecent: 0, minChars: 10, currentTurnStart: 6 };
    const once = elideStaleToolResults(history(), opts);
    const twice = elideStaleToolResults(once.messages, opts);
    expect(twice.elided).toBe(0);
    expect(String(twice.messages[2]!.content).match(/tool result elided/g)).toHaveLength(1);
  });

  it('tells the agent how to get the data back', () => {
    const { messages } = elideStaleToolResults(history(), { keepRecent: 0, minChars: 10, currentTurnStart: 6 });
    const stub = String(messages[2]!.content);
    expect(stub).toMatch(/Re-run the tool/);
    expect(stub).toMatch(/5,000 chars/);   // size is stated, not hidden
  });

  it('returns the input untouched when nothing is eligible', () => {
    const onlyCurrent = [msg({ role: 'user', content: 'go' }), tool('c1', 5000)];
    const r = elideStaleToolResults(onlyCurrent, { keepRecent: 0, minChars: 10, currentTurnStart: 1 });
    expect(r.elided).toBe(0);
    expect(r.messages).toBe(onlyCurrent); // identity, not a copy
  });
});
