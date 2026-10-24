/**
 * The composition breakdown exists to answer one question: in a long loop, what is
 * my history actually made of? Everything cheap to fix lives in `toolResults`.
 */

import { describe, it, expect } from 'vitest';
import { summarizeComposition, formatComposition, toolResultShare } from '../src/context-composition.js';
import type { LLMMessage } from '@markus/shared';

/** One token per character — keeps the arithmetic obvious. */
const countText = (t: string) => t.length;

const msg = (m: Record<string, unknown>) => m as unknown as LLMMessage;

describe('summarizeComposition', () => {
  it('separates tool results from reasoning', () => {
    const messages: LLMMessage[] = [
      msg({ role: 'user', content: '12345' }),                                        // 5
      msg({ role: 'assistant', content: '1234567890' }),                              // 10
      msg({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] }),
      msg({ role: 'tool', content: 'x'.repeat(100), toolCallId: 'c1' }),              // 100
    ];

    const c = summarizeComposition(messages, countText);

    expect(c.user).toBe(5);
    expect(c.assistant).toBe(10);
    expect(c.toolResults).toBe(100);
    expect(c.toolCalls).toBeGreaterThan(0);
    expect(c.total).toBe(c.user + c.assistant + c.toolCalls + c.toolResults);
  });

  it('counts tool-call arguments, not just prose', () => {
    const messages: LLMMessage[] = [
      msg({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'shell_execute', arguments: { command: 'x'.repeat(50) } }] }),
    ];
    const c = summarizeComposition(messages, countText);
    expect(c.toolCalls).toBeGreaterThan(50);
    expect(c.assistant).toBe(0);
  });

  it('ignores system messages — they belong to the fixed segment', () => {
    const c = summarizeComposition([msg({ role: 'system', content: 'x'.repeat(999) })], countText);
    expect(c.total).toBe(0);
  });

  it('reports a zero total for an empty history', () => {
    expect(summarizeComposition([], countText).total).toBe(0);
  });
});

describe('formatComposition', () => {
  it('reports tool results as the dominant share', () => {
    const out = formatComposition({ user: 10, assistant: 20, toolCalls: 10, toolResults: 160, total: 200 });
    expect(out).toContain('tool-results 80%');
    expect(out).toContain('assistant 10%');
  });

  it('degrades gracefully on empty input', () => {
    expect(formatComposition({ user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 })).toBe('empty');
  });
});

describe('toolResultShare', () => {
  it('is the number that decides whether dedupe/spool/elision is worth doing', () => {
    expect(toolResultShare({ user: 10, assistant: 10, toolCalls: 0, toolResults: 80, total: 100 })).toBeCloseTo(0.8);
  });

  it('is 0 — not NaN — when there is no history', () => {
    expect(toolResultShare({ user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 })).toBe(0);
  });
});
