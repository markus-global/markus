import { describe, it, expect } from 'vitest';
import { toStringArray } from './tags.js';

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
