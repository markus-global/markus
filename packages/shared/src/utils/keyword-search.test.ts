import { describe, it, expect } from 'vitest';
import { tokenizeSearchQuery, scoreKeywordQuery } from './keyword-search.js';

describe('keyword-search utils', () => {
  it('tokenizes multi-word queries including hyphen/underscore', () => {
    expect(tokenizeSearchQuery('seed entropy BIP-39 entropy_check')).toEqual([
      'seed',
      'entropy',
      'bip-39',
      'entropy_check',
    ]);
  });

  it('scores OR-match across non-contiguous keywords', () => {
    const hay = 'Validate BIP-39 mnemonics; weak entropy fails entropy_check.';
    expect(scoreKeywordQuery(hay, 'seed entropy BIP-39 weak')).toBeGreaterThan(0);
    expect(scoreKeywordQuery(hay, 'cooking pasta recipe')).toBe(0);
  });
});
