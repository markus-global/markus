import { describe, it, expect } from 'vitest';
import {
  transformOutsideCode,
  normalizeMathDelimiters,
  protectCurrencyDollarSigns,
} from '../src/components/markdown-utils.ts';

// ─── protectCurrencyDollarSigns ─────────────────────────────────────────────
//
// Regression tests for the currency/price dollar-sign bug: remark-math treats
// `$...$` as inline math, so text like `$90系统性阈值（$90.50）` or
// `（$4,307.7 vs $4,454）` had the text between two dollars swallowed into a
// KaTeX formula (math font + nowrap → broken wrapping / overflow on narrow
// screens, and the "(1)…(4)" line breaks collapsed).

describe('protectCurrencyDollarSigns', () => {
  it('escapes a dollar sign followed by a digit', () => {
    expect(protectCurrencyDollarSigns('WTI突破$90系统性阈值（$90.50）'))
      .toBe('WTI突破\\$90系统性阈值（\\$90.50）');
  });

  it('escapes comma-formatted prices', () => {
    expect(protectCurrencyDollarSigns('金价（$4,307.7 vs 8/31 $4,454，-3.3%）'))
      .toBe('金价（\\$4,307.7 vs 8/31 \\$4,454，-3.3%）');
  });

  it('escapes compact units like $5M', () => {
    expect(protectCurrencyDollarSigns('收入 $5M 和 $10M')).toBe('收入 \\$5M 和 \\$10M');
  });

  it('leaves an already-escaped dollar untouched', () => {
    expect(protectCurrencyDollarSigns('已转义 \\$90 原样')).toBe('已转义 \\$90 原样');
  });

  it('leaves letter-led math delimiters alone', () => {
    expect(protectCurrencyDollarSigns('公式 $x^2$ 与 $C_L$')).toBe('公式 $x^2$ 与 $C_L$');
  });

  it('does not touch block math or a lone dollar', () => {
    expect(protectCurrencyDollarSigns('$$a+b$$ 且 行尾 $')).toBe('$$a+b$$ 且 行尾 $');
  });

  it('skips dollars inside code spans (via transformOutsideCode)', () => {
    const result = transformOutsideCode('代码 `$90` 与 $100', protectCurrencyDollarSigns);
    expect(result).toBe('代码 `$90` 与 \\$100');
  });

  it('composes with normalizeMathDelimiters: prices stay literal, math still works', () => {
    const result = normalizeMathDelimiters(protectCurrencyDollarSigns('价 $90，公式 \\(90 \\times 2\\)'));
    expect(result).toBe('价 \\$90，公式 $90 \\times 2$');
  });
});
