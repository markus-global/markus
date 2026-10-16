import { describe, expect, it } from 'vitest';
import { ChatDraftMemory } from './chatDraftMemory.ts';

describe('ChatDraftMemory', () => {
  it('keeps a separate draft per view key', () => {
    const m = new ChatDraftMemory();
    m.save('agentA::s1', '写给 A 的草稿');
    m.save('agentB::s2', '写给 B 的草稿');
    expect(m.get('agentA::s1')).toBe('写给 A 的草稿');
    expect(m.get('agentB::s2')).toBe('写给 B 的草稿');
  });

  it('returns empty string for a view with no draft (never undefined)', () => {
    const m = new ChatDraftMemory();
    expect(m.get('never-seen')).toBe('');
    expect(m.get('')).toBe('');
  });

  it('treats an empty draft as "no draft" — sending clears the slot', () => {
    const m = new ChatDraftMemory();
    m.save('k', 'hello');
    m.save('k', '');
    expect(m.get('k')).toBe('');
    expect(m.size()).toBe(0);
  });

  it('ignores an empty key so a view-less write cannot pollute the store', () => {
    const m = new ChatDraftMemory();
    m.save('', 'stray');
    expect(m.size()).toBe(0);
    expect(m.get('')).toBe('');
  });

  it('peek() reads without touching LRU order (get() does promote)', () => {
    // 判据必须能区分两种实现：cap=3 存 a,b,c 后再存 d，淘汰的是 LRU。
    //   若 peek 提升 LRU：顺序变 b,c,a → 淘汰 b → peek('a')='A'、peek('b')=''
    //   若 peek 不提升  ：顺序仍 a,b,c → 淘汰 a → peek('a')=''、peek('b')='B'
    const peeked = new ChatDraftMemory(3);
    peeked.save('a', 'A');
    peeked.save('b', 'B');
    peeked.save('c', 'C');
    expect(peeked.peek('a')).toBe('A');
    peeked.save('d', 'D');
    expect(peeked.peek('a')).toBe('');
    expect(peeked.peek('b')).toBe('B');

    // 对照：get() 会提升，所以被提升的那个能活下来。
    const got = new ChatDraftMemory(3);
    got.save('a', 'A');
    got.save('b', 'B');
    got.save('c', 'C');
    expect(got.get('a')).toBe('A');
    got.save('d', 'D');
    expect(got.get('a')).toBe('A');
    expect(got.get('b')).toBe('');
  });

  it('bounds memory with LRU eviction (oldest untouched view goes first)', () => {
    const m = new ChatDraftMemory(2);
    m.save('a', 'A');
    m.save('b', 'B');
    m.get('a'); // touch a → b becomes the LRU victim
    m.save('c', 'C');
    expect(m.get('a')).toBe('A');
    expect(m.get('c')).toBe('C');
    expect(m.get('b')).toBe('');
  });

  it('re-saving an existing key refreshes its text without growing the store', () => {
    const m = new ChatDraftMemory();
    m.save('k', 'first');
    m.save('k', 'second');
    expect(m.get('k')).toBe('second');
    expect(m.size()).toBe(1);
  });
});
