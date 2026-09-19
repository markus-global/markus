import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_SEARCH_MATCHES,
  nextMatchCursor,
  searchChatHistory,
  snippetFor,
  type ChatSearchableMessage,
} from './chatSearch.ts';

const plain = (id: string, text: string): ChatSearchableMessage => ({ id, text });

const segmented = (
  id: string,
  segments: ChatSearchableMessage['segments'],
): ChatSearchableMessage => ({ id, text: '', segments });

describe('searchChatHistory', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    const out = searchChatHistory([plain('a', 'hello world')], '   ');
    expect(out.matches).toEqual([]);
  });

  it('matches case-insensitively and reports the message index', () => {
    const msgs = [plain('a', 'Alpha'), plain('b', 'nothing'), plain('c', 'an ALPHA again')];
    const out = searchChatHistory(msgs, 'alpha');
    expect(out.matches.map(m => [m.messageIndex, m.messageId])).toEqual([[0, 'a'], [2, 'c']]);
    expect(out.scanned).toBe(3);
  });

  it('orders hits down the transcript: message, then field, then occurrence', () => {
    const msgs = [
      segmented('a', [{ type: 'text', content: 'hit one and hit two' }]),
      plain('b', 'another hit'),
    ];
    const out = searchChatHistory(msgs, 'hit');
    expect(out.matches.map(m => [m.messageIndex, m.field])).toEqual([
      [0, 'text'], [0, 'text'], [1, 'text'],
    ]);
  });

  it('searches rendered segments (正文 / 思考 / 工具) and labels each hit', () => {
    const msgs = [
      segmented('a', [
        { type: 'text', content: 'needle in the reply', thinking: 'needle in the reasoning' },
        { type: 'tool', tool: 'shell_execute', result: 'needle in the output' },
      ]),
    ];
    const out = searchChatHistory(msgs, 'needle');
    expect(out.matches.map(m => m.field)).toEqual(['thinking', 'text', 'tool']);
  });

  it('does not double-count a segmented reply that also carries flattened text', () => {
    // Streamed replies keep `text` as a copy of the text segments; scanning both
    // would report every sentence twice.
    const msg: ChatSearchableMessage = {
      id: 'a',
      text: 'the same sentence',
      segments: [{ type: 'text', content: 'the same sentence' }],
    };
    expect(searchChatHistory([msg], 'same').matches).toHaveLength(1);
  });

  it('falls back to `text` when a message has no usable segments', () => {
    const msg: ChatSearchableMessage = {
      id: 'a',
      text: 'fallback needle',
      segments: [{ type: 'tool', tool: '' }],
    };
    const out = searchChatHistory([msg], 'needle');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]!.field).toBe('text');
  });

  it('finds every occurrence inside one message', () => {
    const out = searchChatHistory([plain('a', 'x x x')], 'x');
    expect(out.matches).toHaveLength(3);
    expect(nextMatchCursor(-1, 1, out.matches.length)).toBe(0);
  });

  it('caps the result set and flags the truncation', () => {
    const long = 'needle '.repeat(MAX_CHAT_SEARCH_MATCHES + 50);
    const out = searchChatHistory([plain('a', long)], 'needle');
    expect(out.matches).toHaveLength(MAX_CHAT_SEARCH_MATCHES);
    expect(out.truncated).toBe(true);
  });

  it('does not flag truncation when everything fits', () => {
    const out = searchChatHistory([plain('a', 'needle')], 'needle');
    expect(out.truncated).toBe(false);
  });

  it('carries the snippet offsets so the UI can emphasise the hit', () => {
    const out = searchChatHistory([plain('a', 'prefix text needle suffix text')], 'needle');
    const m = out.matches[0]!;
    expect(m.snippet.slice(m.snippetMatchStart, m.snippetMatchStart + m.snippetMatchLength)).toBe('needle');
  });

  it('handles CJK text without needing word boundaries', () => {
    const out = searchChatHistory([plain('a', '我们需要修复滚动抖动问题')], '滚动抖动');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]!.snippet).toContain('滚动抖动');
  });
});

describe('snippetFor', () => {
  it('collapses whitespace and keeps the hit addressable', () => {
    const value = 'line one\n\n  line two has needle here';
    const idx = value.indexOf('needle');
    const snip = snippetFor(value, idx, 6, 8);
    expect(snip.text).not.toContain('\n');
    expect(snip.text.slice(snip.matchStart, snip.matchStart + snip.matchLength)).toBe('needle');
  });

  it('marks elision on both sides of a long string', () => {
    const value = `${'a'.repeat(200)}needle${'b'.repeat(200)}`;
    const snip = snippetFor(value, 200, 6, 20);
    expect(snip.text.startsWith('…')).toBe(true);
    expect(snip.text.endsWith('…')).toBe(true);
  });

  it('does not add elision when the whole value fits', () => {
    const snip = snippetFor('short needle here', 6, 6, 100);
    expect(snip.text).toBe('short needle here');
    expect(snip.matchStart).toBe(6);
  });
});

describe('nextMatchCursor', () => {
  it('starts forward at the first hit and backward at the last', () => {
    expect(nextMatchCursor(-1, 1, 5)).toBe(0);
    expect(nextMatchCursor(-1, -1, 5)).toBe(4);
  });

  it('wraps around in both directions', () => {
    expect(nextMatchCursor(4, 1, 5)).toBe(0);
    expect(nextMatchCursor(0, -1, 5)).toBe(4);
  });

  it('reports -1 when there is nothing to select', () => {
    expect(nextMatchCursor(0, 1, 0)).toBe(-1);
  });
});
