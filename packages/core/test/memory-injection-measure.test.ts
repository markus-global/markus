import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { prepareKnowledgeForPrompt } from '../src/context-engine.js';

/**
 * DR5 — the banner must report THIS TURN'S INJECTED PAYLOAD, not the curated
 * region on disk divided by a disk constant.
 *
 * The bug these tests pin: a 16 673-char curated region announced as "111%
 * injected" on a turn that actually carried 6 691 chars. Two different questions
 * were being answered by one number.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dr5-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const knowledgeFile = () => join(dir, 'knowledge.md');

describe('DR5 — prepareKnowledgeForPrompt reports the payload it actually built', () => {
  it('counts only inlined knowledge, never the index line it appends', () => {
    // 20 sections, cap far below the total: some are inlined, the rest are named
    // in the index line. The index line is scaffolding (it names what is ABSENT),
    // so counting it as injected knowledge inflates the number it reports.
    const raw = Array.from({ length: 20 }, (_, i) => `## s${i}\n` + 'x'.repeat(490)).join('\n\n');
    const p = prepareKnowledgeForPrompt(raw, 2_000);

    expect(p.omittedCount).toBeGreaterThan(0);
    // The payload never exceeds the ceiling it was truncated to.
    expect(p.inlinedChars).toBeLessThanOrEqual(2_000);
    // The returned text is strictly longer than the payload, because it carries
    // the index line — if these were equal the index line would be counted as
    // knowledge, which is exactly the measurement error DR5 removes.
    expect(p.text.length).toBeGreaterThan(p.inlinedChars);
  });

  it('is empty-safe: no knowledge means zero payload and no omission', () => {
    const p = prepareKnowledgeForPrompt('   \n  ', 6_000);
    expect(p.inlinedChars).toBe(0);
    expect(p.omittedCount).toBe(0);
    expect(p.text).toBe('');
  });
});

describe('DR5 — MemoryHealth measures an injection, not a file region', () => {
  it('reports the recorded payload, with the injection ceiling as denominator', () => {
    writeFileSync(knowledgeFile(), '# Knowledge\n\n## a\n' + 'y'.repeat(3_000), 'utf8');
    const store = new MemoryStore(dir);

    store.recordInjectedKnowledge(5_000, 3, 6_000);
    const h = store.getMemoryHealth();

    expect(h.injectedChars).toBe(5_000);
    expect(h.injectionCapChars).toBe(6_000);
    expect(h.injectionUsedPercent).toBe(83); // 5000/6000 — NOT region/15000
    expect(h.omittedSectionCount).toBe(3);
    expect(h.injectionMeasured).toBe(true);
    // `percent` is the memory-health number, so it must be the injection figure.
    expect(h.percent).toBe(h.injectionUsedPercent);
  });

  it('the recorded ceiling wins over the default, so converse cannot report against the execute cap', () => {
    writeFileSync(knowledgeFile(), '# Knowledge\n\n## a\ntiny\n', 'utf8');
    const store = new MemoryStore(dir);

    store.recordInjectedKnowledge(4_800, 0, 4_800); // the converse ceiling
    const h = store.getMemoryHealth();

    expect(h.injectionCapChars).toBe(4_800);
    expect(h.injectionUsedPercent).toBe(100);
  });

  it('without a recorded turn it projects through the injector and says so', () => {
    // 3 legal sections (each under MEMORY_MD_SECTION_MAX_CHARS), region below its
    // soft budget but above one turn's injection ceiling.
    const body = Array.from({ length: 3 }, (_, i) => `## s${i}\n` + 'x'.repeat(2_500)).join('\n\n');
    writeFileSync(knowledgeFile(), '# Knowledge\n\n' + body, 'utf8');
    const store = new MemoryStore(dir);

    const h = store.getMemoryHealth();
    expect(h.injectionMeasured).toBe(false);
    // The projection runs the injector's own selection — never a region ratio.
    expect(h.injectedChars).toBeGreaterThan(0);
    expect(h.injectedChars).toBeLessThanOrEqual(h.injectionCapChars);
    // Two numbers, two denominators. They must not collapse into one.
    expect(h.injectionCapChars).toBeLessThan(h.curatedCap);
    expect(h.injectionUsedPercent).not.toBe(h.curatedPercent);
  });
});
