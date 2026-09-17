/**
 * Knowledge lifecycle invariants (docs/MEMORY-SYSTEM.md §1.1, §3).
 *
 * Locks down three real regressions:
 *   - section keys were free text, so scratch notes became "knowledge headings"
 *     (`## ✅ 修复完成：摘要锚点进固定段（3a745f00）`).
 *   - the total-size budget was only checked ON WRITE and enforcement meant
 *     REFUSAL, so an already-oversized knowledge.md could never shrink
 *     (measured 23 323 chars against a 15 000 limit).
 *   - the stale-section heuristic hard-coded ONE incident's vocabulary, so the
 *     same class of junk with different wording ranked as first-class knowledge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore, normalizeSectionKey } from '../src/memory/store.js';
import { MEMORY_MD_TOTAL_MAX_CHARS, KNOWLEDGE_SECTION_KEY_MAX_CHARS } from '@markus/shared';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-lifecycle-'));
}

describe('knowledge.md — section key hygiene (K-2)', () => {
  it('accepts short human/CJK headings', () => {
    expect(normalizeSectionKey('procedures')).toBe('procedures');
    expect(normalizeSectionKey('定价与计费方案设计原则')).toBe('定价与计费方案设计原则');
    expect(normalizeSectionKey('  team-routing  ')).toBe('team-routing');
  });

  it('collapses line breaks instead of splitting the section in two', () => {
    expect(normalizeSectionKey('foo\nbar')).toBe('foo bar');
  });

  it('rejects structurally unusable keys', () => {
    expect(normalizeSectionKey('')).toBeNull();
    expect(normalizeSectionKey('   ')).toBeNull();
    expect(normalizeSectionKey('a ## b')).toBeNull();          // would split on parse
    expect(normalizeSectionKey('x'.repeat(KNOWLEDGE_SECTION_KEY_MAX_CHARS + 1))).toBeNull();
  });

  it('refuses the write and explains why, instead of writing a junk heading', () => {
    const dir = makeTempDir();
    try {
      const store = new MemoryStore(dir);
      const bad = store.addLongTermMemory('x'.repeat(500), 'body');
      expect(bad.ok).toBe(false);
      expect(bad.reason).toContain('section key');

      const good = store.addLongTermMemory('procedures', 'body');
      expect(good.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('knowledge.md — total-size convergence (K-1)', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function knowledgeFile(): string {
    return path.join(dir, 'knowledge.md');
  }

  it('shrinks an oversized file to the budget instead of refusing forever', () => {
    const store = new MemoryStore(dir);
    // Build an over-budget file directly (simulating a legacy/oversized store —
    // the point is that compress can RECOVER from it, which the old code could not).
    const sections: string[] = [];
    for (let i = 0; i < 12; i++) {
      sections.push(`## section-${i}\n${'A'.repeat(2_000)}`);
    }
    fs.writeFileSync(knowledgeFile(), sections.join('\n\n'));
    const before = fs.readFileSync(knowledgeFile(), 'utf-8').length;
    expect(before).toBeGreaterThan(MEMORY_MD_TOTAL_MAX_CHARS);

    const result = store.compressLongTermMemory();
    const after = fs.readFileSync(knowledgeFile(), 'utf-8').length;

    expect(result.charsBefore).toBe(before);
    expect(after).toBeLessThanOrEqual(MEMORY_MD_TOTAL_MAX_CHARS);
    expect(result.charsAfter).toBe(after);
    expect(result.truncatedChunks).toBeGreaterThan(0);
  });

  it('preserves every section HEADING while shrinking bodies (topic stays discoverable)', () => {
    const store = new MemoryStore(dir);
    const sections: string[] = [];
    for (let i = 0; i < 10; i++) sections.push(`## keep-heading-${i}\n${'B'.repeat(2_500)}`);
    fs.writeFileSync(knowledgeFile(), sections.join('\n\n'));

    store.compressLongTermMemory();
    const content = fs.readFileSync(knowledgeFile(), 'utf-8');

    for (let i = 0; i < 10; i++) expect(content).toContain(`## keep-heading-${i}`);
  });

  it('never touches ## _observations (it has its own cap and its own curation path)', () => {
    const store = new MemoryStore(dir);
    const obs = Array.from({ length: 20 }, (_, i) =>
      `### obs_2026091${i % 10}_${i}\n<!-- timestamp: 2026-09-1${i % 10}T00:00:00Z -->\nobservation number ${i} `.repeat(20)).join('\n');
    fs.writeFileSync(
      knowledgeFile(),
      `## big-section\n${'C'.repeat(20_000)}\n\n## _observations\n${obs}`,
    );

    store.compressLongTermMemory();
    const content = fs.readFileSync(knowledgeFile(), 'utf-8');

    expect(content).toContain('## _observations');
    expect(content).toContain('observation number 19');
    expect(content).toContain('## big-section'); // heading survives
  });

  it('is a no-op on a file already within budget', () => {
    const store = new MemoryStore(dir);
    fs.writeFileSync(knowledgeFile(), '## small\nshort body');
    const before = fs.readFileSync(knowledgeFile(), 'utf-8');
    const result = store.compressLongTermMemory();
    expect(fs.readFileSync(knowledgeFile(), 'utf-8')).toBe(before);
    expect(result.truncatedChunks).toBe(0);
  });
});
