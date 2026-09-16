/**
 * ContextOS — `prepareKnowledgeForPrompt`: relevance-ranked, whole-section
 * knowledge selection with a never-silent omission index.
 *
 * Regression guard for the 2026-09-13 change to `prepareKnowledgeForPrompt`:
 *   1. Sections are ranked by query relevance (stale last → score → doc order).
 *   2. Selection is WHOLE sections only — never cut mid-section.
 *   3. Omitted sections are always named in a trailing `_knowledge index …_` line,
 *      so nothing is silently dropped.
 *   4. Without a `query` the previous document-order behaviour is preserved.
 */

import { describe, it, expect } from 'vitest';
import { prepareKnowledgeForPrompt } from '../src/context-engine.js';

const S1 = '## Section One\nintro one\nCONTENT_ONE_TAIL_MARKER';
const S2 = '## Section Two\nintro two\nCONTENT_TWO_TAIL_MARKER';
const S3 = '## Third Topic\nintro three with the keyword ZEBRA\nCONTENT_THREE_TAIL_MARKER';
const RAW = [S1, S2, S3].join('\n');

// S3 is 75 chars; S1/S2 are 49 each. A cap of 80 fits S3 (or S1) alone and
// leaves no room for a second section.
const ONE_SECTION_CAP = 80;

describe('prepareKnowledgeForPrompt — relevance-ranked whole-section selection', () => {
  it('picks the query-relevant section and names EVERY omitted section in the index line', () => {
    const { text, truncated } = prepareKnowledgeForPrompt(RAW, ONE_SECTION_CAP, 'tell me about zebra');

    expect(text).toContain('CONTENT_THREE_TAIL_MARKER');
    expect(text).not.toContain('CONTENT_ONE_TAIL_MARKER');
    expect(text).not.toContain('CONTENT_TWO_TAIL_MARKER');
    expect(truncated).toBe(true);
    // Both omitted sections are named — never silently discarded.
    expect(text).toContain('knowledge index');
    expect(text).toContain('Section One');
    expect(text).toContain('Section Two');
  });

  it('includes the WHOLE selected section (no mid-section truncation)', () => {
    const { text } = prepareKnowledgeForPrompt(RAW, ONE_SECTION_CAP, 'zebra');

    expect(text).toContain('intro three with the keyword ZEBRA');
    // The section's final line survived → it was inlined in full, not sliced.
    expect(text).toContain('CONTENT_THREE_TAIL_MARKER');
  });

  it('inlines everything and emits no index line when the cap is large enough', () => {
    const { text, truncated } = prepareKnowledgeForPrompt(RAW, RAW.length + 50, 'zebra');

    expect(truncated).toBe(false);
    expect(text).not.toContain('knowledge index');
    expect(text).toContain('CONTENT_ONE_TAIL_MARKER');
    expect(text).toContain('CONTENT_TWO_TAIL_MARKER');
    expect(text).toContain('CONTENT_THREE_TAIL_MARKER');
  });

  it('falls back to document order when no query is supplied (backwards compatible)', () => {
    const { text, truncated } = prepareKnowledgeForPrompt(RAW, ONE_SECTION_CAP);

    // Document order wins: section one is inlined…
    expect(text).toContain('CONTENT_ONE_TAIL_MARKER');
    expect(text).not.toContain('CONTENT_THREE_TAIL_MARKER');
    expect(truncated).toBe(true);
    // …and the omitted later sections are still named.
    expect(text).toContain('Section Two');
    expect(text).toContain('Third Topic');
  });
});
