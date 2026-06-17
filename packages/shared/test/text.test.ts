import { describe, it, expect } from 'vitest';
import { extractThinkBlocks, stripInternalBlocks } from '../src/utils/text.js';

describe('extractThinkBlocks', () => {
  it('extracts single think block', () => {
    const { thinking, clean } = extractThinkBlocks('before <think>reasoning here</think> after');
    expect(thinking).toEqual(['reasoning here']);
    expect(clean).toBe('before  after');
  });

  it('extracts multiple think blocks', () => {
    const { thinking, clean } = extractThinkBlocks('<think>first</think> mid <think>second</think> end');
    expect(thinking).toEqual(['first', 'second']);
    expect(clean).toBe('mid  end');
  });

  it('returns empty array when no think blocks', () => {
    const { thinking, clean } = extractThinkBlocks('no thinking here');
    expect(thinking).toEqual([]);
    expect(clean).toBe('no thinking here');
  });

  it('skips empty think blocks', () => {
    const { thinking } = extractThinkBlocks('a <think>  </think> b');
    expect(thinking).toEqual([]);
  });

  it('handles multiline think content', () => {
    const { thinking } = extractThinkBlocks('<think>\nline 1\nline 2\n</think>');
    expect(thinking[0]).toBe('line 1\nline 2');
  });

  it('trims the clean output', () => {
    const { clean } = extractThinkBlocks('  <think>x</think>  hello  ');
    expect(clean).toBe('hello');
  });
});

describe('stripInternalBlocks', () => {
  it('removes think blocks from text', () => {
    expect(stripInternalBlocks('Hello <think>internal</think> World')).toBe('Hello  World');
  });

  it('returns trimmed text when no blocks', () => {
    expect(stripInternalBlocks('  hello  ')).toBe('hello');
  });

  it('handles multiple blocks', () => {
    expect(stripInternalBlocks('<think>a</think>X<think>b</think>Y')).toBe('XY');
  });
});
