import { describe, it, expect } from 'vitest';
import { sanitizeForLLM, sanitizeLLMMessages, safeSlice } from '../src/sanitize.js';

describe('sanitizeForLLM', () => {
  it('strips ANSI CSI escape sequences', () => {
    expect(sanitizeForLLM('\x1b[31mRed\x1b[0m')).toBe('Red');
  });

  it('strips ANSI OSC sequences', () => {
    expect(sanitizeForLLM('\x1b]0;Title\x07body')).toBe('body');
    expect(sanitizeForLLM('\x1b]0;Title\x1b\\body')).toBe('body');
  });

  it('strips other ANSI escapes', () => {
    // ANSI_OTHER regex matches \x1b + one non-[/] char + one more char
    expect(sanitizeForLLM('\x1bMxhello')).toBe('hello');
  });

  it('strips C0 control chars but keeps tab/newline/cr', () => {
    expect(sanitizeForLLM('a\x00b\x01c\td\ne\rf')).toBe('abc\td\ne\rf');
  });

  it('strips C1 control chars', () => {
    expect(sanitizeForLLM('a\x80b\x9fc')).toBe('abc');
  });

  it('replaces lone surrogates with U+FFFD', () => {
    const highSurrogate = '\uD800';
    const lowSurrogate = '\uDC00';
    expect(sanitizeForLLM(`a${highSurrogate}b`)).toBe('a\uFFFDb');
    expect(sanitizeForLLM(`a${lowSurrogate}b`)).toBe('a\uFFFDb');
  });

  it('preserves valid surrogate pairs', () => {
    const emoji = '😀';
    expect(sanitizeForLLM(emoji)).toBe(emoji);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeForLLM('')).toBe('');
  });

  it('passes through clean text unchanged', () => {
    const text = 'Hello, world! 你好世界';
    expect(sanitizeForLLM(text)).toBe(text);
  });
});

describe('sanitizeLLMMessages', () => {
  it('sanitizes string content in messages', () => {
    const messages = [
      { role: 'user' as const, content: '\x1b[31mHello\x1b[0m' },
    ];
    const result = sanitizeLLMMessages(messages);
    expect(result[0].content).toBe('Hello');
  });

  it('sanitizes text parts in array content', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '\x1b[32mGreen\x1b[0m' },
          { type: 'image_url' as const, image_url: { url: 'http://example.com/img.png' } },
        ],
      },
    ];
    const result = sanitizeLLMMessages(messages);
    expect((result[0].content as any[])[0].text).toBe('Green');
    expect((result[0].content as any[])[1].type).toBe('image_url');
  });

  it('sanitizes reasoningContent if present', () => {
    const messages = [
      { role: 'assistant' as const, content: 'ok', reasoningContent: '\x00thinking\x01' },
    ];
    const result = sanitizeLLMMessages(messages);
    expect(result[0].reasoningContent).toBe('thinking');
  });

  it('does not mutate the original array', () => {
    const original = [{ role: 'user' as const, content: '\x1b[31mRed\x1b[0m' }];
    sanitizeLLMMessages(original);
    expect(original[0].content).toBe('\x1b[31mRed\x1b[0m');
  });
});

describe('safeSlice', () => {
  it('works like regular slice for ASCII', () => {
    expect(safeSlice('hello', 0, 3)).toBe('hel');
    expect(safeSlice('hello', 2)).toBe('llo');
  });

  it('returns empty string for empty slice', () => {
    expect(safeSlice('hello', 5, 5)).toBe('');
  });

  it('drops lone leading low surrogate', () => {
    const str = '\uD83D\uDE00abc';
    const sliced = safeSlice(str, 1, 5);
    expect(sliced.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xDC00);
  });

  it('drops lone trailing high surrogate', () => {
    const str = 'abc\uD83D\uDE00';
    const sliced = safeSlice(str, 0, 4);
    const last = sliced.charCodeAt(sliced.length - 1);
    expect(last).not.toBeGreaterThanOrEqual(0xD800);
  });

  it('preserves valid emoji when not split', () => {
    const str = 'a😀b';
    expect(safeSlice(str, 0)).toBe('a😀b');
  });
});
