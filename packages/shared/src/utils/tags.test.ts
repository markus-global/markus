import { describe, it, expect } from 'vitest';
import { toStringArray, checkTagsInput } from './tags.js';

describe('checkTagsInput — 入口校验：拒绝错形状，并告诉调用方怎么改', () => {
  it('accepts an array of strings (the contract) and trims it', () => {
    expect(checkTagsInput([' a ', 'b'])).toEqual({ ok: true, tags: ['a', 'b'] });
    expect(checkTagsInput(undefined)).toEqual({ ok: true, tags: undefined });
    expect(checkTagsInput(null)).toEqual({ ok: true, tags: undefined });
  });

  it('rejects a comma string with the exact fix in the message', () => {
    const result = checkTagsInput('内容运营,工作流');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // 调用方（agent）必须能从这句话直接改对：说清期望形状、它发的是什么、没写任何东西
    expect(result.error).toContain('expected an array of strings');
    expect(result.error).toContain('"内容运营,工作流"');
    expect(result.error).toContain('Nothing was written');
    expect(result.error).toContain('["tag-a","tag-b"]');
  });

  it('rejects non-string items and objects', () => {
    expect(checkTagsInput(['a', 42]).ok).toBe(false);
    expect(checkTagsInput({ item: ['a'] }).ok).toBe(false);
    expect(checkTagsInput(42).ok).toBe(false);
  });
});

describe('toStringArray — 一个不变量，三种历史编码', () => {
  it('keeps the contract encoding untouched', () => {
    expect(toStringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(toStringArray([' a ', '', 'b'])).toEqual(['a', 'b']);
  });

  it('recovers a comma string that was stringified once more', () => {
    // 线上真实行：requirements.tags = '"内容运营,工作流,Easel"'
    expect(toStringArray('"内容运营,工作流,Easel"')).toEqual(['内容运营', '工作流', 'Easel']);
    // 完全没编码的纯文本也按同样的语义读
    expect(toStringArray('a, b')).toEqual(['a', 'b']);
  });

  it('recovers a list wrapped in a JSON object', () => {
    // 线上真实行：requirements.tags = '{"item":["Q3","Skills生态"]}'
    expect(toStringArray('{"item":["Q3","Skills生态"]}')).toEqual(['Q3', 'Skills生态']);
    expect(toStringArray({ item: ['x', 'y'] })).toEqual(['x', 'y']);
  });

  it('returns an empty list for values that carry no tag list', () => {
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
    expect(toStringArray('')).toEqual([]);
    expect(toStringArray('[]')).toEqual([]);
    expect(toStringArray(42)).toEqual([]);
    expect(toStringArray({ a: 1, b: 2 })).toEqual([]);
  });

  it('never returns a non-array, whatever the payload is', () => {
    // 这是这条不变量唯一被允许的表达方式：任何输入 → string[]。
    const inputs: unknown[] = [
      '["a"]', '"a"', 'a', '{"item":["a"]}', ['a'], 0, false, {}, [[]], [{ x: 1 }],
    ];
    for (const input of inputs) {
      expect(Array.isArray(toStringArray(input))).toBe(true);
    }
  });
});
