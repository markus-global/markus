/**
 * Shared keyword search helpers for agent-facing search tools.
 * Multi-word queries match by token (OR), not as one contiguous substring.
 */

/** Split a search query into keyword tokens (letters/digits/CJK; keep -/_). */
export function tokenizeSearchQuery(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}_+-]+/u)) {
    const t = raw.trim();
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens;
}

/** Score haystack against tokens; 0 = no match. Full-phrase match gets a bonus. */
export function scoreKeywordHaystack(
  haystack: string,
  tokens: string[],
  fullQueryLower?: string,
): number {
  if (tokens.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score += 1;
  }
  const full = (fullQueryLower ?? '').trim().toLowerCase();
  if (full.length >= 2 && hay.includes(full)) {
    score += tokens.length;
  }
  return score;
}

/** Convenience: tokenize + score in one call. */
export function scoreKeywordQuery(haystack: string, query: string): number {
  const tokens = tokenizeSearchQuery(query);
  return scoreKeywordHaystack(haystack, tokens, query.trim().toLowerCase());
}
