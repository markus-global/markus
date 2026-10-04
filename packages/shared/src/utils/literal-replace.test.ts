/**
 * Regression: `replaceAllLiteral` must insert the replacement VERBATIM for
 * every occurrence — it must never interpret `$`-sequences.
 *
 * `String.prototype.replaceAll(search, replacement)` reuses the same
 * replacement-string grammar as `.replace`, so a replacement containing `$&`,
 * `` $` ``, `$'` or `$$` gets expanded instead of inserted:
 *
 *   - `$&` → the matched text
 *   - `` $` `` → everything BEFORE the match (duplicates the prefix)
 *   - `$'` → everything AFTER  the match (duplicates the suffix)
 *   - `$$` → a single dollar sign
 *
 * That silently duplicated/expanded surrounding text. This is exactly the class
 * of bug that destroyed documents via file_edit / apply_patch (see
 * packages/core/test/file-edit-replace-template.test.ts) and that corrupted
 * rendered workflow prompts (see the `renderStepPrompt` tests in
 * packages/shared/test/workflow-template.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { replaceLiteral, replaceAllLiteral } from './literal-replace.js';

/**
 * The `$`-sequences String.prototype.replaceAll expands with a string search.
 * (`$1` has no capture group to resolve against a plain-string search, so it
 * happens to pass through today; it is asserted to pin that documented
 * behaviour, not as a discriminator.)
 */
const DOLLAR_MATCHED = '$&';
const DOLLAR_PREFIX = '$`';
const DOLLAR_SUFFIX = "$'";
const DOLLAR_GROUP = '$1';
const DOLLAR_ESCAPE = '$$';
const ALL_DOLLAR_PATTERNS = [
  DOLLAR_MATCHED,
  DOLLAR_PREFIX,
  DOLLAR_SUFFIX,
  DOLLAR_GROUP,
  DOLLAR_ESCAPE,
];

describe('replaceAllLiteral', () => {
  it('replaces every occurrence', () => {
    expect(replaceAllLiteral('a a a', 'a', 'b')).toBe('b b b');
  });

  it('inserts every $-pattern verbatim, for every occurrence', () => {
    for (const pattern of ALL_DOLLAR_PATTERNS) {
      const replacement = `X${pattern}Y`;
      expect(replaceAllLiteral('S S', 'S', replacement)).toBe(`${replacement} ${replacement}`);
    }
  });

  it('never duplicates the prefix or the suffix (the $` / $\' corruption)', () => {
    expect(replaceAllLiteral('HEAD S TAIL', 'S', DOLLAR_PREFIX)).toBe('HEAD $` TAIL');
    expect(replaceAllLiteral('HEAD S TAIL', 'S', DOLLAR_SUFFIX)).toBe("HEAD $' TAIL");
  });

  it('keeps `$&` literal instead of re-inserting the matched text', () => {
    expect(replaceAllLiteral('S', 'S', DOLLAR_MATCHED)).toBe('$&');
    // String-form replaceAll would give 'SS' here.
    expect(replaceAllLiteral('S', 'S', '$&')).not.toBe('SS');
  });

  it('treats the search string literally, not as a pattern', () => {
    expect(replaceAllLiteral('a.b a.b', 'a.b', 'ok')).toBe('ok ok');
  });

  it('returns the original string unchanged for an empty search (no infinite expansion)', () => {
    expect(replaceAllLiteral('abc', '', 'X')).toBe('abc');
    // A split('')/join implementation would otherwise yield 'XaXbXcX'.
    expect(replaceAllLiteral('abc', '', 'X')).not.toBe('XaXbXcX');
  });

  it('is a superset of replaceLiteral on a single occurrence', () => {
    for (const pattern of ALL_DOLLAR_PATTERNS) {
      const replacement = `V${pattern}`;
      expect(replaceAllLiteral('S', 'S', replacement)).toBe(replaceLiteral('S', 'S', replacement));
    }
  });
});

describe('replaceLiteral (still single-occurrence, still literal)', () => {
  it('replaces only the first occurrence', () => {
    expect(replaceLiteral('a a a', 'a', 'b')).toBe('b a a');
  });

  it('inserts every $-pattern verbatim', () => {
    for (const pattern of ALL_DOLLAR_PATTERNS) {
      const replacement = `X${pattern}Y`;
      expect(replaceLiteral('S', 'S', replacement)).toBe(replacement);
    }
  });
});
