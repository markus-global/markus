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
import { MEMORY_MD_CURATED_MAX_CHARS, KNOWLEDGE_SECTION_KEY_MAX_CHARS } from '@markus/shared';

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

describe('knowledge.md — curated budget: REPORT, never silently rewrite (H19)', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function knowledgeFile(): string {
    return path.join(dir, 'knowledge.md');
  }

  it('an over-budget curated file is REPORTED, not rewritten — every body survives intact', () => {
    // Simulate a legacy/oversized store. The OLD code silently archived the largest
    // section bodies and left pointer stubs; H19 removed that path entirely.
    const store = new MemoryStore(dir);
    const sections: string[] = [];
    for (let i = 0; i < 12; i++) sections.push(`## section-${i}\n${'A'.repeat(2_000)}`);
    fs.writeFileSync(knowledgeFile(), sections.join('\n\n'));

    const before = fs.readFileSync(knowledgeFile(), 'utf-8');
    expect(before.length).toBeGreaterThan(MEMORY_MD_CURATED_MAX_CHARS);

    store.enforceMemoryBudgets();

    const after = fs.readFileSync(knowledgeFile(), 'utf-8');
    expect(after).toBe(before);                // byte-for-byte: no silent rewrite
    expect(after).not.toContain('_[archived'); // no pointer stubs
    for (let i = 0; i < 12; i++) expect(after).toContain(`## section-${i}`);
  });

  it('never touches ## _observations (it has its own cap and its own curation path)', () => {
    const store = new MemoryStore(dir);
    const obs = Array.from({ length: 20 }, (_, i) =>
      `### obs_2026091${i % 10}_${i}\n<!-- timestamp: 2026-09-1${i % 10}T00:00:00Z -->\nobservation number ${i} `.repeat(20)).join('\n');
    fs.writeFileSync(
      knowledgeFile(),
      `## big-section\n${'C'.repeat(20_000)}\n\n## _observations\n${obs}`,
    );

    store.enforceMemoryBudgets();
    const content = fs.readFileSync(knowledgeFile(), 'utf-8');

    expect(content).toContain('## _observations');
    expect(content).toContain('observation number 19'); // newest observation survives
    expect(content).toContain('## big-section');        // curated heading survives too
  });

  it('is a no-op on a file already within budget', () => {
    const store = new MemoryStore(dir);
    fs.writeFileSync(knowledgeFile(), '## small\nshort body');
    const before = fs.readFileSync(knowledgeFile(), 'utf-8');
    store.enforceMemoryBudgets();
    expect(fs.readFileSync(knowledgeFile(), 'utf-8')).toBe(before);
  });
});
