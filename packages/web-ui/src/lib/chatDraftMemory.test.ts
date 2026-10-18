import { describe, expect, it } from 'vitest';
import { ChatDraftMemory, EMPTY_CHAT_DRAFT, type ChatDraft } from './chatDraftMemory.ts';

/** 构建一份完整草稿：默认全空，只写关心的字段。`save` 要求完整记录（不是 Partial）——
 *  正因为「少传一个字段」必须是被编译器拦住的事，这里也只给测试写一个薄壳。 */
const draft = (patch: Partial<ChatDraft> = {}): ChatDraft => ({
  text: '',
  images: [],
  context: [],
  replyTo: null,
  ...patch,
});

const text = (t: string) => draft({ text: t });
const img = (id: string) => ({ id, dataUrl: `data:image/png;base64,${id}`, name: `${id}.png` });
const ctx = (id: string) => ({ id, label: `#${id}`, content: `引用内容 ${id}` });

describe('ChatDraftMemory', () => {
  it('keeps a separate draft per view key', () => {
    const m = new ChatDraftMemory();
    m.save('agentA::s1', draft({ text: '写给 A 的草稿' }));
    m.save('agentB::s2', draft({ text: '写给 B 的草稿' }));
    expect(m.get('agentA::s1').text).toBe('写给 A 的草稿');
    expect(m.get('agentB::s2').text).toBe('写给 B 的草稿');
  });

  it('returns an empty draft for a view with no draft (never undefined)', () => {
    const m = new ChatDraftMemory();
    expect(m.get('never-seen')).toEqual(EMPTY_CHAT_DRAFT);
    expect(m.get('never-seen').text).toBe('');
    expect(m.get('').images).toEqual([]);
  });

  it('treats an entirely empty draft as "no draft" — sending clears the slot', () => {
    const m = new ChatDraftMemory();
    m.save('k', text('hello'));
    m.save('k', draft());
    expect(m.get('k').text).toBe('');
    expect(m.size()).toBe(0);
  });

  // ── 回归：草稿不是字符串（2026-10-18 老板报的 bug）────────────────────────
  // 旧实现只存 text，于是「在 A 视图贴的图 / 引用的片段」会跟着切到 B 视图。
  // 这两条断言在旧实现上必红：`save(key, {images})` 当时连签名都不存在。
  it('scopes pending images to the view — A 里的图不会跟到 B', () => {
    const m = new ChatDraftMemory();
    m.save('viewA', draft({ text: '看图', images: [img('a1')] }));
    m.save('viewB', draft({ text: '另一个' }));

    expect(m.get('viewA').images.map(i => i.id)).toEqual(['a1']);
    expect(m.get('viewB').images).toEqual([]);
  });

  it('keeps images alone (no text) alive as a draft', () => {
    // 只贴了图、还没打字 → 这仍然是一份草稿，不能当空槽删掉。
    const m = new ChatDraftMemory();
    m.save('viewA', draft({ images: [img('a1'), img('a2')] }));
    expect(m.size()).toBe(1);
    expect(m.get('viewA').images).toHaveLength(2);
  });

  it('scopes context chips and the reply target to the view', () => {
    const m = new ChatDraftMemory();
    m.save('viewA', draft({ text: 'reply', context: [ctx('spec')], replyTo: { id: 'm1', sender: 'Bob', text: '原文' } }));
    m.save('viewB', text('plain'));

    const a = m.get('viewA');
    expect(a.context.map(c => c.id)).toEqual(['spec']);
    expect(a.replyTo?.id).toBe('m1');

    const b = m.get('viewB');
    expect(b.context).toEqual([]);
    expect(b.replyTo).toBeNull();
  });

  it('replaces the whole record (no implicit merge) — the compiler is the guard against a forgotten field', () => {
    // 旧实现是「字符串」，所以不存在这个问题；改成结构化后，如果 save 做隐式合并，
    // 调用方漏传 images 就会**留着上一份的图**，bug 反而更难发现。这里钉住 replace 语义。
    const m = new ChatDraftMemory();
    m.save('k', draft({ text: 't', images: [img('a1')], context: [ctx('c1')] }));
    m.save('k', text('t2'));
    expect(m.get('k').text).toBe('t2');
    expect(m.get('k').images).toEqual([]);
    expect(m.get('k').context).toEqual([]);
  });

  it('ignores an empty key so a view-less write cannot pollute the store', () => {
    const m = new ChatDraftMemory();
    m.save('', draft({ text: 'stray', images: [img('x')] }));
    expect(m.size()).toBe(0);
    expect(m.get('').text).toBe('');
  });

  it('peek() reads without touching LRU order (get() does promote)', () => {
    // 判据必须能区分两种实现：cap=3 存 a,b,c 后再存 d，淘汰的是 LRU。
    //   若 peek 提升 LRU：顺序变 b,c,a → 淘汰 b → peek('a')='A'、peek('b')=''
    //   若 peek 不提升  ：顺序仍 a,b,c → 淘汰 a → peek('a')=''、peek('b')='B'
    const peeked = new ChatDraftMemory(3);
    peeked.save('a', text('A'));
    peeked.save('b', text('B'));
    peeked.save('c', text('C'));
    expect(peeked.peek('a').text).toBe('A');
    peeked.save('d', text('D'));
    expect(peeked.peek('a').text).toBe('');
    expect(peeked.peek('b').text).toBe('B');

    // 对照：get() 会提升，所以被提升的那个能活下来。
    const got = new ChatDraftMemory(3);
    got.save('a', text('A'));
    got.save('b', text('B'));
    got.save('c', text('C'));
    expect(got.get('a').text).toBe('A');
    got.save('d', text('D'));
    expect(got.get('a').text).toBe('A');
    expect(got.get('b').text).toBe('');
  });

  it('bounds memory with LRU eviction (oldest untouched view goes first)', () => {
    const m = new ChatDraftMemory(2);
    m.save('a', text('A'));
    m.save('b', text('B'));
    m.get('a'); // touch a → b becomes the LRU victim
    m.save('c', text('C'));
    expect(m.get('a').text).toBe('A');
    expect(m.get('c').text).toBe('C');
    expect(m.get('b').text).toBe('');
  });

  it('re-saving an existing key refreshes its draft without growing the store', () => {
    const m = new ChatDraftMemory();
    m.save('k', text('first'));
    m.save('k', text('second'));
    expect(m.get('k').text).toBe('second');
    expect(m.size()).toBe(1);
  });
});
